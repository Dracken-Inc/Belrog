/**
 * Audio → director script intake for the one-shot test path (0.5.0).
 *
 * One input: an audio file the user already owns (Suno download, demo, voice
 * memo). Two things come out: the clock (duration, from ffprobe) and the lyric
 * text, when the file carries it. `sunoIntake` turns those into a tiled
 * director script whose shots cover the track exactly, with no gaps.
 *
 * This wrapper exists so the renderer, the CLI and the tests all agree on the
 * same rules: refuse a track too short to cut, never invent lyrics, and report
 * what the script actually contains instead of claiming success.
 */
import { generateSunoScript, parseLyricBlocks, tileShots, auditTiling } from './sunoIntake.js'

export const AUDIO_INTAKE_MIN_SECONDS = 3.5
export const AUDIO_INTAKE_TARGET_SHOT_SECONDS = 5

export function countScriptShots(script) {
  return (String(script || '').match(/^Shot \d+:/gm) || []).length
}

/**
 * Probe result from the main process (belrog:probeAudioTrack) plus optional
 * style/target options → { script, shotCount, hasLyrics, durationSec, title }.
 * Throws with a readable reason when the track cannot be tiled.
 */
export function buildScriptFromAudioProbe(probe, options = {}) {
  const durationSec = Number(probe?.durationSec)
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('That file has no readable duration.')
  }
  if (durationSec < AUDIO_INTAKE_MIN_SECONDS) {
    throw new Error(`That track is ${durationSec.toFixed(1)}s — too short to cut into one-shot clips.`)
  }
  const lyricsRaw = String(probe?.lyricsRaw || '')
  const script = generateSunoScript({
    durationSec,
    lyricsRaw,
    style: options.style || '',
    targetSec: Number(options.targetSec) || AUDIO_INTAKE_TARGET_SHOT_SECONDS,
    seedBase: options.seedBase,
    title: String(probe?.title || ''),
  })
  const shotCount = countScriptShots(script)
  if (!shotCount) throw new Error('The script came back empty — nothing to generate.')
  return {
    script,
    shotCount,
    hasLyrics: Boolean(lyricsRaw.trim()),
    durationSec,
    title: String(probe?.title || ''),
  }
}

/**
 * The shot table the UI shows before anything is generated. Same tiling math as
 * the script, so what the user approves is what the engine receives.
 */
export function previewAudioTiling(probe, options = {}) {
  const durationSec = Number(probe?.durationSec)
  if (!Number.isFinite(durationSec) || durationSec <= 0) return { shots: [], issues: [{ kind: 'empty', message: 'no duration' }] }
  const blocks = parseLyricBlocks(String(probe?.lyricsRaw || ''), durationSec)
  const shots = tileShots(blocks, durationSec, { targetSec: Number(options.targetSec) || AUDIO_INTAKE_TARGET_SHOT_SECONDS })
  return { shots, issues: auditTiling(shots, durationSec) }
}

/** One line for a status bar. Plain language, no counts the user cannot see. */
export function describeAudioIntake(result) {
  if (!result) return ''
  const minutes = Math.floor(result.durationSec / 60)
  const seconds = Math.round(result.durationSec - minutes * 60)
  const length = minutes ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`
  const source = result.hasLyrics ? 'with lyric timing from the file' : 'timing only — add lyrics for better beats'
  return `${result.shotCount} shots across ${length}, ${source}.`
}
