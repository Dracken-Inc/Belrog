/**
 * ffprobe half of the Suno intake, kept in its own module so the renderer can
 * import the pure tiling code (sunoIntake.js) without dragging node:child_process
 * into the browser bundle. Node and the CLI use this side.
 */
import { spawnSync } from 'node:child_process'

/** ffprobe a track: duration + lyrics tag (LRC-timed or plain). */
export function probeSunoTrack(path, { ffprobeBin = 'ffprobe' } = {}) {
  const res = spawnSync(ffprobeBin, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', path,
  ], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`ffprobe failed on ${path}: ${res.stderr || res.status}`)
  const fmt = JSON.parse(res.stdout || '{}')?.format
  if (!fmt?.tags) throw new Error(`ffprobe returned no format tags for ${path}`)
  const durationSec = Number(fmt.duration)
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error(`bad duration on ${path}`)
  const lyricsRaw = fmt.tags.lyrics || fmt.tags.LYRICS || fmt.tags.podcast_chapter_synched_lyrics || ''
  return {
    durationSec,
    title: fmt.tags.title || '',
    lyricsRaw: String(lyricsRaw),
  }
}
