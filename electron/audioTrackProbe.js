/**
 * ffprobe → the fields the song intake needs (electron/main.js's probe).
 *
 * Split out of main.js so the container/stream duration rules are testable:
 * an mp4 whose muxer leaves the container duration blank used to fail with
 * "could not read a duration" even though the file was fine.
 */
const path = require('node:path')

const LYRIC_TAG_KEYS = ['lyrics', 'unsyncedlyrics', 'podcast_chapter_synched_lyrics']

function numberOrNaN(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
}

/**
 * @param {string} stdout raw `ffprobe -print_format json -show_format -show_streams` output
 * @param {string} filePath the file that was probed (for the title fallback)
 * @returns {{ ok: true, durationSec, title, lyricsRaw, fileName, hasAudio } | { ok: false, error }}
 */
function parseProbeOutput(stdout, filePath) {
  let parsed = null
  try {
    parsed = JSON.parse(String(stdout || '{}'))
  } catch (_) {
    parsed = null
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'ffprobe returned something unreadable.' }
  }
  const fmt = parsed.format && typeof parsed.format === 'object' ? parsed.format : {}
  const streams = Array.isArray(parsed.streams) ? parsed.streams : []
  // Container duration first, then the longest stream. Matroska/QuickTime
  // muxers put the duration on the streams and leave the container blank.
  const candidates = [numberOrNaN(fmt.duration), ...streams.map((s) => numberOrNaN(s && s.duration))]
  const durationSec = candidates.find((n) => Number.isFinite(n) && n > 0)
  if (!Number.isFinite(durationSec)) {
    return { ok: false, error: 'ffprobe could not read a duration from that file.' }
  }
  const tags = fmt.tags && typeof fmt.tags === 'object' ? fmt.tags : {}
  const pick = (wanted) => {
    const key = Object.keys(tags).find((k) => k.toLowerCase() === wanted)
    return key ? String(tags[key] || '') : ''
  }
  const fileName = path.basename(String(filePath || ''))
  return {
    ok: true,
    durationSec,
    title: pick('title') || path.basename(fileName, path.extname(fileName)),
    lyricsRaw: LYRIC_TAG_KEYS.map(pick).find((value) => value.trim()) || '',
    fileName,
    hasAudio: streams.some((s) => s && s.codec_type === 'audio'),
  }
}

module.exports = { parseProbeOutput }
