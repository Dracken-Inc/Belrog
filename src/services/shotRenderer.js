/**
 * Shot Renderer — LTX-2.3 per-shot render + still-frame test mode.
 *
 * Turns one clip of a validated plan.json into a ComfyUI API graph for
 * public/workflows/music_video_shot_ltx2_3_i2v_audio.json, queues it, waits,
 * and downloads the result. Pure Node: no Electron, no DOM, no `ws` — so the
 * CLI and `node --test` can both import it.
 *
 * Laws this file exists to obey:
 *  - The enhancer subgraph is GONE from the shipped graph (64 nodes). Prompts
 *    are compiled HERE, in code, so what the still frame shows is what the
 *    video shot would have used. The in-graph TextGenerateLTX2Prompt path is
 *    not a lever we pull.
 *  - Negative prompt node 1626 stays empty (LTX-2.3 keeps it unused).
 *  - Render defaults live in the graph and in RENDER_DEFAULTS, never in prose.
 *  - One shared track for every clip (O-10): the audio window is
 *    plan.track.path plus each clip's own start/length.
 *  - Nothing is queued before the vLLM preflight gate has passed.
 *
 * Plan field mapping (the plan schema is the frozen contract, so these are the
 * names we read; the coordinator's shorthand in the task text maps onto them):
 *   clips[].startSec / clips[].lengthSec   <- "audioStart / audioDuration"
 *   track.path                             <- "track.audioFile"
 */

import { readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getMusicVideoShotTypeOption, MUSIC_VIDEO_CAMERA_MOVE_OPTIONS } from '../config/musicVideoShotConfig.js'
import { assertGenerationAllowed } from './renderPreflight.js'

const HERE = dirname(fileURLToPath(import.meta.url))
// Resolved from the module, never from cwd (importing this from scripts/ must work).
export const WORKFLOW_PATH = resolve(HERE, '../../public/workflows/music_video_shot_ltx2_3_i2v_audio.json')

/** Node ids of the enhancer subgraph that must never come back. */
export const ENHANCER_NODE_IDS = ['2116', '2109:1928', '2109:1623', '2109:1620', '2109:1618', '1623', '1620', '1618']
export const ENHANCER_CLASS = 'TextGenerateLTX2Prompt'
export const EXPECTED_NODE_COUNT = 64

/**
 * Nodes we write to. Title of each is in the graph comment so a graph swap
 * that moves an id shows up here as a mismatch instead of a silent no-op.
 */
export const NODE = Object.freeze({
  referenceImage: '444',   // LoadImage                  "Load Image (Shot Reference)"
  prompt: '1624',          // PrimitiveStringMultiline   "PROMPT"
  negative: '1626',        // CLIPTextEncode             "CLIP Text Encode (Keep Empty for LTX 2.3)"
  fps: '1586',             // PrimitiveFloat             "FPS"
  height: '1591',          // INTConstant                "HEIGHT"
  width: '1606',           // INTConstant                "WIDTH"
  length: '2012',          // PrimitiveFloat             "LENGTH (in seconds)"
  audioStart: '5100',      // PrimitiveFloat             "AUDIO START (seconds in song)"
  audioFile: '1594',       // LoadAudio                  "Load Audio (Full Track or Vocal Stem)"
  vocalsSwitch: '1616',    // ComfySwitchNode            "USE VOCALS ONLY"
  imgStrength: '1722',     // PrimitiveFloat             "IMG STRENGTH"
  seedPass1: '2179',       // RandomNoise                "RandomNoise (Pass 1)"
  seedPass2: '2169',       // RandomNoise                "RandomNoise (Pass 2)"
  stepsPass1: '2186',      // BasicScheduler             "BasicScheduler (Pass 1)"
  stepsPass2: '2173',      // BasicScheduler             "BasicScheduler (Pass 2)"
  frameCalc: '1651',       // SimpleCalculatorKJ         "Frame Count (length * fps, aligned)"
  audioTrim: '1653',       // TrimAudioDuration          "Trim Audio (shot segment of the song)"
  vocalModel: '1600',      // MelBandRoFormerModelLoader  (vocal extraction, video path only)
  vocalSampler: '1599',    // MelBandRoFormerSampler
  saveVideo: '5001',       // SaveVideo
  createVideo: '5000',     // CreateVideo (silent)
  loras: '2150',           // Power Lora Loader (rgthree)
})

/** Still-mode nodes we add (ids outside the shipped graph's range on purpose). */
export const STILL_NODE_IDS = Object.freeze({ takeFrame: '9000', saveImage: '9001' })

/**
 * Route defaults. The shipped graph carries the full-quality baseline
 * (1280x736 @ 25 fps); these are the calibration/still route, and both
 * dimensions are multiples of 32 because the LTX VAE needs that — 854x480 is
 * what "480p" looks like in a URL but it is not a legal latent size (832 is
 * the nearest /32 width, and the plan's letterbox matte covers the difference).
 */
export const RENDER_DEFAULTS = Object.freeze({
  width: 832,
  height: 480,
  fps: 24,
  stepsPass1: 8,
  stepsPass2: 4,
  cfg: 1.0,
  imageStrength: 0.7,
  lookAheadFrames: 1,           // one frame past the shot end, so vocals do not clip
  imgCompression: 18,
  useVocalsOnly: false,          // pre-extracted stem or full track; Mel-Band at graph time costs a model per shot
  filenamePrefix: 'video/music_video/shot',
  stillFilenamePrefix: 'music_video/still',
})

/** --single calibration gate: one short clip, cheap, to measure the machine. */
export const CALIBRATION = Object.freeze({
  ...RENDER_DEFAULTS,
  label: 'single-clip-calibration',
  requestedFrames: 20,           // the task's intent; see calibrationLengthSeconds for what the graph can do
  maxSeconds: 1.0,               // frames land on 25 at 24 fps (the 8n+1 law, see graphFrames)
})

/**
 * The graph derives frame count itself:
 *   SimpleCalculatorKJ 1651: ((round((length * fps - 1) / 8)) * 8) + 1
 * Mirror it in JS so we can report what the graph will actually render.
 */
export function graphFrames(lengthSec, fps) {
  const aligned = Math.round((lengthSec * fps - 1) / 8)
  return Math.max(1, aligned) * 8 + 1
}

/** Length that lands closest to a wanted frame count under the 8n+1 law. */
export function lengthForFrames(wantFrames, fps) {
  const aligned = Math.max(0, Math.round((wantFrames - 1) / 8))
  return (aligned * 8 + 2) / (2 * fps) // midpoint of the window that rounds to `aligned`
}

/**
 * Pick the calibration length: nearest legal frame count to `requestedFrames`
 * without exceeding the max wall-clock the gate may burn.
 */
export function calibrationLengthSeconds({ fps = CALIBRATION.fps, maxSeconds = CALIBRATION.maxSeconds } = {}) {
  let best = 1 / fps
  let bestFrames = graphFrames(best, fps)
  for (let s = 1 / fps; s <= maxSeconds + 1e-9; s += 1 / fps) {
    const f = graphFrames(s, fps)
    if (Math.abs(f - CALIBRATION.requestedFrames) < Math.abs(bestFrames - CALIBRATION.requestedFrames)) {
      best = s
      bestFrames = f
    }
  }
  return { lengthSec: Number(best.toFixed(6)), frames: bestFrames }
}

/** Look-ahead window, computed from the route fps — never hardcoded per shot. */
export function lookAheadSeconds({ fps = RENDER_DEFAULTS.fps, frames = RENDER_DEFAULTS.lookAheadFrames } = {}) {
  return frames / fps
}

/* ------------------------------------------------------------------ *
 * Graph load / audit
 * ------------------------------------------------------------------ */

export async function loadShotGraph(path = WORKFLOW_PATH) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/**
 * Structural facts about a graph. Used by the tests and by --doctor.
 */
export function auditShotGraph(graph) {
  const ids = Object.keys(graph)
  const enhancerIds = ids.filter((id) => graph[id]?.class_type === ENHANCER_CLASS)
  const deadEnhancerIds = ids.filter((id) => ENHANCER_NODE_IDS.includes(id) && graph[id]?.class_type !== ENHANCER_CLASS)
  const negative = graph[NODE.negative]
  const problems = []
  if (enhancerIds.length) problems.push(`enhancer node ${ENHANCER_CLASS} present at ${enhancerIds.join(', ')}`)
  if (deadEnhancerIds.length) problems.push(`enhancer subgraph ids still present: ${deadEnhancerIds.join(', ')}`)
  if (ids.length !== EXPECTED_NODE_COUNT) problems.push(`node count is ${ids.length}, expected ${EXPECTED_NODE_COUNT}`)
  if (!negative || negative.class_type !== 'CLIPTextEncode') problems.push(`negative node ${NODE.negative} is not a CLIPTextEncode`)
  else if (String(negative.inputs?.text ?? '') !== '') problems.push(`negative prompt is not empty (${JSON.stringify(negative.inputs.text)})`)
  for (const [key, label] of Object.entries({
    [NODE.prompt]: 'PROMPT', [NODE.fps]: 'FPS', [NODE.width]: 'WIDTH', [NODE.height]: 'HEIGHT',
    [NODE.length]: 'LENGTH', [NODE.audioStart]: 'AUDIO START', [NODE.audioFile]: 'LoadAudio',
    [NODE.seedPass1]: 'RandomNoise (Pass 1)', [NODE.stepsPass1]: 'BasicScheduler (Pass 1)',
    [NODE.saveVideo]: 'SaveVideo', [NODE.referenceImage]: 'LoadImage',
  })) {
    if (!graph[key]) problems.push(`endpoint node ${key} (${label}) missing — the graph was swapped under the renderer`)
  }
  return { nodes: ids.length, enhancerNodes: enhancerIds, emptyNegative: String(negative?.inputs?.text ?? '') === '', ok: problems.length === 0, problems }
}

/* ------------------------------------------------------------------ *
 * Prompt compilation (deterministic, no in-graph enhancer, no LLM here)
 * ------------------------------------------------------------------ */

/**
 * The 1990s camera grammar the plan's enum allows but
 * musicVideoShotConfig.MUSIC_VIDEO_CAMERA_MOVE_OPTIONS does not carry yet
 * (the schema's own note: "pending in W-A step 4"). Local table so the
 * renderer never emits a bare id; move it into the config when W-A lands it.
 */
const PENDING_CAMERA_MOVE_LINES = Object.freeze({
  'dutch-tilt': 'Camera: Static frame tilted on the diagonal, horizon canted, held for the whole shot.',
  'dolly-zoom': 'Camera: Dolly in while zooming out, background bending behind a locked subject.',
  'whip-pan': 'Camera: Fast whip pan between subjects, motion-blurred transition, landing on a stable frame.',
  steadicam: 'Camera: Smooth Steadicam glide at chest height, floating through the space, subject centred.',
  crane: 'Camera: Crane move lifting and pulling back to reveal the scale of the location.',
  'snap-zoom': 'Camera: Snap zoom punching in hard onto the subject on the beat, then holding.',
})

function moveLine(id) {
  if (PENDING_CAMERA_MOVE_LINES[id]) return PENDING_CAMERA_MOVE_LINES[id]
  const found = (MUSIC_VIDEO_CAMERA_MOVE_OPTIONS || []).find((o) => o.id === id)
  return found ? `Camera: ${String(found.scriptLine || '').replace(/^Camera:\s*/, '')}` : `Camera: ${id}.`
}

const SIZE_LINE = { wide: 'Framing: Wide.', medium: 'Framing: Medium, waist-up.', 'close-up': 'Framing: Close-up portrait.', detail: 'Framing: Tight insert detail.' }
const ENERGY_LINE = { calm: 'Motion: Calm, restrained.', building: 'Motion: Building intensity on the beat.', intense: 'Motion: Intense, urgent, movement accented on the music.' }

const BANNED = [/arithmetic/gi, /placeholder/gi, /figure it out/gi, /waiting for the director/gi, /\btodo\b/gi, /xxx/gi]

/**
 * Compile the prose one clip gets. Same function for video and stills, so a
 * still is evidence about the video and not about a different prompt.
 *
 * Order is fixed: locks first (cast, location — verbatim so they can never be
 * re-described differently between shots, V5), then the shot's own grammar
 * (framing, camera, motion), then the action prose the imagination pass wrote,
 * then the lyric/lip-sync line, then the shot-type suffix from the shared
 * config. Nothing invented, nothing padded.
 */
export function compileShotPrompt({ plan, clip, shots, maxLength = 2500 } = {}) {
  if (!plan || !clip || !shots?.length) throw new Error('compileShotPrompt needs plan, clip and shots')
  const look = plan.look || {}
  const castBySlug = new Map((plan.cast || []).map((c) => [c.slug, c]))
  const location = look.location || {}
  const propsBySlug = new Map((location.props || []).map((p) => [p.slug, p]))
  const lines = []

  for (const shot of shots) {
    const one = []
    const slugs = shot.cast || []
    if (shot.locationOverride && location.slug && shot.locationOverride !== location.slug) {
      throw new Error(`Shot ${shot.id} overrides location "${shot.locationOverride}" but the plan carries no lock for that slug (V5) — declare it in look.location or drop the override`)
    }
    if (location.lock) one.push(`Location: ${location.lock.trim()}`)
    if (slugs.length) {
      const people = slugs.map((slug) => {
        const c = castBySlug.get(slug)
        return c?.lock ? `${slug} — ${c.lock.trim()}` : slug
      })
      one.push(`On screen: ${people.join('; ')}.`)
    }
    const propNames = (shot.props || []).map((slug) => {
      const p = propsBySlug.get(slug)
      return (p?.lock || p?.label || slug).toString().trim()
    })
    if (propNames.length) one.push(`Props: ${propNames.join(', ')}.`)

    if (SIZE_LINE[shot.size]) one.push(SIZE_LINE[shot.size])
    one.push(moveLine(shot.cameraMove))
    if (ENERGY_LINE[shot.energy]) one.push(ENERGY_LINE[shot.energy])

    if (shot.action) one.push(`Action: ${String(shot.action).trim()}`)
    if (shot.lyric) one.push(`Line carried: "${String(shot.lyric).trim()}"`)
    if (shot.lipSync === false && shot.performanceMode === 'b-roll') one.push('No performer singing on camera.')

    const film = (shot.film || look.film || '').trim()
    const lighting = (shot.lighting || look.lighting || '').trim()
    if (film) one.push(`Film: ${film}`)
    if (lighting) one.push(`Lighting: ${lighting}`)
    if (look.palette) one.push(`Palette: ${String(look.palette).trim()}`)
    if (look.letterbox) one.push(`Matte: ${String(look.letterbox).trim()}`)

    const suffix = getMusicVideoShotTypeOption?.(shot.shotType)?.promptSuffix
    if (suffix) one.push(String(suffix).trim())

    lines.push(`Shot ${shot.id}: ${one.filter(Boolean).join(' ')}`)
  }

  const text = lines.join('\n\n')
  for (const re of BANNED) {
    if (re.test(text)) throw new Error(`compiled prompt for clip ${clip.index} contains a banned token (${re.source})`)
  }
  if (text.length > maxLength) {
    throw new Error(`compiled prompt for clip ${clip.index} is ${text.length} chars, over the ${maxLength} budget — shorten the locks or split the clip`)
  }
  return text
}

/* ------------------------------------------------------------------ *
 * Graph filling
 * ------------------------------------------------------------------ */

function setNode(graph, id, patch) {
  const node = graph[id]
  if (!node) throw new Error(`workflow has no node ${id} — the graph was swapped under the renderer`)
  Object.assign(node.inputs, patch)
  return node
}

/**
 * Resolve which shots a clip carries, in time order.
 */
export function shotsForClip(plan, clip) {
  const byId = new Map((plan.shots || []).map((s) => [s.id, s]))
  const shots = (clip.shotIds || []).map((id) => byId.get(id)).filter(Boolean)
  if (!shots.length) throw new Error(`clip ${clip.index} references no shots that exist in the plan`)
  return shots
}

/**
 * The audio window for a clip. `lengthSec` is the usable window; the render
 * asks for one extra look-ahead frame so the mouth finishes its motion and the
 * vocal does not clip. The extra frame is trimmed at stitch time, not here.
 */
export function audioWindowForClip({ clip, fps = RENDER_DEFAULTS.fps, lookAheadFrames = RENDER_DEFAULTS.lookAheadFrames } = {}) {
  const usable = Number(clip.lengthSec)
  if (!Number.isFinite(usable) || usable <= 0) throw new Error(`clip ${clip.index} has no usable lengthSec`)
  const lookAhead = lookAheadFrames / fps
  const renderLength = usable + lookAhead
  return {
    startSec: Number(clip.startSec) || 0,
    usableSec: usable,
    lookAheadSec: Number(lookAhead.toFixed(6)),
    renderLengthSec: Number(renderLength.toFixed(6)),
    usableFrames: Math.round(usable * fps),
    renderFrames: graphFrames(renderLength, fps),
  }
}

/**
 * Fill the graph for one VIDEO clip.
 */
export function buildShotGraph({ plan, clip, graph, options = {} } = {}) {
  const wf = graph ? JSON.parse(JSON.stringify(graph)) : null
  if (!wf) throw new Error('buildShotGraph needs the loaded graph')
  const shots = shotsForClip(plan, clip)
  // F1: plan.fps is the authority on the music-video path — a shot rendered at
  // an fps other than the plan's desyncs lip-sync against the song, and a
  // RENDER_DEFAULTS.fps fallback is what let 25 outrun the 23.976 timeline.
  // Only an explicit options.fps (renderPlanClips' resolved rate) outranks it.
  if (options.fps !== undefined && !Number.isFinite(Number(options.fps))) {
    throw new Error('buildShotGraph: options.fps is not a number — refusing to render at a guessed frame rate')
  }
  const planFps = Number(plan?.fps)
  const fps = options.fps !== undefined
    ? Number(options.fps)
    : (Number.isFinite(planFps) && planFps > 0 ? planFps : null)
  if (fps === null) {
    throw new Error(`plan ${plan?.id ?? plan?.name ?? '(unknown)'} has no usable plan.fps — refusing to render at a guessed frame rate (F1: stamp plan.fps from the timeline, see docs/plans)`)
  }
  const opts = { ...RENDER_DEFAULTS, ...options, fps }
  const window = audioWindowForClip({ clip, fps: opts.fps, lookAheadFrames: opts.lookAheadFrames })
  const prompt = compileShotPrompt({ plan, clip, shots, maxLength: opts.maxPromptLength })

  setNode(wf, NODE.prompt, { value: prompt })
  setNode(wf, NODE.negative, { text: '' })            // empty always: LTX-2.3 does not use it
  setNode(wf, NODE.width, { value: Math.round(opts.width) })
  setNode(wf, NODE.height, { value: Math.round(opts.height) })
  // F1: fps stays a float (23.976 is not 24); only frame counts are rounded,
  // and they come from graphFrames below — node 1651 must not re-derive them.
  setNode(wf, NODE.fps, { value: opts.fps })
  setNode(wf, NODE.length, { value: window.renderLengthSec })
  // F1: single-source the frame count — pin the calculator's output to the
  // exact value JS computed (graphFrames), instead of letting it recompute
  // length*fps with whatever rounding its evaluator applies. graphFrames
  // already applied the 8n+1 law, so the literal IS the aligned count.
  setNode(wf, NODE.frameCalc, { expression: String(window.renderFrames), variables_a: undefined, variables_b: undefined })
  delete wf[NODE.frameCalc].inputs['variables.a']
  delete wf[NODE.frameCalc].inputs['variables.b']
  setNode(wf, NODE.audioStart, { value: window.startSec })
  setNode(wf, NODE.audioFile, { audio: opts.audioFilename || basename(String(plan.track?.path || 'music_video_track.mp3')) })
  setNode(wf, NODE.vocalsSwitch, { switch: Boolean(opts.useVocalsOnly) })
  setNode(wf, NODE.imgStrength, { value: Number(opts.imageStrength) })
  setNode(wf, NODE.seedPass1, { noise_seed: Math.round(opts.seed) })
  setNode(wf, NODE.seedPass2, { noise_seed: Math.round(opts.seed) + 1 })
  setNode(wf, NODE.stepsPass1, { steps: Math.round(opts.stepsPass1) })
  setNode(wf, NODE.stepsPass2, { steps: Math.round(opts.stepsPass2) })
  setNode(wf, NODE.saveVideo, { filename_prefix: opts.filenamePrefix })

  const ref = opts.referenceImageFilename
  if (ref) setNode(wf, NODE.referenceImage, { image: ref })

  const shotType = shots[0]?.shotType
  const shotTypeOption = getMusicVideoShotTypeOption?.(shotType)
  if (shotTypeOption && wf[NODE.loras]?.inputs?.lora_1) {
    wf[NODE.loras].inputs.lora_1.on = Boolean(shotTypeOption.talkingHeadLoraOn)
    if (Number.isFinite(Number(shotTypeOption.talkingHeadLoraStrength))) {
      wf[NODE.loras].inputs.lora_1.strength = Number(shotTypeOption.talkingHeadLoraStrength)
    }
  }
  if (shotTypeOption?.defaultImageStrength !== undefined && options.imageStrength === undefined) {
    setNode(wf, NODE.imgStrength, { value: Number(shotTypeOption.defaultImageStrength) })
  }

  return { graph: wf, window, prompt, shots, seed: Math.round(opts.seed) }
}

/**
 * Fill the graph for a STILL frame: one frame, one PNG, no video container.
 *
 * What comes out: the same compiled prompt, the same seed, the same geometry,
 * 1 frame instead of a clip, SaveImage instead of CreateVideo+SaveVideo, and
 * the Mel-Band vocal-extraction branch deleted so no RoFormer model loads.
 *
 * Honest limit, stated instead of faked: LTX-2.3's samplers take an AV latent,
 * so one audio-VAE encode stays in the graph — the window is a single frame
 * (≈42 ms), not the track. Stripping the audio latent entirely produces a graph
 * we cannot validate without generating, which is exactly what is forbidden.
 */
export function buildStillGraph({ plan, clip, graph, options = {} } = {}) {
  const built = buildShotGraph({ plan, clip, graph, options })
  const wf = built.graph
  // F1: reuse the fps the single authority (buildShotGraph) already resolved
  // — options may carry RENDER_DEFAULTS.fps from a caller spread, so re-spreading
  // { ...RENDER_DEFAULTS, ...options } would mask a plan.fps that differs from it.
  // The fps node is the graph's own record of what authority stamped.
  const fps = Number(wf[NODE.fps]?.inputs?.value)
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error('buildStillGraph: could not resolve fps from the graph built by buildShotGraph')
  }

  // One frame only: length = 1/fps makes the calculator land on 8*0+1 = 1.
  setNode(wf, NODE.length, { value: Number((1 / fps).toFixed(6)) })
  built.window = { ...built.window, renderLengthSec: Number((1 / fps).toFixed(6)), renderFrames: 1 }

  // No video container, no silent-video mux.
  delete wf[NODE.createVideo]
  delete wf[NODE.saveVideo]

  // No vocal extraction for a still.
  delete wf[NODE.vocalSampler]
  delete wf[NODE.vocalModel]
  if (wf[NODE.audioTrim]) wf[NODE.audioTrim].inputs.audio = [NODE.audioFile, 0]

  // Save the single decoded frame as a PNG.
  wf[STILL_NODE_IDS.takeFrame] = {
    class_type: 'GetImageFromBatch',
    _meta: { title: 'Belrog Still Frame (first frame)' },
    inputs: { image: ['1318', 0], start_index: 0, length: 1 },
  }
  wf[STILL_NODE_IDS.saveImage] = {
    class_type: 'SaveImage',
    _meta: { title: 'Belrog Save Still (PNG)' },
    inputs: { images: [STILL_NODE_IDS.takeFrame, 0], filename_prefix: { ...RENDER_DEFAULTS, ...options }.stillFilenamePrefix },
  }

  return { ...built, graph: wf }
}

/* ------------------------------------------------------------------ *
 * Upload cache (content hash, so the same track uploads once per host)
 * ------------------------------------------------------------------ */

export function createUploadCache({ dir = null } = {}) {
  const mem = new Map()
  const file = dir ? join(dir, 'upload-cache.json') : null
  let loaded = false

  async function load() {
    if (loaded || !file) { loaded = true; return }
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'))
      for (const [k, v] of Object.entries(raw)) mem.set(k, v)
    } catch { /* cold cache */ }
    loaded = true
  }

  async function save() {
    if (!file) return
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(Object.fromEntries(mem)), 'utf8')
  }

  return {
    async hash(filePath) {
      const h = createHash('sha256')
      const size = (await stat(filePath)).size
      // Hash.update() takes a Buffer, never a stream — feeding it a ReadStream
      // throws synchronously, which would break every upload on its first call.
      const digestRange = (start, end) => new Promise((res, rej) => {
        const stream = createReadStream(filePath, { start, end })
        stream.on('data', (chunk) => h.update(chunk))
        stream.on('end', res)
        stream.on('error', rej)
      })
      await digestRange(0, Math.min(65535, Math.max(0, size - 1)))
      if (size > 131072) await digestRange(Math.max(0, size - 65536), size - 1)
      h.update(String(size))
      return h.digest('hex')
    },
    async put(comfy, filePath, { subfolder = '', type = 'input', host = 'default' } = {}) {
      await load()
      const name = basename(filePath)
      const key = `${host}:${type}:${subfolder}:${name}`
      const digest = await this.hash(filePath)
      const existing = mem.get(key)
      if (existing && existing.digest === digest) return { ...existing.result, cached: true }
      const result = await comfy.uploadFile(filePath, name, subfolder, type)
      mem.set(key, { digest, result: { name: result.name ?? name, subfolder: result.subfolder ?? subfolder, type: result.type ?? type } })
      await save()
      return { ...result, cached: false }
    },
    size: () => mem.size,
  }
}

/* ------------------------------------------------------------------ *
 * Queue + poll (no websocket dependency: /queue and /history are enough)
 * ------------------------------------------------------------------ */

export async function waitForPrompt({ comfy, promptId, timeoutMs = 30 * 60 * 1000, intervalMs = 2000, onProgress = null, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const started = now()
  for (;;) {
    const history = await comfy.getHistory(promptId)
    const entry = history?.[promptId]
    if (entry) {
      const outputs = entry.outputs || {}
      const videos = []
      const images = []
      for (const node of Object.values(outputs)) {
        for (const v of node.videos || []) videos.push(v)
        for (const i of node.images || []) images.push(i)
      }
      if (videos.length || images.length) return { videos, images, outputs }
      const status = entry.status?.status_str
      if (status === 'error') throw new Error(`ComfyUI reported an error for ${promptId}: ${JSON.stringify(entry.status?.messages || []).slice(0, 500)}`)
    }
    if (now() - started > timeoutMs) throw new Error(`render timed out after ${Math.round(timeoutMs / 1000)}s (prompt ${promptId})`)
    onProgress?.({ phase: 'rendering', elapsedMs: now() - started })
    await sleep(intervalMs)
  }
}

/* ------------------------------------------------------------------ *
 * Public entry points
 * ------------------------------------------------------------------ */

export function seedFor(clip, { seed = null } = {}) {
  // Number(null) is 0, so a bare `Number.isFinite(Number(seed))` would treat
  // "no seed given" as "seed 0" and every clip would render identically.
  if (seed !== null && seed !== undefined && Number.isFinite(Number(seed))) return Math.round(Number(seed))
  // Deterministic per (clip index, start): a re-run of the same plan gives the
  // same picture, which is what makes a bug report reproducible.
  return 1000 + Math.round((Number(clip.index) || 0) * 1000 + (Number(clip.startSec) || 0) * 1)
}

/**
 * Render ONE clip.
 *
 * @param {object} p
 * @param {object} p.plan       validated plan.json
 * @param {object} p.clip       one entry of plan.clips[]
 * @param {object} p.comfy      client with queuePrompt/getHistory/downloadVideo/uploadFile
 * @param {string} p.outPath    local path for the mp4
 * @param {string} [p.mode]     'video' (default) or 'still'
 * @param {object} [p.options]  override RENDER_DEFAULTS
 * @param {Function} [p.onProgress]
 */
export async function renderShot({ plan, clip, comfy, outPath, mode = 'video', options = {}, onProgress, env = process.env, gate = true } = {}) {
  if (!plan || !clip) throw new Error('renderShot needs plan and clip')
  const kind = mode === 'still' ? 'still' : 'video'
  let facts = null
  if (gate) {
    facts = await assertGenerationAllowed({ kind, env })
    onProgress?.({ phase: 'gate', ok: true, ...facts })
  }

  const graph = await loadShotGraph()
  const audit = auditShotGraph(graph)
  if (!audit.ok) throw new Error(`shipped workflow failed its own audit: ${audit.problems.join('; ')}`)

  const opts = { ...RENDER_DEFAULTS, seed: seedFor(clip, options), ...options }
  const built = mode === 'still' ? buildStillGraph({ plan, clip, graph, options: opts }) : buildShotGraph({ plan, clip, graph, options: opts })

  // Upload the shared track once (O-10) — same content hash, one upload.
  const cache = options.uploadCache || createUploadCache({ dir: options.cacheDir })
  const uploaded = []
  if (plan.track?.path) {
    const up = await cache.put(comfy, plan.track.path, { type: 'input', host: comfy.host || 'default' })
    built.graph[NODE.audioFile].inputs.audio = up.name
    uploaded.push({ role: 'track', ...up })
  }
  if (options.referenceImagePath) {
    const up = await cache.put(comfy, options.referenceImagePath, { type: 'input', host: comfy.host || 'default' })
    built.graph[NODE.referenceImage].inputs.image = up.name
    uploaded.push({ role: 'reference', ...up })
  }

  onProgress?.({ phase: 'queueing', clip: clip.index, frames: built.window.renderFrames })
  const queued = await comfy.queuePrompt(built.graph)
  const promptId = queued?.prompt_id || queued?.node_errors?.prompt_id
  if (!promptId) throw new Error(`ComfyUI accepted the graph but returned no prompt_id: ${JSON.stringify(queued).slice(0, 300)}`)

  const started = Date.now()
  const result = await waitForPrompt({ comfy, promptId, timeoutMs: options.timeoutMs, intervalMs: options.pollMs, onProgress })
  const renderTimeMs = Date.now() - started

  let saved = null
  if (result.videos.length) {
    saved = await comfy.downloadVideo(result.videos[0])
    await writeFile(outPath, Buffer.from(await saved.arrayBuffer()))
  } else if (result.images.length) {
    saved = await comfy.downloadVideo(result.images[0])
    await writeFile(outPath, Buffer.from(await saved.arrayBuffer()))
  } else {
    throw new Error(`prompt ${promptId} finished with no video or image output`)
  }

  return {
    mode,
    clipIndex: clip.index,
    shotIds: built.shots.map((s) => s.id),
    graph: built.graph,
    prompt: built.prompt,
    window: built.window,
    seed: built.seed,
    outPath,
    renderTimeMs,
    wallClockPerRenderedSec: renderTimeMs / 1000 / Math.max(1e-6, built.window.renderFrames / opts.fps),
    outputs: { videos: result.videos, images: result.images },
    uploads: uploaded,
    gate: facts,
    graphAudit: audit,
  }
}

/**
 * Per-shot stills for the whole plan (composition/look/prompt proof).
 * One PNG per shot, image-only, and only ever reached through the gate.
 */
export async function renderStills({ plan, comfy, outDir, options = {}, onProgress, env = process.env } = {}) {
  const gateFacts = await assertGenerationAllowed({ kind: 'still', env })
  const graph = await loadShotGraph()
  const audit = auditShotGraph(graph)
  if (!audit.ok) throw new Error(`shipped workflow failed its own audit: ${audit.problems.join('; ')}`)
  const results = []
  const stillNodes = { [STILL_NODE_IDS.saveImage]: true }
  const stillAudit = { ...audit, nodes: audit.nodes - 4 + 2 } // -CreateVideo -SaveVideo -MelBand x2 +GetImageFromBatch +SaveImage
  for (const clip of plan.clips || []) {
    const shots = shotsForClip(plan, clip)
    const opts = { ...RENDER_DEFAULTS, seed: seedFor(clip, options), ...options }
    const built = buildStillGraph({ plan, clip, graph, options: opts })
    if (plan.track?.path) {
      const cache = options.uploadCache || createUploadCache({ dir: options.cacheDir })
      const up = await cache.put(comfy, plan.track.path, { type: 'input', host: comfy.host || 'default' })
      built.graph[NODE.audioFile].inputs.audio = up.name
    }
    const outPath = join(outDir, `clip_${String(clip.index).padStart(2, '0')}_shot_${shots[0]?.id || 'x'}.png`)
    onProgress?.({ phase: 'still', clip: clip.index, shotId: shots[0]?.id, promptChars: built.prompt.length })
    const queued = await comfy.queuePrompt(built.graph)
    const done = await waitForPrompt({ comfy, promptId: queued.prompt_id, timeoutMs: options.timeoutMs, intervalMs: options.pollMs })
    const png = await comfy.downloadVideo(done.images[0] || done.videos[0])
    await writeFile(outPath, Buffer.from(await png.arrayBuffer()))
    results.push({ clipIndex: clip.index, shotIds: shots.map((s) => s.id), outPath, prompt: built.prompt, window: built.window, seed: built.seed })
  }
  return { gate: gateFacts, graphAudit: audit, stillAudit, stillNodes: Object.keys(stillNodes), results }
}
