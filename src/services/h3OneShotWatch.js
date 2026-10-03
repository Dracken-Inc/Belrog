/**
 * H3 ONE-SHOT watcher — chain progress from on-disk truth.
 *
 * Ground truth for the progress bar is the FILESYSTEM: the auto-chain addon
 * writes video/<chain>_clip_NNN.mp4 per clip and video/<chain>.mp4 on stitch.
 * This module is pure-ish: the caller injects an fs adapter so it is testable
 * offline and usable from both renderer (via IPC) and the headless runner.
 *
 * fsAdapter: { listDir(dir): string[], statMtime(path): number|null, readFile(path): string|null }
 */

export const CHAIN_VIDEO_SUBDIR = 'video'
export const CLIP_FILE_RE = /^(.*)_clip_(\d{3,})\.mp4$/
export const FINAL_FILE_RE = /^(.*)\.mp4$/

export function parseClipFiles(fileNames, chainId) {
  const done = []
  for (const name of fileNames || []) {
    const m = CLIP_FILE_RE.exec(name)
    if (m && m[1] === chainId) done.push(parseInt(m[2], 10))
  }
  return done.sort((a, b) => a - b)
}

export function hasStitchedFinal(fileNames, chainId) {
  return (fileNames || []).some((n) => FINAL_FILE_RE.exec(n)?.[1] === chainId)
}

/**
 * Derive a chain progress snapshot from disk.
 * Returns { clipsDone:[...], missing:[...], totalPlanned, final:boolean, stalled:boolean }
 * stalled = no clip file mtime changed within stallSeconds (chain died with
 * clips still missing → resume needed).
 */
export function chainProgress({ fsAdapter, videoDir, chainId, clipsTotal, now = Date.now(), stallSeconds = 2400 }) {
  const files = fsAdapter.listDir(videoDir) || []
  const clipsDone = parseClipFiles(files, chainId)
  const final = hasStitchedFinal(files, chainId)
  const missing = []
  for (let i = 1; i <= clipsTotal; i += 1) if (!clipsDone.includes(i)) missing.push(i)
  let newest = 0
  for (const i of clipsDone) {
    // seconds and milliseconds both appear in the wild (fs mtime vs Date.now
    // adapters); normalize epoch-seconds to ms before comparing to `now`.
    let t = fsAdapter.statMtime(`${videoDir}/${chainId}_clip_${String(i).padStart(3, '0')}.mp4`)
    if (t && t < 1e12) t *= 1000
    if (t && t > newest) newest = t
  }
  const stalled = !final && clipsDone.length < clipsTotal && newest > 0 && (now - newest) > stallSeconds * 1000
  return { clipsDone, missing, totalPlanned: clipsTotal, final, stalled, newestMtime: newest }
}

/**
 * Decide the resume action after a stall or failure.
 * Sparse-chain rule: re-queue from the first missing clip with reset=true —
 * existing clip files are untouched and get stitched in.
 */
export function resumeDecision(progress) {
  if (progress.final) return { action: 'none' }
  if (progress.missing.length === 0) return { action: 'stitch-only' }
  return { action: 'resume', startClip: progress.missing[0], reset: true }
}

/**
 * Structured log lines this watcher writes to the ONE-SHOT log file.
 * Keep machine-parseable: `ISO_LEVEL component message` — the offline tail
 * script and the app share the same format.
 */
export function formatLogLine(level, component, message, ts = new Date().toISOString()) {
  return `${ts} ${String(level).toUpperCase().padEnd(5)} [${component}] ${message}`
}

export function clipProgressPercent(clipsDone, clipsTotal) {
  if (!clipsTotal) return 0
  return Math.min(100, Math.round((clipsDone / clipsTotal) * 100))
}
