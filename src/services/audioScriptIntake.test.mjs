import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIO_INTAKE_MIN_SECONDS,
  buildScriptFromAudioProbe,
  countScriptShots,
  describeAudioIntake,
  previewAudioTiling,
} from './audioScriptIntake.mjs'

const LRC = [
  '[00:00.00] intro hum',
  '[00:06.00] first line of the song',
  '[00:12.00] second line lands here',
  '[00:19.50] third line closes it',
].join('\n')

test('a track with timed lyrics yields a gapless script', () => {
  const result = buildScriptFromAudioProbe({ durationSec: 24, title: 'Test Track', lyricsRaw: LRC })
  assert.ok(result.shotCount >= 4, `expected at least 4 shots, got ${result.shotCount}`)
  assert.equal(result.hasLyrics, true)
  assert.match(result.script, /^BELROG DIRECTOR SCRIPT/)
  assert.match(result.script, /Seed base: \d+\./)
  assert.equal(countScriptShots(result.script), result.shotCount)
})

test('a track without lyrics still tiles and says so', () => {
  const result = buildScriptFromAudioProbe({ durationSec: 30, title: 'Instrumental', lyricsRaw: '' })
  assert.ok(result.shotCount > 0)
  assert.equal(result.hasLyrics, false)
  assert.match(describeAudioIntake(result), /timing only/)
  assert.doesNotMatch(result.script, /\[No lyric\]/, 'no-lyric shots should not pretend a lyric exists')
})

test('the same file twice gives the same script', () => {
  const probe = { durationSec: 24, title: 'Test Track', lyricsRaw: LRC }
  assert.equal(buildScriptFromAudioProbe(probe).script, buildScriptFromAudioProbe(probe).script)
})

test('short files are refused with a reason, not an empty script', () => {
  assert.throws(
    () => buildScriptFromAudioProbe({ durationSec: AUDIO_INTAKE_MIN_SECONDS - 1, title: 'blip' }),
    /too short/,
  )
  assert.throws(() => buildScriptFromAudioProbe({ durationSec: 0 }), /no readable duration/)
})

test('the preview shows the same tiling the script uses', () => {
  const probe = { durationSec: 24, title: 'Test Track', lyricsRaw: LRC }
  const preview = previewAudioTiling(probe)
  assert.deepEqual(preview.issues, [])
  assert.equal(preview.shots.length, buildScriptFromAudioProbe(probe).shotCount)
  const last = preview.shots[preview.shots.length - 1]
  assert.equal(Math.round(last.startSec + last.seconds), 24)
})

test('describeAudioIntake reads like a sentence a person would say', () => {
  const line = describeAudioIntake({ durationSec: 185, shotCount: 31, hasLyrics: true })
  assert.match(line, /^31 shots across 3m 05s/)
  assert.match(line, /lyric timing/)
})
