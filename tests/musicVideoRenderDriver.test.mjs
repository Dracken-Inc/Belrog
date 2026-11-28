/**
 * Render-driver tests: the seam between plan.json and ComfyUI.
 *
 * No GPU, no network, no ComfyUI — a fake client that answers like ComfyUI
 * (queue → history poll → downloadable output) and real files on disk. What is
 * being proven is the driver's own laws: clip-centric work, resume without
 * re-paying for the GPU, shot-state mapping, and stitch inputs in plan order.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, stat, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clipsFromPlan,
  clipFileName,
  clipReportFileName,
  coveredShots,
  planClipWork,
  renderPlanClips,
  stitchRenderedClips,
} from '../src/services/musicVideoRender.js'

const FIXTURE = JSON.parse(await readFile(new URL('./fixtures/sample-plan.json', import.meta.url), 'utf8'))

async function makeProject({ trackBytes = 2048 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'belrog-driver-'))
  const trackPath = join(dir, 'track.m4a')
  await writeFile(trackPath, Buffer.alloc(trackBytes, 7))
  const plan = { ...FIXTURE, track: { ...FIXTURE.track, path: trackPath } }
  const renderDir = join(dir, 'renders')
  return { dir, plan, renderDir, trackPath }
}

/**
 * ComfyUI-shaped fake. First /history answer is "still queued", second returns
 * the output, which is what makes the driver exercise its poll path.
 */
function fakeComfy({ fail = false, bytes = Buffer.alloc(4096, 3) } = {}) {
  const state = { prompts: 0, uploads: 0, polls: 0, downloaded: 0, graphs: [] }
  return {
    host: 'fake',
    state,
    async getObjectInfoCached() { return {} },
    async uploadFile(path, name) { state.uploads += 1; return { name: name || 'upload', subfolder: '', type: 'input' } },
    async queuePrompt(graph) {
      state.prompts += 1
      state.graphs.push(graph)
      return { prompt_id: `p${state.prompts}` }
    },
    async getHistory(promptId) {
      state.polls += 1
      if (state.polls === 1) return {}
      if (fail) return { [promptId]: { status: { status_str: 'error', messages: [['execution_error', { detail: 'CUDA out of memory' }]] } } }
      return { [promptId]: { outputs: { '1700': { videos: [{ filename: `${promptId}.mp4`, subfolder: '', type: 'output' }] } } } }
    },
    async getQueueStatus() { return { queue_running: [], queue_pending: [] } },
    async downloadVideo() {
      state.downloaded += 1
      return { ok: true, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } }
    },
    async interrupt() {},
  }
}

test('clipsFromPlan orders by index and fills a missing index from its position', () => {
  const plan = { clips: [{ index: 2, startSec: 20, lengthSec: 5, shotIds: [] }, { startSec: 0, lengthSec: 5, shotIds: [] }] }
  const clips = clipsFromPlan(plan)
  assert.deepEqual(clips.map((c) => c.index), [1, 2], 'the un-indexed clip keeps its position and the list sorts by index')
  assert.throws(() => clipsFromPlan({ clips: [] }), /no clips/)
})

test('coveredShots uses clip.shotIds', () => {
  const plan = { shots: [{ id: 'shot_001' }, { id: 'shot_002' }], clips: [{ index: 0, shotIds: ['shot_002'] }] }
  assert.deepEqual(coveredShots(plan, plan.clips[0]), ['shot_002'])
})

test('planClipWork marks a clip done from shot states', () => {
  const plan = FIXTURE
  const states = [{ shotId: 'shot_001', status: 'done' }, { shotId: 'shot_002', status: 'pending' }]
  const work = planClipWork({ plan, shotStates: states })
  assert.equal(work.doneClips.length, 1)
  assert.equal(work.pendingClips[0].index, 1, 'the clip whose shot is still pending is the only work left')
})

test('renderPlanClips renders each clip once and writes a report per clip', async () => {
  const { plan, renderDir } = await makeProject()
  const comfy = fakeComfy()
  const seen = []
  const res = await renderPlanClips(plan, renderDir, { comfy, gate: false, onClip: (r) => seen.push(r) })

  assert.equal(res.ok, true, 'no clip failed')
  assert.equal(res.results.length, 2)
  assert.equal(comfy.state.prompts, 2, 'one queued graph per clip')
  assert.equal(comfy.state.downloaded, 2, 'one download per clip')
  assert.equal(seen.length, 2, 'the caller saw each clip')

  for (const clip of plan.clips) {
    const out = join(renderDir, clipFileName(clip))
    const reportPath = join(renderDir, clipReportFileName(clip))
    assert.ok((await stat(out)).size > 0, `${clipFileName(clip)} is not empty`)
    const rep = JSON.parse(await readFile(reportPath, 'utf8'))
    assert.equal(rep.clipIndex, clip.index)
    assert.equal(rep.seed, seen.find((s) => s.clipIndex === clip.index).seed, 'report seed agrees with what rendered')
    assert.deepEqual(rep.shotIds, clip.shotIds, 'report records which shots this clip covers')
  }
})

test('a second run skips clips already rendered instead of paying twice', async () => {
  const { plan, renderDir } = await makeProject()
  const first = fakeComfy()
  await renderPlanClips(plan, renderDir, { comfy: first, gate: false })
  const before = first.state.prompts

  const second = fakeComfy()
  const res = await renderPlanClips(plan, renderDir, { comfy: second, gate: false })
  assert.equal(second.state.prompts, 0, 'nothing was queued again')
  assert.ok(first.state.prompts === before)
  assert.ok(res.results.every((r) => r.skipped), 'every clip came from disk')
})

test('a clip whose seed changed is re-rendered, not reused', async () => {
  const { plan, renderDir } = await makeProject()
  const comfy = fakeComfy()
  await renderPlanClips(plan, renderDir, { comfy, gate: false })

  const res = await renderPlanClips(plan, renderDir, { comfy: fakeComfy(), gate: false, options: { seed: 999 } })
  assert.equal(comfy.state.prompts, 2, 'the run before had 2 clips')
  assert.ok(res.results.filter((r) => r.skipped).length === 0, 'a different seed means new pictures, so nothing may be skipped')
})

test('a ComfyUI error is reported per clip and does not stop the run', async () => {
  const { plan, renderDir } = await makeProject()
  const comfy = fakeComfy({ fail: true })
  let polls = 0
  const wrapped = { ...comfy, async getHistory(id) { polls += 1; return comfy.getHistory(id) } }
  const res = await renderPlanClips(plan, renderDir, { comfy: wrapped, gate: false })
  assert.equal(res.ok, false, 'a failed clip makes the run not-ok')
  assert.equal(res.failed.length, 2)
  assert.match(res.failed[0].error, /error/i)
  assert.equal(res.results.length, 2, 'both clips are accounted for')
})

test('cancel stops between clips', async () => {
  const { plan, renderDir } = await makeProject()
  const comfy = fakeComfy()
  let asked = 0
  const res = await renderPlanClips(plan, renderDir, {
    comfy,
    gate: false,
    shouldCancel: async () => { asked += 1; return asked > 1 },
  })
  assert.equal(res.cancelled, true)
  assert.equal(comfy.state.prompts, 1, 'the second clip was never queued')
})

test('stitch inputs follow plan order and the shared track', async () => {
  const { plan, renderDir, trackPath } = await makeProject()
  const comfy = fakeComfy()
  const res = await renderPlanClips(plan, renderDir, { comfy, gate: false })

  let got = null
  const stitched = await stitchRenderedClips({
    plan,
    results: res.results,
    outPath: join(renderDir, '..', 'final.mp4'),
    stitch: async (args) => { got = args; return { ok: true, drift: { videoSec: 20, trackSec: 20, deltaSec: 0 } } },
  })

  assert.equal(got.clips.length, 2)
  assert.ok(got.clips[0].path.endsWith('clip_000.mp4'), 'first input is clip 0')
  assert.ok(got.clips[1].path.endsWith('clip_001.mp4'))
  assert.equal(got.track.path, trackPath, 'the single shared track is the audio source')
  assert.equal(stitched.outPath.endsWith('final.mp4'), true)
  assert.ok(Array.isArray(stitched.command), 'the ffmpeg command is reportable to the UI')
})

test('stitch refuses when a clip was never rendered', async () => {
  const { plan, renderDir } = await makeProject()
  await mkdir(renderDir, { recursive: true })
  await writeFile(join(renderDir, clipFileName({ index: 0 })), Buffer.alloc(10))
  await assert.rejects(
    () => stitchRenderedClips({ plan, results: [{ clipIndex: 0, outPath: join(renderDir, 'clip_000.mp4') }], outPath: 'x.mp4' }),
    /clip 1 has no rendered file/,
  )
})

test('the upload cache hashes a real file and uploads the shared track once', async () => {
  const { createUploadCache } = await import('../src/services/shotRenderer.js')
  const dir = await mkdtemp(join(tmpdir(), 'belrog-cache-'))
  const track = join(dir, 'song.m4a')
  await writeFile(track, Buffer.from('a track that is long enough to hash twice'.repeat(50)))
  const cache = createUploadCache({ dir })
  let uploads = 0
  const comfy = { async uploadFile() { uploads += 1; return { name: 'song.m4a' } } }

  const a = await cache.put(comfy, track, { host: 'h1' })
  const b = await cache.put(comfy, track, { host: 'h1' })
  assert.equal(a.cached, false, 'first put uploads')
  assert.equal(b.cached, true, 'second put hits the content hash instead of re-uploading')
  assert.equal(uploads, 1)

  const otherHost = await cache.put(comfy, track, { host: 'h2' })
  assert.equal(otherHost.cached, false, 'a different ComfyUI host has not seen this file')

  // persistence: a fresh cache object reads the same answer from disk
  const reopened = createUploadCache({ dir })
  assert.equal((await reopened.put({ async uploadFile() { uploads += 1; return { name: 'song.m4a' } }, host: 'h1' }, track, { host: 'h1' })).cached, true,
    'the cache survives a restart so a resumed render does not re-upload the track')
  assert.equal(uploads, 2, 'only the new host cost an upload')
})
