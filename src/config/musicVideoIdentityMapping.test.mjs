// 0.4.8.6 unit tests: two-person identity mapping sentence builder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildQwenTwoPersonIdentitySentence,
  applyTwoPersonIdentityMapping,
  QWEN_KEYFRAME_EDIT_PREFIX,
} from '../config/musicVideoShotConfig.js'

test('sentence maps both labels to image indices', () => {
  const s = buildQwenTwoPersonIdentitySentence('Gearrion Ellisadel', 'Henry Lafontaine')
  assert.ok(s.startsWith('The first input image shows Gearrion Ellisadel.'))
  assert.match(s, /second input image shows Henry Lafontaine/)
  assert.match(s, /Gearrion Ellisadel comes from image 1/)
  assert.match(s, /Henry Lafontaine comes from image 2/)
})

test('empty when either label missing (single-person or location-only shots)', () => {
  assert.equal(buildQwenTwoPersonIdentitySentence('Gearrion', ''), '')
  assert.equal(buildQwenTwoPersonIdentitySentence('', 'Henry'), '')
  assert.equal(buildQwenTwoPersonIdentitySentence('', ''), '')
})

test('empty when both labels identical (same cast member in both slots)', () => {
  assert.equal(buildQwenTwoPersonIdentitySentence('Gearrion', 'gearrion'), '')
})

test('apply: no sentence -> prompt returned untouched', () => {
  const p = 'Qwen image-edit instruction: ... something'
  assert.equal(applyTwoPersonIdentityMapping(p, 'Gearrion', ''), p)
})

test('apply: prefix rewritten to plural AND sentence prepended', () => {
  const p = QWEN_KEYFRAME_EDIT_PREFIX + 'LOCATION: hallway.'
  const out = applyTwoPersonIdentityMapping(p, 'Gearrion Ellisadel', 'Henry Lafontaine')
  assert.ok(out.startsWith('The first input image shows'), 'sentence sits at HEAD (split-tested: tail placement caused text storms)')
  assert.ok(out.includes('facial identity of each person from their own input image'), 'singular prefix rewritten to plural')
  assert.ok(!out.includes('preserve ONLY the facial identity of the person in the input image'), 'no contradictory singular phrasing left')
  assert.ok(out.endsWith('LOCATION: hallway.'), 'body preserved verbatim')
})

test('apply: idempotence guard — already-mapped prompt is not double-prefixed', () => {
  const once = applyTwoPersonIdentityMapping(QWEN_KEYFRAME_EDIT_PREFIX + 'body', 'A', 'B')
  // Second call with empty labels (single-slot shot) must not alter it.
  const twice = applyTwoPersonIdentityMapping(once, 'A', '')
  assert.equal(twice, once)
})
