/**
 * The render driver: a validated plan.json in, stitched mp4 out.
 *
 * This module has NO electron dependency on purpose. The app reaches it through
 * musicVideoPipeline.js (which knows about windows, project folders and IPC),
 * and scripts/music-video-render.mjs reaches it directly. Both paths therefore
 * render the same way — one set of laws, one place to fix a bug.
 *
 * Laws:
 *  - CLIPS are the unit of work, shots are the unit of story. A clip is done
 *    when every shot it covers is done. (The renderer is clip-centric; state
 *    is shot-centric. This file is the seam between them.)
 *  - A clip that is already on disk with a matching report is skipped, so an
 *    interrupted render resumes instead of paying for the GPU twice.
 *  - Nothing here generates a frame without renderPreflight's gate. The gate
 *    says yes/no and why; this file never overrides it.
 *  - The stitch is a trim+concat of rendered clips with the source track laid
 *    over the top. No padding: padding slides every later cut off its beat.
 *    A short clip is drift, and drift is reported, not hidden.
 */
import { join } from 'node:path'
import { writeFile, readFile, mkdir, stat } from 'node:fs/promises'

import {
  RENDER_DEFAULTS,
  audioWindowForClip,
  renderShot,
  seedFor,
  shotsForClip,
  createUploadCache,
} from './shotRenderer.js'
import { buildStitchCommand, stitchClips, STITCH_DEFAULTS } from './stitcher.js'
import { resolveComfyTarget } from './renderPreflight.js'
import { createComfyClient } from './comfyClient.js'

/** Clips in timeline order, each with a guaranteed integer index. */
export function clipsFromPlan(plan) {
  const clips = Array.isArray(plan?.clips) ? plan.clips : []
  if (!clips.length) throw new Error('plan has no clips — nothing to render')
  return clips
    .map((clip, i) => ({ ...clip, index: Number.isInteger(clip.index) ? clip.index : i }))
    .sort((a, b) => a.index - b.index)
}

/** Deterministic clip file name — resume depends on it never changing. */
export function clipFileName(clip) {
  return `clip_${String(clip.index).padStart(3, '0')}.mp4`
}
export function clipReportFileName(clip) {
  return `clip_${String(clip.index).padStart(3, '0')}.json`
}

/** Which shot records a clip render should mark done. */
export function coveredShots(plan, clip) {
  const shots = shotsForClip(plan, clip)
  const ids = Array.isArray(clip.shotIds) && clip.shotIds.length ? clip.shotIds : shots.map((s) => s.id)
  return ids.filter(Boolean)
}

/**
 * Decide what still needs rendering.
 * `doneClipIndexes` wins over shot states when given (disk is the truth);
 * shot states are used when the files are ambiguous (e.g. deleted output).
 */
export function planClipWork({ plan, shotStates = [], doneClipIndexes = null } = {}) {
  const clips = clipsFromPlan(plan)
  const done = new Set()
  if (doneClipIndexes) {
    for (const i of doneClipIndexes) done.add(i)
  } else {
    const stateById = new Map((shotStates || []).map((s) => [s.shotId, s.status]))
    for (const clip of clips) {
      const ids = coveredShots(plan, clip)
      if (ids.length && ids.every((id) => stateById.get(id) === 'done')) done.add(clip.index)
    }
  }
  return {
    clips,
    doneClips: clips.filter((c) => done.has(c.index)),
    pendingClips: clips.filter((c) => !done.has(c.index)),
  }
}

/**
 * Can this clip be skipped? Requires the file to exist AND a report that agrees
 * on the same seed and length, so a half-written or stale render is redone.
 */
export async function clipIsUsable({ outPath, reportPath, seed, lengthSec }) {
  try {
    const s = await stat(outPath)
    if (!s.size) return { ok: false, why: 'missing or empty' }
    const raw = await readFile(reportPath, 'utf8')
    const rep = JSON.parse(raw)
    if (seed != null && rep.seed != null && rep.seed !== seed) return { ok: false, why: `seed changed (${rep.seed} -> ${seed})` }
    if (lengthSec != null && rep.lengthSec != null && Math.abs(rep.lengthSec - lengthSec) > 0.01) {
      return { ok: false, why: `length changed (${rep.lengthSec} -> ${lengthSec})` }
    }
    return { ok: true, why: 'on disk and report agrees', bytes: s.size }
  } catch {
    return { ok: false, why: 'no render report' }
  }
}

/**
 * Render every pending clip of a plan.
 *
 * @param {object} plan          validated plan
 * @param {string} renderDir     directory for clip_NNN.mp4
 * @param {object} [deps]        { comfy, env, gate, options, log, now, sleep,
 *                                 shouldCancel, onClip, doneClipIndexes, shotStates }
 */
export async function renderPlanClips(plan, renderDir, deps = {}) {
  const {
    env = process.env,
    gate = true,
    options = {},
    log = () => {},
    shouldCancel = async () => false,
    onClip = null,
    doneClipIndexes = null,
    shotStates = [],
    timelineFps = null,
  } = deps

  if (!plan) throw new Error('renderPlanClips needs a plan')
  await mkdir(renderDir, { recursive: true })

  const comfy = deps.comfy || (await defaultComfy(env))
  const work = planClipWork({ plan, shotStates, doneClipIndexes })
  // Resolve fps: options.fps > plan.fps (stamped at plan creation) > timelineFps (from caller) > RENDER_DEFAULTS.fps.
  // The timeline fps (e.g. 23.976) beats the constant 24 to avoid ~0.28s drift over a 283s song.
  // plan.look?.fps is dead — nothing in the tree ever sets look.fps.
  const fps = options.fps || plan.fps || timelineFps || RENDER_DEFAULTS.fps
  const cache = options.uploadCache || createUploadCache({ dir: renderDir })

  const results = work.doneClips.map((clip) => ({
    clipIndex: clip.index,
    skipped: true,
    outPath: join(renderDir, clipFileName(clip)),
    shotIds: coveredShots(plan, clip),
  }))

  let secondsRendered = 0
  const startedAt = deps.now ? deps.now() : Date.now()

  for (const clip of work.pendingClips) {
    if (await shouldCancel()) {
      return { ok: false, cancelled: true, results, secondsRendered, comfy }
    }

    const outPath = join(renderDir, clipFileName(clip))
    const reportPath = join(renderDir, clipReportFileName(clip))
    const seed = seedFor(clip, options)
    const usable = await clipIsUsable({ outPath, reportPath, seed, lengthSec: clip.lengthSec })
    if (usable.ok) {
      log({ phase: 'skip', clipIndex: clip.index, why: usable.why })
      results.push({ clipIndex: clip.index, skipped: true, outPath, seed, shotIds: coveredShots(plan, clip) })
      if (onClip) await onClip({ clipIndex: clip.index, skipped: true, outPath, seed, shotIds: coveredShots(plan, clip) })
      continue
    }

    log({ phase: 'render', clipIndex: clip.index, of: work.clips.length, seed })
    let res
    try {
      res = await renderShot({
        plan,
        clip,
        comfy,
        outPath,
        mode: options.mode === 'still' ? 'still' : 'video',
        gate,
        env,
        options: { ...options, seed, fps, uploadCache: cache },
        onProgress: (p) => log({ ...p, clipIndex: clip.index }),
      })
    } catch (err) {
      results.push({ clipIndex: clip.index, ok: false, error: String(err?.message || err), outPath })
      if (onClip) await onClip({ clipIndex: clip.index, ok: false, error: String(err?.message || err), outPath })
      continue
    }

    const renderedSec = res.window?.renderFrames / fps
    secondsRendered += renderedSec
    const wallSec = (deps.now ? deps.now() : Date.now()) - startedAt
    const doneSoFar = results.filter((r) => r.skipped || r.outPath).length
    const report = {
      clipIndex: clip.index,
      seed: res.seed,
      lengthSec: clip.lengthSec,
      renderSec: renderedSec,
      renderTimeMs: res.renderTimeMs,
      wallClockPerRenderedSec: res.wallClockPerRenderedSec,
      etaSec: secondsRendered > 0 ? (wallSec / 1000 / secondsRendered) * (renderedSec * (work.clips.length - doneSoFar)) : null,
      shotIds: res.shotIds,
      outPath,
      gate: res.gate,
      graphAudit: { ok: res.graphAudit?.ok, problems: res.graphAudit?.problems || [] },
    }
    await writeFile(reportPath, JSON.stringify(report, null, 2))
    results.push({ ...res, ok: true, outPath, report })
    log({ phase: 'done', clipIndex: clip.index, renderTimeMs: res.renderTimeMs, etaSec: report.etaSec })
    if (onClip) await onClip({ ...res, ok: true, outPath, report })
  }

  results.sort((a, b) => a.clipIndex - b.clipIndex)
  const failed = results.filter((r) => r.ok === false)
  return { ok: failed.length === 0, results, failed, secondsRendered, comfy }
}

/**
 * Lay the source track over the concatenated clips.
 * Returns the stitch command and the measured drift — both are facts the UI
 * shows, not debug noise: a cut that drifts off the beat is the whole point of
 * beat-synced video.
 */
export async function stitchRenderedClips({ plan, results, outPath, ffmpegPath, ffprobePath, env = process.env, onProgress, stitch = stitchClips } = {}) {
  const clips = clipsFromPlan(plan)
  const byIndex = new Map(results.map((r) => [r.clipIndex, r]))
  const inputs = []
  for (const clip of clips) {
    const r = byIndex.get(clip.index)
    if (!r?.outPath) throw new Error(`clip ${clip.index} has no rendered file to stitch — render refused or failed`)
    inputs.push({ path: r.outPath, startSec: clip.startSec, lengthSec: clip.lengthSec })
  }
  const cmd = buildStitchCommand({ clips: inputs, track: plan.track, outPath, ffmpegPath })
  onProgress?.({ phase: 'stitch', command: cmd.command || cmd.argv })
  const res = await stitch({ clips: inputs, track: plan.track, outPath, ffmpegPath, ffprobePath })
  return { outPath, command: cmd.command || cmd.argv, trims: cmd.trims || [], drift: res.drift ?? null, report: res }
}

/** Comfy target resolution lives in renderPreflight so CLI and app agree. */
export async function defaultComfy(env = process.env) {
  const target = await resolveComfyTarget({ env })
  if (!target?.url) {
    throw new Error(`no ComfyUI render host configured. Set ${'BELROG_COMFY_URL'} or ~/.belrog/render.json (comfyBaseUrl). Resolved: ${target?.source || 'unset'}`)
  }
  return { ...createComfyClient(target.url), target }
}

export { STITCH_DEFAULTS }
