/**
 * Stitcher — join per-shot LTX clips on the beat grid, pure ffmpeg (no
 * WebCodecs here; that path belongs to the app). Pure Node ESM.
 *
 * Two laws:
 *  - ONE audio source: the shared `plan.track.path` file, mapped once over the
 *    whole video (O-10). No clip carries its own audio into the mux.
 *  - No silent trimming. LTX renders land on the 8n+1 frame law plus one
 *    look-ahead frame, so every clip is a frame or two longer than its window.
 *    We trim exactly to `usableFrames` in the filter graph and REPORT the
 *    delta per clip; a clip that came back SHORTER than its window is drift and
 *    is logged, never padded over.
 */

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'

export const STITCH_DEFAULTS = {
  ffmpegPath: 'ffmpeg',
  videoCodec: 'libx264',
  crf: 18,
  preset: 'slow',
  pixFmt: 'yuv420p',
  audioCodec: 'aac',
  audioBitrate: '192k',
  fps: 24,
}

/**
 * One input per clip, video only, each trimmed to its usable window, then one
 * concat; the track file is mapped as a single audio source for the whole film.
 */
export function buildStitchCommand({ clips, track, outPath, ...opts } = {}) {
  if (!Array.isArray(clips) || clips.length === 0) throw new Error('buildStitchCommand needs a non-empty clips array')
  if (!track?.path) throw new Error('buildStitchCommand needs track.path — the single shared audio source (O-10)')
  if (!outPath) throw new Error('buildStitchCommand needs outPath')
  const o = { ...STITCH_DEFAULTS, ...opts }

  const inputs = []
  const filters = []
  const normalized = []
  const trims = []

  clips.forEach((clip, i) => {
    if (!clip?.path) throw new Error(`clip ${clip.index ?? i} has no path — refusing to build a stitch that reads "undefined" as an input`)
    inputs.push('-i', clip.path)
    const rendered = Number.isFinite(Number(clip.renderedFrames)) ? Math.round(Number(clip.renderedFrames)) : null
    const usable = Number.isFinite(Number(clip.usableFrames)) ? Math.round(Number(clip.usableFrames)) : null
    const ref = Number.isFinite(Number(clip.fps)) ? Number(clip.fps) : o.fps

    // concat needs identical fps/size/SAR on every input, so each clip is
    // normalized through the same chain before it is joined.
    const chain = []
    if (usable !== null && rendered !== null && rendered > usable) {
      chain.push(`trim=start_frame=0:end_frame=${usable}`, 'setpts=PTS-STARTPTS')
    } else if (usable !== null && rendered !== null && rendered < usable) {
      // Shorter than its window: real drift. We do not pad; we report it.
      trims.push({ index: clip.index ?? i, action: 'short', renderedFrames: rendered, usableFrames: usable, deltaFrames: rendered - usable, deltaSec: Number(((rendered - usable) / ref).toFixed(4)) })
    }
    chain.push('format=pix_fmts=yuv420p', `fps=${o.fps}`, 'setsar=1')
    filters.push(`[${i}:v]${chain.join(',')}[n${i}]`)
    normalized.push(`[n${i}]`)

    if (usable !== null && !(rendered !== null && rendered < usable)) {
      // A short clip was already recorded above with action 'short'; recording it
      // here as 'exact' would hide the drift in cmd.trims.
      trims.push({
        index: clip.index ?? i,
        action: rendered !== null && rendered > usable ? 'trim' : 'exact',
        renderedFrames: rendered,
        usableFrames: usable,
        deltaFrames: rendered === null ? null : rendered - usable,
        deltaSec: rendered === null ? null : Number(((rendered - usable) / ref).toFixed(4)),
      })
    }
  })

  inputs.push('-i', track.path)
  const audioIndex = clips.length

  // ffmpeg takes the input count from concat's n=, not from a digit before the
  // filter name: `3concat` is "No such filter: '3concat'" and the stitch dies.
  filters.push(`${normalized.join('')}concat=n=${clips.length}:v=1:a=0[cv]`)
  filters.push(`[${audioIndex}:a]apad[a]`)

  const totalUsableSec = clips.reduce((s, c) => s + (Number.isFinite(Number(c.usableFrames)) ? Number(c.usableFrames) / (Number(c.fps) || o.fps) : Number(c.usableSec ?? c.durationSec ?? 0)), 0)

  const command = [
    o.ffmpegPath, '-hide_banner', '-y',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[cv]',
    '-map', '[a]',
    '-c:v', o.videoCodec,
    '-preset', o.preset,
    '-crf', String(o.crf),
    '-pix_fmt', o.pixFmt,
    '-r', String(o.fps),
    '-c:a', o.audioCodec,
    '-b:a', o.audioBitrate,
    '-t', totalUsableSec.toFixed(4),
    '-movflags', '+faststart',
    outPath,
  ]

  // Drift is a reported fact, not a silent fix: -t cuts the shared audio to the
  // video length on purpose, and we say how far off that is.
  const trackDurationSec = Number.isFinite(Number(track.durationSec)) ? Number(track.durationSec) : null
  const drift = {
    videoSec: Number(totalUsableSec.toFixed(4)),
    trackSec: trackDurationSec,
    deltaSec: trackDurationSec === null ? null : Number((totalUsableSec - trackDurationSec).toFixed(4)),
    shortClips: trims.filter((t) => t.action === 'short'),
  }

  return {
    command,
    filterComplex: filters.join(';'),
    maps: { video: '[cv]', audio: `[${audioIndex}:a]`, audioSource: track.path },
    trims: trims.filter((t) => t.action !== 'short'),
    drift,
    totalUsableSec,
  }
}

/** ffprobe frame count / duration / fps for one rendered clip. */
export async function probeClip({ path, ffprobePath = 'ffprobe', fps = STITCH_DEFAULTS.fps } = {}) {
  const { stdout } = await runBinary(ffprobePath, [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames,r_frame_rate:format=duration',
    '-of', 'default=nokey=0:noprint_wrappers=1', path,
  ])
  const frames = /nb_read_frames=(\d+)/.exec(stdout)?.[1]
  const rate = /r_frame_rate=([\d.]+)/.exec(stdout)?.[1]
  const duration = Number(/duration=([\d.]+)/.exec(stdout)?.[1])
  return {
    path,
    frames: frames ? Number(frames) : null,
    fps: rate ? parseRate(rate) : fps,
    durationSec: Number.isFinite(duration) ? duration : null,
  }
}

function parseRate(rate) {
  const [num, den] = String(rate).split('/')
  const n = Number(num)
  const d = den === undefined ? 1 : Number(den)
  return Number.isFinite(n) && Number.isFinite(d) && d > 0 ? n / d : null
}

/**
 * Stitch rendered clips + the one shared track into the final mp4.
 * `clips` entries may carry usableFrames / renderedFrames; when they do not we
 * probe the file so the frame deltas are real numbers and not assumptions.
 */
export async function stitchClips({ clips, track, outPath, ...opts } = {}) {
  const o = { ...STITCH_DEFAULTS, ...opts }
  let prepared = clips
  if (o.probe !== false && clips.every((c) => c.usableFrames === undefined)) {
    prepared = await Promise.all(clips.map(async (c) => {
      try {
        const info = await probeClip({ path: c.path, ffprobePath: o.ffprobePath, fps: o.fps })
        const usable = Number.isFinite(Number(c.usableSec ?? c.durationSec))
          ? Math.round(Number(c.usableSec ?? c.durationSec) * (info.fps || o.fps))
          : info.frames
        return { ...c, renderedFrames: info.frames ?? undefined, usableFrames: usable, fps: info.fps || o.fps }
      } catch {
        return { ...c }
      }
    }))
  }
  const built = buildStitchCommand({ clips: prepared, track, outPath, ...o })
  await runBinary(o.ffmpegPath, built.command.slice(1))
  let sizeBytes = null
  try { sizeBytes = (await stat(outPath)).size } catch { /* caller reports */ }
  return { ...built, outPath, sizeBytes }
}

function runBinary(cmd, args) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn, arg) => { if (settled) return; settled = true; fn(arg) }
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => finish(rej, err))
    child.on('close', (code) => finish(code === 0 ? res : rej, code === 0 ? { stdout, stderr } : new Error(`${cmd} failed with code ${code}: ${stderr.slice(-1200)}`)))
  })
}
