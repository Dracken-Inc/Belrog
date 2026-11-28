/**
 * Source-contract test for the 0.6.1 one-file music-video flow.
 *
 * The pieces live in React components that no unit test can mount here, and
 * the failure mode we are guarding against is silent: a renamed callback or a
 * prop that stops being passed leaves the button in place while the data behind
 * it goes stale (the 0.5.0 bug — the button probed a file picked at click time
 * instead of the song loaded in step 1).
 *
 * These checks read the shipped source, so they fail the moment the wiring is
 * removed. They are CONTROL checks by construction: delete the prop and this
 * goes red.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

const easyMode = read('src/components/generate/MusicVideoEasyMode.jsx')
const workspace = read('src/components/GenerateWorkspace.jsx')
const main = read('electron/main.js')

test('the script step builds from the loaded song, not a click-time picker', () => {
  const handler = /const handleScriptFromAudio = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\)/.exec(easyMode)
  assert.ok(handler, 'handleScriptFromAudio is gone — the button no longer builds a script')
  const body = handler[0]
  assert.match(body, /onBuildScriptFromTrack\(\)/, 'the injected builder must be what runs')
  assert.ok(!/pickAudioTrack/.test(body), 'a second file picker would time a different song than the one in step 1')
  assert.match(body, /setYoloMusicScript\(result\.script\)/, 'the built script must land in the shared script state')
})

test('GenerateWorkspace actually passes the builder down', () => {
  assert.match(
    workspace,
    /onBuildScriptFromTrack=\{handleBuildMusicVideoScriptFromTrack\}/,
    'the prop is not passed, so the button falls back to "not connected"',
  )
  const builder = /const handleBuildMusicVideoScriptFromTrack = useCallback\([\s\S]*?\n  \}, [\s\S]*?\]\)/.exec(workspace)
  assert.ok(builder, 'the builder callback is missing')
  const body = builder[0]
  assert.match(body, /buildScriptFromTrack\(\{/, 'it must go through the tested intake service')
  assert.match(body, /yoloMusicAudioAsset/, 'it must read the step-1 song asset')
  assert.match(body, /lyricsText: yoloMusicLyrics/, 'step-1 lyrics/SRT must reach the generator')
  assert.match(body, /providedLyrics: yoloMusicProvidedLyrics/)
  assert.match(body, /cast: /, 'the cast roster must reach the script legend')
  assert.match(body, /absolutePath/, 'the asset must be resolved to its on-disk file')
})

test('a script name without an image yet still shows in the cast summary', () => {
  // yoloMusicResolvedCast only holds entries that already have an image. The
  // brief must show the rest as "to be cast" instead of dropping them, or a
  // name the script plainly names looks like it was never in the video.
  assert.match(easyMode, /const castSummary = useMemo\(/, 'the roster-aware cast summary is gone')
  assert.match(easyMode, /\(to be cast\)/)
  assert.match(easyMode, /Cast:<\/span> \{castSummary \|\| 'No cast yet'\}/, 'the brief must use the roster summary')
})

test('the audio intake service is the only place that decides lyrics', () => {
  const intake = read('src/services/musicVideoTrackIntake.mjs')
  assert.match(intake, /export function resolveTrackLyrics/, 'lyric ranking lives in one function')
  assert.match(intake, /lyricSource: 'timed'/, 'timed lyrics from step 1 win')
  assert.match(intake, /no lyrics — cutting on the clock only/, 'no lyrics must be stated, not invented')
  assert.ok(!/Math\.random/.test(intake), 'intake is deterministic')
})

test('the probe accepts the containers a song file actually comes in', () => {
  const picker = /ipcMain\.handle\('belrog:pickAudioTrack'[\s\S]*?\n\}\)/.exec(main)
  assert.ok(picker, 'pickAudioTrack handler is missing')
  for (const ext of ['mp4', 'mov', 'm4a', 'mp3']) {
    assert.ok(picker[0].includes(`'${ext}'`), `the picker must accept .${ext} — Suno drops video containers`)
  }
  assert.match(main, /require\('\.\/audioTrackProbe'\)/, 'main must use the shared, tested probe parser')
})

test('MusicVideoEasyMode wires the one-shot pipeline start', () => {
  assert.match(easyMode, /window\.electronAPI\.musicVideoStart\(/, 'musicVideoStart call is missing')
  assert.match(easyMode, /yoloMusicAudioAssetPath/, 'audio asset path must reach the start call')
  assert.match(easyMode, /aspectRatio/, 'options must include aspectRatio')
  assert.match(easyMode, /resolutionPreset/, 'options must include resolutionPreset')
  assert.match(easyMode, /videoFps/, 'options must include videoFps')
  assert.match(easyMode, /coveragePreset/, 'options must include coveragePreset')
  assert.match(easyMode, /videoWorkflowId/, 'options must include videoWorkflowId')
  assert.match(easyMode, /keyframeWorkflowId/, 'options must include keyframeWorkflowId')
  assert.match(easyMode, /styleNotes/, 'options must include styleNotes')
  assert.match(easyMode, /lyrics/, 'options must include lyrics')
  assert.match(easyMode, /script/, 'options must include script')
  assert.match(easyMode, /cast/, 'options must include cast')
})

test('MusicVideoEasyMode subscribes to pipeline progress events', () => {
  assert.match(easyMode, /onMusicVideoProgress\(/, 'onMusicVideoProgress listener is missing')
  assert.match(easyMode, /onMusicVideoShotDone\(/, 'onMusicVideoShotDone listener is missing')
  assert.match(easyMode, /onMusicVideoVideoReady\(/, 'onMusicVideoVideoReady listener is missing')
  assert.match(easyMode, /onMusicVideoError\(/, 'onMusicVideoError listener is missing')
  assert.match(easyMode, /useEffect\(\s*\(\) => \{[\s\S]*?onMusicVideoProgress/, 'listeners must be in a useEffect')
  assert.match(easyMode, /return \(\) => \{[\s\S]*?cleanupProgress\(\)/, 'cleanup function must remove listeners')
})

test('GenerateWorkspace passes the resolved audio asset path', () => {
  assert.match(workspace, /yoloMusicAudioAssetPath=\{yoloMusicAudioAssetPath\}/, 'resolved audio path prop is not passed')
  assert.match(workspace, /useEffect\(\s*\(\) => \s*\{[\s\S]*?async function resolvePath/, 'workspace must resolve the path via electronAPI.pathJoin')
})