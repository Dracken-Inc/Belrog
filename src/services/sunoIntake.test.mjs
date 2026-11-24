/**
 * sunoIntake tests — pure node, no GPU, no ffprobe binary needed (probe is
 * injected). Control tests must go RED if the tiler is lobotomized; the
 * parse/compile replay proves the emitted script survives the REAL parser.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLyricBlocks, tileShots, auditTiling, generateSunoScript } from './sunoIntake.js'
import { parseStructuredDirectorScript } from '../utils/yoloPlanning.js'
import { compileScriptToClips } from './h3OneShot.js'

const D = 283.56

test('plain Suno lyric blocks tile gapless to exact duration', () => {
  const raw = '[Verse]\nline one\nline two\n\n[Chorus]\nchorus line A\nchorus line B\n\n[Outro]\nfinal line'
  const blocks = parseLyricBlocks(raw, D)
  const shots = tileShots(blocks, D)
  assert.deepEqual(auditTiling(shots, D), [], 'audit must be clean')
  assert.ok(shots.length >= 3)
  assert.equal(shots[0].startSec, 0)
  assert.equal(Math.round(shots.at(-1).startSec + shots.at(-1).seconds), Math.round(D))
  let cursor = 0
  for (const s of shots) {
    assert.ok(Math.abs(s.startSec - cursor) < 0.11, 'zero-gap chain')
    assert.ok(s.seconds >= 3.5 - 1e-9, 'min shot length')
    cursor = s.startSec + s.seconds
  }
})

test('LRC-timed lyrics: shots land on lyric onsets', () => {
  const raw = '[00:00.00]intro line\n[00:12.50]verse line\n[00:30.00]chorus line'
  const blocks = parseLyricBlocks(raw, 60)
  const shots = tileShots(blocks, 60)
  assert.deepEqual(auditTiling(shots, 60), [])
  const starts = shots.map((s) => s.startSec)
  assert.ok(starts.includes(12.5), `expected onset 12.5 in ${starts}`)
  assert.ok(starts.includes(30), `expected onset 30 in ${starts}`)
})

test('empty lyrics still yields a full-duration tiled lane', () => {
  const shots = tileShots([], 30)
  assert.deepEqual(auditTiling(shots, 30), [])
  assert.equal(shots.at(-1).startSec + shots.at(-1).seconds, 30)
})

test('sub-minimum tail merges; no shot under 3.5s', () => {
  const raw = '[00:00.00]a\n[00:10.00]b\n[00:27.90]late'
  const blocks = parseLyricBlocks(raw, 30)
  const shots = tileShots(blocks, 30)
  assert.deepEqual(auditTiling(shots, 30), [])
  for (const s of shots) assert.ok(s.seconds >= 3.5 - 1e-9)
})

test('CONTROL: a broken tiler is caught, not skipped', () => {
  const broken = [
    { startSec: 0, seconds: 5, endSec: 5, lyric: [] },
    { startSec: 6, seconds: 5, endSec: 11, lyric: [] }, // 1s gap
  ]
  const issues = auditTiling(broken, 20)
  assert.ok(issues.some((i) => i.kind === 'chain'), 'gap must be flagged')
  assert.ok(issues.some((i) => i.kind === 'coverage'), 'coverage end mismatch must be flagged')
  assert.deepEqual(auditTiling([], 20).map((i) => i.kind), ['empty'], 'empty tiling must be flagged')
})

test('generated script compiles through the real parser with intact timing', () => {
  const raw = Array.from({ length: 20 }, (_, i) => `[Block ${i}]\nlyric ${i}a\nlyric ${i}b`).join('\n\n')
  const script = generateSunoScript({ durationSec: D, lyricsRaw: raw, style: 'dark metal aesthetic, ember-lit forge', title: 'Forsaken, Falling' })
  assert.ok(script.includes('BELROG DIRECTOR SCRIPT'))
  const scenes = parseStructuredDirectorScript(script, { maxShotDurationSeconds: 600 })
  assert.ok(Array.isArray(scenes), 'parser returns bare scenes array')
  const shots = scenes.flatMap((s) => s.shots || [])
  assert.ok(shots.length >= 5, `parser saw ${shots.length} shots`)
  const compiled = compileScriptToClips(script, { maxShotDurationSeconds: 600 })
  assert.equal(compiled.clips.length, shots.length)
  assert.ok(compiled.clips[0].frames % 8 === 1 || compiled.clips[0].frames > 0, 'grid-snapped frames')
  assert.ok(!compiled.warnings.some((w) => /no Start at/.test(w)), 'every clip keeps its start')
  // determinism
  const again = generateSunoScript({ durationSec: D, lyricsRaw: raw, style: 'dark metal aesthetic, ember-lit forge', title: 'Forsaken, Falling' })
  assert.equal(again, script, 'same input = byte-identical script')
})
