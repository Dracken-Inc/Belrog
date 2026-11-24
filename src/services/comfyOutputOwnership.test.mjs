import assert from 'node:assert/strict'
import test from 'node:test'

import { isBelrogManagedOutput } from './comfyOutputOwnership.mjs'

// Auto-import only takes files Belrog itself asked ComfyUI to write. Which prefixes count as
// "ours" is the whole behaviour: drop one and the app silently stops importing a whole class of
// generations, keep only the old spelling and every file written by the current build is ignored.
// Output prefixes were renamed from velorn_* to belrog_* in November 2026, and files already in a
// user's ComfyUI output folder keep the old names, so the reader has to take both for as long as
// those folders exist.

test('a file Belrog wrote is recognised as its own', () => {
  for (const filename of [
    'belrog_job_1781638777571_gi3da1_00001_.mp4',
    'belrog_1781638777571_gi3da1_00001_.png',
    'belrog_music_yue2_00001_.mp3',
    'belrog_local_00001_.mp4',
    'belrog_minimax_h3_00001_.mp4',
  ]) {
    assert.equal(isBelrogManagedOutput({ filename }), true, `${filename} should be imported`)
  }
})

test('names from before the rename still import', () => {
  for (const filename of [
    'velorn_job_1778281499142_lyp476_00001_.mp3',
    'velorn_1781119590708_6k0nom_00001_.png',
    'velorn_music_ace_00001_.mp3',
    'velorn_local_00001_.mp4',
  ]) {
    assert.equal(isBelrogManagedOutput({ filename }), true, `${filename} is already on someone's disk`)
  }
})

test("someone else's renders are left alone", () => {
  for (const filename of [
    'holiday.mp4',
    'ComfyUI_00001_.mp4',
    'videoprom_1_00001_.mp4',
    'my_belrog_ish_project.mp4',
  ]) {
    assert.equal(isBelrogManagedOutput({ filename }), false, `${filename} is not ours`)
  }
})

test('a missing or odd file description is not managed', () => {
  assert.equal(isBelrogManagedOutput(undefined), false)
  assert.equal(isBelrogManagedOutput({}), false)
  assert.equal(isBelrogManagedOutput({ filename: null }), false)
})
