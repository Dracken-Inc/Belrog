/**
 * Song file → director-script skeleton, in one step.
 *
 * The rules this file exists to enforce:
 *  1. The song is the file the user already loaded in step 1. A second file
 *     picker is a bug: it lets you time one song and generate another.
 *  2. Lyric timing comes from the best source that actually exists, in this
 *     order — timed lyrics the app already produced (SRT/LRC from ASR), the
 *     file's own lyric tags, pasted plain lyrics, nothing. A Suno download
 *     carries no lyric tags, so "read the file" alone is not a plan.
 *  3. The output says where its lyrics came from. "Timing only" is a real
 *     answer; claiming lyric timing the app never measured is not.
 *
 * Pure apart from the injected `api` (window.electronAPI), so the whole chain
 * is testable without Electron.
 */
import { buildScriptFromAudioProbe } from './audioScriptIntake.mjs'
import { detectTimedLyricsFormat, parseTimedLyrics } from '../config/musicVideoShotConfig.js'

const ABSOLUTE_PATH_RE = /^(?:[a-zA-Z]:[\\/]|[\\/]|\\\\)/

/** @returns true when a path can be handed to ffprobe on this machine. */
export function isProbeablePath(value) {
  const text = String(value || '').trim()
  if (!text || /^(blob|file|https?):/i.test(text)) return false
  return ABSOLUTE_PATH_RE.test(text)
}

/** The file ffprobe should read, or null when the asset has no on-disk path. */
export function resolveTrackFilePath(asset) {
  for (const candidate of [asset?.absolutePath, asset?.path, asset?.settings?.absolutePath]) {
    if (isProbeablePath(candidate)) return String(candidate).trim()
  }
  return null
}

/** "D:\Music\song.m4a" → "song.m4a", for status lines. */
export function fileNameFromPath(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] || text
}

/**
 * Timed lyric lines → the LRC shape sunoIntake times against. Keeping the real
 * start times is the entire point: an untimed lyric list gets spread evenly
 * over the song, which is a guess about where the words are.
 */
export function timedLyricsToLrc(lines = [], { limit = Infinity } = {}) {
  const out = []
  for (const line of Array.isArray(lines) ? lines : []) {
    if (out.length >= limit) break
    const start = Number(line?.startSec)
    const text = String(line?.text || '').trim()
    if (!Number.isFinite(start) || start < 0 || !text) continue
    const m = Math.floor(start / 60)
    const s = start - m * 60
    out.push(`[${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}]${text}`)
  }
  return out.join('\n')
}

/**
 * Decide which lyrics the skeleton should time against.
 * @returns {{ lyricsRaw: string, lyricSource: 'timed'|'file'|'pasted'|'none', timed: boolean, note: string }}
 */
export function resolveTrackLyrics({ fileLyricsRaw = '', lyricsText = '', providedLyrics = '' } = {}) {
  const timedFormat = detectTimedLyricsFormat(lyricsText)
  if (timedFormat === 'srt' || timedFormat === 'lrc') {
    const parsed = parseTimedLyrics(lyricsText)
    const lrc = timedLyricsToLrc(parsed.lines)
    if (lrc) {
      return {
        lyricsRaw: lrc,
        lyricSource: 'timed',
        timed: true,
        note: `${parsed.lines.length} timed lyric lines from step 1`,
      }
    }
  }
  if (String(fileLyricsRaw || '').trim()) {
    return {
      lyricsRaw: String(fileLyricsRaw),
      lyricSource: 'file',
      timed: false,
      note: 'lyrics read from the file',
    }
  }
  if (String(lyricsText || '').trim()) {
    return {
      lyricsRaw: String(lyricsText),
      lyricSource: 'pasted',
      timed: false,
      note: 'untimed lyrics from step 1 — spread across the song',
    }
  }
  if (String(providedLyrics || '').trim()) {
    return {
      lyricsRaw: String(providedLyrics),
      lyricSource: 'pasted',
      timed: false,
      note: 'untimed lyrics from step 1 — spread across the song',
    }
  }
  return { lyricsRaw: '', lyricSource: 'none', timed: false, note: 'no lyrics — cutting on the clock only' }
}

/**
 * Full intake. `api` is window.electronAPI (probeAudioTrack / pickAudioTrack).
 * Returns the script plus what it was built from. Throws a readable Error when
 * no file could be read.
 */
export async function buildScriptFromTrack({
  asset = null,
  filePath: directFilePath = '',
  api = null,
  lyricsText = '',
  providedLyrics = '',
  cast = [],
  style = '',
  targetSec,
  confirmReplace,
} = {}) {
  if (!api || typeof api.probeAudioTrack !== 'function') {
    throw new Error('Reading a track needs the desktop app.')
  }
  let filePath = isProbeablePath(directFilePath) ? String(directFilePath).trim() : resolveTrackFilePath(asset)
  let origin = 'asset'
  if (!filePath && typeof api.pickAudioTrack === 'function' && confirmReplace) {
    const picked = await api.pickAudioTrack()
    if (!picked) return { cancelled: true }
    filePath = String(picked)
    origin = 'picked'
  }
  if (!filePath) {
    throw new Error('No song file to read. Import the track in step 1 first.')
  }
  const probe = await api.probeAudioTrack(filePath)
  if (!probe?.ok) throw new Error(probe?.error || 'That file could not be read.')

  const lyrics = resolveTrackLyrics({
    fileLyricsRaw: probe.lyricsRaw,
    lyricsText,
    providedLyrics,
  })
  const result = buildScriptFromAudioProbe(probe, {
    style,
    targetSec,
    lyricsRaw: lyrics.lyricsRaw,
    lyricSource: lyrics.lyricSource,
    lyricsTimed: lyrics.timed,
    cast,
  })
  return { ...result, filePath, fileName: fileNameFromPath(filePath), origin, lyricNote: lyrics.note, timed: lyrics.timed }
}
