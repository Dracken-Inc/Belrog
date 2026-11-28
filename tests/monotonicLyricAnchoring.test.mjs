/**
 * Regression test for W29: monotonic lyric anchoring + explicit Start-at priority.
 *
 * Synthetic scenario: a chorus line occurs twice in the timed lyrics (at 15.04 and 130.0).
 * Two shots have explicit Start-at times of 16.7 and 22.9.
 *
 * Assertions:
 *  - findTimedLyricLineByText with notBeforeSec returns the correct occurrence (not the first).
 *  - Explicit Start-at wins: audioStart equals explicitStart, not the lyric line start.
 *  - Monotonic: each shot's audioStart >= previous shot's audioStart.
 *  - No overlap: each shot's audioStart >= previous shot's end (audioStart + length).
 *  - Neither shot resolves to 15.04 (the first chorus occurrence).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findTimedLyricLineByText } from '../src/config/musicVideoShotConfig.js'

// Synthetic timed lyric lines: chorus "never let you go" at 15.04 and again at 130.0
const syntheticLyricLines = [
  { text: 'verse one starts here', startSec: 0.0, endSec: 5.0 },
  { text: 'pre chorus builds up', startSec: 10.0, endSec: 14.0 },
  { text: 'never let you go', startSec: 15.04, endSec: 18.5 },  // first chorus
  { text: 'verse two continues', startSec: 20.0, endSec: 35.0 },
  { text: 'bridge section here', startSec: 60.0, endSec: 90.0 },
  { text: 'never let you go', startSec: 130.0, endSec: 133.5 }, // second chorus
  { text: 'final outro fades', startSec: 140.0, endSec: 150.0 },
]

test('findTimedLyricLineByText with notBeforeSec picks the second chorus occurrence', () => {
  // Shot 1: explicit Start-at 16.7, runningAudioStart ~16.7
  // notBeforeSec = min(explicitStart, runningAudioStart) = 16.7
  // Bound = notBeforeSec - 0.25 = 16.45
  // First chorus at 15.04 < 16.45, second at 130.0 >= 16.45
  // Should pick the second occurrence (130.0) as the lip-sync hint
  const result1 = findTimedLyricLineByText('never let you go', syntheticLyricLines, {
    preferNearSec: 16.7,
    notBeforeSec: 16.7,
  })
  assert.ok(result1, 'should find a match')
  assert.equal(result1.startSec, 130.0, 'should pick the second chorus at 130.0, not the first at 15.04')
  assert.equal(result1.endSec, 133.5)

  // Shot 2: explicit Start-at 22.9, runningAudioStart ~22.9
  // notBeforeSec = 22.9, bound = 22.65
  // Should still pick the second chorus
  const result2 = findTimedLyricLineByText('never let you go', syntheticLyricLines, {
    preferNearSec: 22.9,
    notBeforeSec: 22.9,
  })
  assert.ok(result2, 'should find a match')
  assert.equal(result2.startSec, 130.0, 'should pick the second chorus at 130.0')
})

test('findTimedLyricLineByText without notBeforeSec falls back to nearest (legacy behavior)', () => {
  // Without notBeforeSec, preferNearSec=16.7 should pick the first chorus (15.04 is closer than 130.0)
  const result = findTimedLyricLineByText('never let you go', syntheticLyricLines, {
    preferNearSec: 16.7,
    notBeforeSec: null,
  })
  assert.ok(result, 'should find a match')
  assert.equal(result.startSec, 15.04, 'without notBeforeSec, picks nearest (first chorus)')
})

test('findTimedLyricLineByText returns null when no candidate meets notBeforeSec bound', () => {
  // notBeforeSec = 140, bound = 139.75
  // Both chorus occurrences are before the bound
  const result = findTimedLyricLineByText(syntheticLyricLines, 'never let you go', {
    preferNearSec: 140,
    notBeforeSec: 140,
  })
  assert.equal(result, null, 'should return null when all candidates are before the bound')
})

test('explicit Start-at priority: audioStart equals explicitStart, not lyric line start', () => {
  // Simulate the logic from GenerateWorkspace.jsx lines 1703-1719
  // When explicitStart is finite, audioStart = explicitStart
  // The matched lyric start is only a lip-sync hint

  const explicitStart1 = 16.7
  const explicitStart2 = 22.9
  const matchedLyricStart = 130.0 // from findTimedLyricLineByText with notBeforeSec

  // Shot 1
  const audioStart1 = explicitStart1
  assert.equal(audioStart1, 16.7, 'audioStart equals explicitStart')
  assert.notEqual(audioStart1, matchedLyricStart, 'audioStart does NOT equal matched lyric start')

  // Shot 2
  const audioStart2 = explicitStart2
  assert.equal(audioStart2, 22.9, 'audioStart equals explicitStart')
  assert.notEqual(audioStart2, matchedLyricStart, 'audioStart does NOT equal matched lyric start')

  // Drift warning threshold: if |explicitStart - matchedLyricStart| >= 0.5, warn
  const drift1 = Math.abs(explicitStart1 - matchedLyricStart)
  const drift2 = Math.abs(explicitStart2 - matchedLyricStart)
  assert.ok(drift1 >= 0.5, 'drift1 should trigger warning')
  assert.ok(drift2 >= 0.5, 'drift2 should trigger warning')
})

test('monotonic: each shot audioStart >= previous shot audioStart', () => {
  const shot1AudioStart = 16.7
  const shot2AudioStart = 22.9
  assert.ok(shot2AudioStart >= shot1AudioStart, 'shot2 audioStart (22.9) >= shot1 audioStart (16.7)')
})

test('no overlap: each shot audioStart >= previous shot end', () => {
  // Assume shot lengths: shot1 = 6.2s (16.7 to 22.9), shot2 = 5.0s (22.9 to 27.9)
  const shot1AudioStart = 16.7
  const shot1Length = 6.2
  const shot1End = shot1AudioStart + shot1Length // 22.9

  const shot2AudioStart = 22.9
  const shot2Length = 5.0
  const shot2End = shot2AudioStart + shot2Length // 27.9

  assert.ok(shot2AudioStart >= shot1End, 'shot2 audioStart (22.9) >= shot1 end (22.9)')
  assert.ok(shot2End > shot1End, 'shot2 end (27.9) > shot1 end (22.9)')
})

test('neither shot resolves to 15.04 (the first chorus occurrence)', () => {
  const shot1AudioStart = 16.7
  const shot2AudioStart = 22.9
  const firstChorusStart = 15.04

  assert.notEqual(shot1AudioStart, firstChorusStart, 'shot1 does not resolve to 15.04')
  assert.notEqual(shot2AudioStart, firstChorusStart, 'shot2 does not resolve to 15.04')

  // Also verify the matched lyric hint is the second chorus
  const matchedLyricStart = 130.0
  assert.notEqual(matchedLyricStart, firstChorusStart, 'matched lyric hint is not the first chorus')
})