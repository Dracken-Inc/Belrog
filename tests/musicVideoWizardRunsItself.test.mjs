#!/usr/bin/env node
/**
 * F2 lock-in: the wizard has two distinct actions:
 * 1. "Generate Full Music Video" → musicVideoStart (full pipeline: intake → analysis → script → keyframes → videos → stitch)
 * 2. "Prepare (stop at keyframes)" → musicVideoPrepare + musicVideoResume (F2 prepare pipeline: stops at keyframes boundary)
 *
 * Both share one options builder so they cannot drift on fps/coverage/etc.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JSX = join(ROOT, 'src/components/generate/MusicVideoEasyMode.jsx')

const jsx = await readFile(JSX, 'utf8')
const startHandler = jsx.match(/const handleStartFullPipeline = async \(\) => \{[\s\S]*?\n  \}\n/)
const prepareHandler = jsx.match(/const handlePrepareMusicVideo = async \(\) => \{[\s\S]*?\n  \}\n/)
const builder = jsx.match(/const buildPipelineOptions = \(\) => \{[\s\S]*?\n  \}\n/)

test('the wizard has a Generate Full Music Video action that calls musicVideoStart', () => {
  assert.match(jsx, /Generate Full Music Video/, 'no Generate Full Music Video button on the wizard')
  assert.match(jsx, /onClick=\{handleStartFullPipeline\}/, 'Generate button is not wired to handleStartFullPipeline')
  assert.ok(startHandler, 'could not locate handleStartFullPipeline to inspect it')
  const body = startHandler[0]
  assert.match(body, /musicVideoStart\(/, 'Generate handler does not call musicVideoStart')
  assert.match(body, /buildPipelineOptions\(\)/, 'Generate handler does not use shared options builder')
  assert.ok(!/musicVideoPrepare\(/.test(body), 'Generate handler incorrectly calls musicVideoPrepare')
  assert.ok(!/musicVideoResume/.test(body), 'Generate handler incorrectly calls musicVideoResume')
})

test('the wizard has a Prepare action that stops at keyframes', () => {
  assert.match(jsx, /Prepare \(stop at keyframes\)/, 'no Prepare button on the wizard')
  assert.match(jsx, /onClick=\{handlePrepareMusicVideo\}/, 'Prepare button is not wired to handlePrepareMusicVideo')
  assert.ok(prepareHandler, 'could not locate handlePrepareMusicVideo to inspect it')
  const body = prepareHandler[0]
  assert.match(body, /musicVideoPrepare\(/, 'Prepare handler does not call musicVideoPrepare')
  assert.match(body, /musicVideoResume\?\.\(/, 'Prepare handler does not continue to musicVideoResume')
  assert.match(body, /buildPipelineOptions\(\)/, 'Prepare handler does not use shared options builder')
})

test('prepare and render share one options builder so the halves cannot drift', () => {
  assert.ok(builder, 'no shared options builder — the two IPC calls can disagree on fps')
  assert.match(builder[0], /timelineFps/, 'options builder does not carry timelineFps')
  assert.match(startHandler[0], /const options = buildPipelineOptions\(\)/, 'Generate handler builds options inline')
  assert.match(prepareHandler[0], /const options = buildPipelineOptions\(\)/, 'Prepare handler builds options inline')
})

test('resume carries options end-to-end so timeline fps survives the stop', async () => {
  const ipc = await readFile(join(ROOT, 'electron/musicVideoIpc.mjs'), 'utf8')
  const resume = ipc.match(/ipcMain\.handle\('music-video:resume'[\s\S]*?\n  \}\)/)
  assert.ok(resume, 'no music-video:resume handler found')
  assert.match(resume[0], /\{\s*songId,\s*options\s*=\s*\{\}\s*\}/, 'resume handler does not accept options')
  assert.match(resume[0], /resumeAndRender\(\{\s*songId:\s*targetSongId,\s*win,\s*options\s*\}\)/,
    'resume handler drops options before resumeAndRender — renderProjectClips then loses options.timelineFps')

  const preload = await readFile(join(ROOT, 'electron/preload.js'), 'utf8')
  assert.match(preload, /musicVideoResume:\s*\(songId,\s*options\)\s*=>\s*ipcRenderer\.invoke\('music-video:resume',\s*\{\s*songId,\s*options\s*\}\)/,
    'preload drops the options argument on resume')
})

test('the render half still goes through the GPU gate', async () => {
  const pipeline = await readFile(join(ROOT, 'src/services/musicVideoPipeline.js'), 'utf8')
  // F2 must not have bolted a render onto the wizard that bypasses BELROG_GPU_GO.
  const resumeFn = pipeline.match(/export async function resumeAndRender\([\s\S]*?\n\}/)
  assert.ok(resumeFn, 'resumeAndRender not found')
  assert.match(pipeline, /BELROG_GPU_GO/, 'the render path no longer carries the GPU go-flag gate')
})