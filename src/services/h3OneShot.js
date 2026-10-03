/**
 * H3 ONE-SHOT ("One-Shot H3") engine — 0.4.9
 *
 * Standalone video workflow, deliberately UNRELATED to the music-video path:
 * no keyframes, no ACE-Step, no shot-list parser, no per-shot variants.
 * Inputs: audio file + Belrog director script -> H3 auto-chain -> stitched MP4.
 *
 * Pipeline shape (mirrors Ltamann/ComfyUI-H3-Motion-Context-Auto-Chain-addon):
 *   LoadAudio -> MiniMaxH3AutoChainAudio (chunks + chain_config + auto-requeue)
 *   MiniMaxH3AutoChainLoadLatent  -> MiniMaxH3AutoChainMotionContext -> AddGuide
 *   MiniMaxH3AutoChainFrameReference (last_frame) -> ReferenceToVideo ref_images
 *   sampler -> AutoChainSaveLatent | VAEDecode(+Trim) -> CreateVideo -> AutoChain+Stitch
 *
 * THIS MODULE IS PURE (no DOM, no electron) so it is directly testable with
 * `node --test`. The chain engine nodes themselves come from the addon installed
 * into ComfyUI custom_nodes — Belrog only BUILDS and QUEUES the graph.
 */

import { parseStructuredDirectorScript } from '../utils/yoloPlanning.js'
import { parseAssetLegendLines } from '../utils/yoloPlanning.js'

export const H3_ONESHOT_WORKFLOW_ID = 'h3-oneshot'
export const H3_CHAIN_ADDON_REPO =
  'https://github.com/Ltamann/ComfyUI-H3-Motion-Context-Auto-Chain-addon'

// H3 latent grid: each model call must be 17g+8 pixel frames @ 24 fps (ceil((req+5)/17) blocks — README example: 20s chains at 512f).
export const H3_FRAME_BLOCK = 17
export const H3_LENGTH_OFFSET = 5
export const H3_FPS = 24
export const H3_CONTEXT_TRIM_FRAMES = 22
export const H3_DEFAULT_CHUNK_SECONDS = 20
// ref2va is the audio-lip-sync engine (ReferenceToVideo path). fl2va is the
// frame/keyframe path without audio conditioning — fallback, NOT lip-sync.
export const H3_MODEL_REF2VA = 'minimax_h3_ref2va_pruned_int8_convrot.safetensors'
export const H3_MODEL_FL2VA = 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'
export const H3_VIDEO_VAE = 'minimax_h3_video_vae_fp16.safetensors'
export const H3_AUDIO_VAE = 'minimax_h3_audio_vae_fp32.safetensors'
export const H3_TEXT_ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'

/** Snap seconds to the next-longest legal H3 clip length (17g+8 frames @ fps). */
export function h3ClipFrames(seconds, fps = H3_FPS) {
  const requested = Math.max(1, Math.round(Number(seconds) * fps))
  const g = Math.max(1, Math.ceil((requested + H3_LENGTH_OFFSET) / H3_FRAME_BLOCK))
  return g * H3_FRAME_BLOCK + H3_LENGTH_OFFSET
}

export function h3ClipSeconds(seconds, fps = H3_FPS) {
  return h3ClipFrames(seconds, fps) / fps
}

/** Number of chain clips for a duration (clip 1 delivers chunk+5 frames). */
export function h3ClipCount(totalSeconds, chunkSeconds, fps = H3_FPS) {
  const total = Math.max(1, Math.ceil(totalSeconds * fps))
  const chunk = h3ClipFrames(chunkSeconds, fps)
  const first = chunk + H3_LENGTH_OFFSET
  if (total <= first) return 1
  return 1 + Math.ceil((total - first) / chunk)
}

/** Parse "0:20" / "20" / "1:05.5" into seconds (null when absent/unparseable). */
export function parseStartAtSeconds(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const m = /^(\d+):([0-5]?\d)(?:\.(\d+))?$/.exec(s)
  if (m) return Number(m[1]) * 60 + Number(m[2]) + Number('0.' + (m[3] || '0'))
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Compile a director script into chain prompts.
 * Accepts the parseStructuredDirectorScript scenes array (shots with
 * keyframePromptRaw/motionPromptRaw) OR raw script text.
 * stylePrompt is prepended to every clip by the chain node itself —
 * we emit it as a separate field and the `[N]` blocks as clipPrompts.
 */
export function compileScriptToClips(scriptInput, options = {}) {
  const scenes = Array.isArray(scriptInput)
    ? scriptInput
    : parseStructuredDirectorScript(String(scriptInput || ''), {
        // ONE-SHOT override: H3 clips run to the chain chunk size, so shot
        // Length is not clamped to the music path's 15s ceiling — the grid
        // snap in h3ClipFrames owns the final length.
        maxShotDurationSeconds: options.maxShotDurationSeconds ?? 600,
      })
  const shots = []
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    for (const shot of scene?.shots || []) shots.push(shot)
  }
  if (!shots.length) {
    return { clips: [], warnings: ['script produced no shots'] }
  }
  const warnings = []
  const clips = []
  let clipIndex = 0
  for (const shot of shots) {
    // Parser carries Start-at as raw text (startAtRaw); audioStart only exists
    // after the music planner runs, which this standalone path skips.
    const startSec = parseStartAtSeconds(shot.startAtRaw) ?? (Number.isFinite(shot.audioStart) ? shot.audioStart : null)
    const lenSec = Number(shot.durationSeconds) || 0
    if (startSec == null) warnings.push(`shot ${shot.index}: no Start at — sequencing by order`)
    if (lenSec < 3.5) warnings.push(`shot ${shot.index}: ${lenSec}s below 3.5s minimum`)
    const frames = h3ClipFrames(Math.max(lenSec, 3.5))
    clipIndex += 1
    const prompt = [
      shot.keyframePromptRaw || shot.imageBeat || '',
      shot.motionPromptRaw ? `Camera: ${shot.motionPromptRaw}` : '',
    ].filter(Boolean).join('\n')
    clips.push({
      clipIndex,
      shotIndex: shot.index,
      startSec,
      frames,
      seconds: frames / H3_FPS,
      prompt: prompt || `(shot ${shot.index} — no keyframe text)`,
    })
  }
  const clipPrompts = clips.map((c) => `[${c.clipIndex}] ${c.prompt}`).join('\n')
  return { clips, clipPrompts, warnings }
}

/**
 * Validate the chain is buildable on this machine before queuing anything.
 * `installedNodes` = set of class_type strings from GET /object_info.
 * `modelFiles` = list of filenames present under diffusion_models/vae/text_encoders.
 */
export function auditH3Environment({ installedNodes = [], modelFiles = [] } = {}) {
  const requiredNodes = [
    'MiniMaxH3AutoChainAudio',
    'MiniMaxH3AutoChainMotionContext',
    'MiniMaxH3AutoChainMotionContextTrim',
    'MiniMaxH3AutoChainSaveLatent',
    'MiniMaxH3AutoChainLoadLatent',
    'MiniMaxH3AutoChainFrameReference',
    'MiniMaxH3AutoChain',
    'MiniMaxH3SparseChainStitch',
    'MiniMaxH3ReferenceToVideo',
    'MiniMaxH3AddGuide',
  ]
  const requiredModels = [H3_MODEL_REF2VA, H3_VIDEO_VAE, H3_AUDIO_VAE, H3_TEXT_ENCODER]
  const missingNodes = requiredNodes.filter((n) => !installedNodes.includes(n))
  const missingModels = requiredModels.filter((m) => !modelFiles.includes(m))
  const lipSyncReady =
    !missingNodes.includes('MiniMaxH3ReferenceToVideo') &&
    !missingModels.includes(H3_MODEL_REF2VA)
  return {
    ok: missingNodes.length === 0 && missingModels.length === 0,
    lipSyncReady,
    missingNodes,
    missingModels,
  }
}

/**
 * Build the full API-format chain workflow. Pure function; every injected
 * value (paths, prompts, ids) is explicit so tests are deterministic.
 *
 * NOTE (verify at first live run — marked UNVERIFIED in plan §5):
 *  - exact input names on AutoChainFrameReference (initial_image) and
 *    AutoChain (audio_source) taken from the addon README;
 *  - CLIPLoader type slot value for qwen3vl H3.
 */
export function buildH3OneShotWorkflow({
  chainId,
  audioFile, // name in ComfyUI input dir (upload first)
  stylePrompt = '',
  clipPrompts,
  totalSeconds,
  chunkSeconds = H3_DEFAULT_CHUNK_SECONDS,
  width = 1280,
  height = 720,
  seed = 1,
  refImage = null, // cast face sheet name, or null for prompt-only
  lipSync = true,
  startClip = 1,
  endClip = 0,
  reset = true,
}) {
  const model = lipSync ? H3_MODEL_REF2VA : H3_MODEL_FL2VA
  const wf = {
    '1': { class_type: 'LoadAudio', inputs: { audio: audioFile }, _meta: { title: 'Song / audio' } },
    '2': { class_type: 'MiniMaxH3AutoChainAudio', inputs: {
      audio: ['1', 0],
      chain_id: chainId,
      chunk_seconds: chunkSeconds,
      fps: H3_FPS,
      trim_frames: H3_CONTEXT_TRIM_FRAMES,
      final_tail_mode: 'exact audio duration',
      final_tail_frames: 24,
      reset,
      style_prompt: stylePrompt,
      clip_prompts: clipPrompts,
      start_clip: startClip,
      end_clip: endClip,
    }, _meta: { title: 'H3 Auto Chain Audio' } },
    '3': { class_type: 'UNETLoader', inputs: { unet_name: model, weight_dtype: 'default' } },
    '4': { class_type: 'CLIPLoader', inputs: { clip_name: H3_TEXT_ENCODER, type: 'minimax', device: 'default' } },
    '5': { class_type: 'VAELoader', inputs: { vae_name: H3_VIDEO_VAE } },
    '6': { class_type: 'VAELoader', inputs: { vae_name: H3_AUDIO_VAE } },
    '7': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['3', 0], lora_name: 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors', strength_model: 1.0 } },
    '8': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {
      clip: ['4', 0], vae: ['5', 0], audio_vae: ['6', 0],
      prompt: ['2', 1], // current clip prompt (style+clip combined by chain node)
      width, height, length: 124, ref_image_size: 'match',
    }, _meta: { title: 'H3 Reference/Text → AV latent' } },
    '9': { class_type: 'MiniMaxH3AutoChainLoadLatent', inputs: { chain_config: ['2', 3] } },
    '10': { class_type: 'MiniMaxH3AutoChainMotionContext', inputs: {
      conditioning: ['8', 0], vae: ['5', 0], latent: ['8', 1],
      chain_config: ['2', 3], context_latent: ['9', 0], audio_vae: ['6', 0],
    }, _meta: { title: 'Motion Context (latent carry-forward)' } },
    '11': { class_type: 'MiniMaxH3AutoChainFrameReference', inputs: {
      chain_config: ['2', 3],
      ...(refImage ? { initial_image: ['12', 0] } : {}),
    }, _meta: { title: 'Frame Reference (last_frame)' } },
    ...(refImage ? { '12': { class_type: 'LoadImage', inputs: { image: refImage } } } : {}),
    '13': { class_type: 'CFGGuider', inputs: { model: ['7', 0], positive: ['10', 0], negative: ['8', 2], cfg: 1.0 } },
    '14': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '15': { class_type: 'BasicScheduler', inputs: { model: ['7', 0], scheduler: 'simple', steps: 8, denoise: 1.0 } },
    '16': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '17': { class_type: 'SamplerCustomAdvanced', inputs: {
      noise: ['16', 0], guider: ['13', 0], sampler: ['14', 0], sigmas: ['15', 0], latent_image: ['8', 1],
    } },
    '18': { class_type: 'MiniMaxH3AutoChainSaveLatent', inputs: { latent: ['17', 0], chain_config: ['2', 3] }, _meta: { title: 'Save clip latent (context for next clip)' } },
    '19': { class_type: 'VAEDecode', inputs: { samples: ['17', 0], vae: ['5', 0] } },
    '20': { class_type: 'VAEDecodeAudio', inputs: { samples: ['17', 0], vae: ['6', 0] } },
    '21': { class_type: 'MiniMaxH3AutoChainMotionContextTrim', inputs: {
      images: ['19', 0], trim_frames: ['10', 1], chain_config: ['2', 3], audio: ['20', 0],
    }, _meta: { title: 'Trim context head' } },
    '22': { class_type: 'CreateVideo', inputs: { images: ['21', 0], fps: H3_FPS } },
    '23': { class_type: 'MiniMaxH3AutoChain', inputs: {
      video: ['22', 0],
      chain_config: ['2', 3],
      audio_source: 'original audio input',
      audio: ['1', 0],
      delete_completed_latents: false,
    }, _meta: { title: 'Save clip + auto-requeue + stitch' } },
    '24': { class_type: 'SaveVideo', inputs: { video: ['23', 0], filename_prefix: `video/${chainId}_final`, format: 'auto' } },
  }
  if (!lipSync) delete wf['11'].inputs // fl2va path: no ref input wired  (v1 keeps lipSync=true default)
  return wf
}

/**
 * Project persistence shape + resume cursor. Stored under
 * project.generateWorkspace.h3OneShot; updated from onProgress.
 */
export function createH3OneShotState({ audioFileName, durationSeconds, scriptText, stylePrompt }) {
  return {
    version: 1,
    stage: 'idle', // idle | auditing | queued | running | done | failed
    chainId: `belrog_oneshot_${Date.now()}`,
    audioFileName: audioFileName || '',
    durationSeconds: Number(durationSeconds) || 0,
    scriptText: scriptText || '',
    stylePrompt: stylePrompt || '',
    clipsTotal: 0,
    clipsDone: 0,
    lastCompletedClip: 0, // resume cursor: restart from lastCompletedClip + 1
    startedAt: null,
    log: [], // [{ ts, clip, event, detail }]
  }
}

export function reduceH3OneShotProgress(state, event) {
  const next = { ...state, log: [...(state.log || [])] }
  next.log.push({ ts: event.ts || Date.now(), clip: event.clip ?? null, event: event.event, detail: event.detail || '' })
  if (next.log.length > 2000) next.log = next.log.slice(-2000)
  switch (event.event) {
    case 'audit_ok': next.stage = 'queued'; break
    case 'audit_fail': next.stage = 'failed'; break
    case 'queued': next.stage = 'running'; next.startedAt = event.ts || Date.now(); break
    case 'clip_done':
      next.clipsDone = Math.max(next.clipsDone || 0, event.clip || 0)
      next.lastCompletedClip = next.clipsDone
      break
    case 'clip_failed': next.stage = 'failed'; break
    case 'chain_done': next.stage = 'done'; next.clipsDone = next.clipsTotal; break
    case 'stitch_done': next.stage = 'done'; break
    default: break
  }
  return next
}

/**
 * Chain plan for the progress bar + watcher. clipFiles must match the addon's
 * on-disk names: video/<chain>_clip_NNN.mp4
 */
export function planChain({ durationSeconds, chunkSeconds = H3_DEFAULT_CHUNK_SECONDS }) {
  const total = h3ClipCount(durationSeconds, chunkSeconds)
  return {
    clipsTotal: total,
    chunkSeconds,
    clipFiles: Array.from({ length: total }, (_, i) => i + 1),
  }
}
