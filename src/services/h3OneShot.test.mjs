import test from 'node:test'
import assert from 'node:assert/strict'
import {
  h3ClipFrames,
  h3ClipCount,
  compileScriptToClips,
  auditH3Environment,
  buildH3OneShotWorkflow,
  createH3OneShotState,
  reduceH3OneShotProgress,
  planChain,
  H3_MODEL_REF2VA,
} from './h3OneShot.js'
import {
  parseClipFiles,
  hasStitchedFinal,
  chainProgress,
  resumeDecision,
  clipProgressPercent,
} from './h3OneShotWatch.js'

// ── grid math ─────────────────────────────────────────────────────────────
test('clip lengths land on the 17g+5 grid', () => {
  for (const s of [3.5, 4, 5, 8, 10, 15, 20, 20.5]) {
    const f = h3ClipFrames(s)
    assert.equal((f - 5) % 17, 0, `frames ${f} for ${s}s off grid`)
    assert.ok(f >= Math.round(s * 24) - 1 || f <= Math.round(s * 24) + 17 * 24,
      `frames ${f} wildly off requested ${s}s`)
  }
})

test('clip count: 1 clip fits clip1 delivery, longer splits', () => {
  // Legal clip = 17g+5 frames; clip 1 delivers that many timeline frames.
  assert.equal(h3ClipCount(10, 20), 1)
  assert.equal(h3ClipCount(20.04, 20), 1)
  assert.equal(h3ClipCount(40, 20), 2)
  assert.equal(h3ClipCount(60, 20), 3)
  assert.equal(h3ClipCount(80, 20), 4)
})

// ── script compile ─────────────────────────────────────────────────────────
const SCRIPT = [
  'BELROG DIRECTOR SCRIPT',
  'CHARACTER: rose — lead singer, silver braid',
  'LOCATION: Pine Forest | location_dpf | dense pine forest at blue hour',
  '',
  'Coverage 1: Main',
  'Shot 1: T-01',
  'Start at: 0:00',
  'Length: 8',
  'Artist: rose',
  'Keyframe prompt: LOCATION: (location_dpf), rose sings under fog. CHARACTER: rose only.',
  'Motion prompt: slow push-in',
  'Shot 2: T-02',
  'Start at: 0:08',
  'Length: 6',
  'Artist: rose',
  'Keyframe prompt: close-up rose face. CHARACTER: rose only.',
  'Motion prompt: handheld sway',
].join('\n')

test('compile: clips are grid-aligned, numbered, [N]-block text emitted', () => {
  const { clips, clipPrompts, warnings } = compileScriptToClips(SCRIPT)
  assert.equal(clips.length, 2)
  for (const c of clips) assert.equal((c.frames - 5) % 17, 0)
  assert.match(clipPrompts, /^\[1\]/m)
  assert.match(clipPrompts, /^\[2\]/m)
  assert.ok(warnings.every((w) => typeof w === 'string'))
})

test('compile: Start-at honored, Length not clamped to music-path 15s', () => {
  const script = [
    'Shot 1: A', 'Start at: 0:20', 'Length: 20',
    'Keyframe prompt: a thing happens.', 'Motion prompt: slow pan',
  ].join('\n')
  const { clips } = compileScriptToClips(script)
  assert.equal(clips[0].startSec, 20, 'start-at parsed from raw text')
  // 20s -> ceil((480+5)/17)=29 blocks -> 17*29+8 = 498 frames.
  // (Legal lengths are 17g+8 — matches README's 512-frame/20s-chain example.)
  assert.equal(clips[0].frames, 498, '20s -> grid (no 15s clamp)')
  const noStart = compileScriptToClips('Shot 1: A\nLength: 6\nKeyframe prompt: x')
  assert.equal(noStart.clips[0].startSec, null)
  assert.ok(noStart.warnings.some((w) => /Start at/.test(w)))
})

test('compile: empty script warns instead of throwing', () => {
  const { clips, warnings } = compileScriptToClips('total nonsense, no shots')
  assert.equal(clips.length, 0)
  assert.ok(warnings.length >= 1)
})

// ── environment audit ──────────────────────────────────────────────────────
test('audit: missing addon nodes and missing ref2va are both reported', () => {
  const r = auditH3Environment({ installedNodes: ['MiniMaxH3ReferenceToVideo'], modelFiles: [] })
  assert.equal(r.ok, false)
  assert.ok(r.missingNodes.includes('MiniMaxH3AutoChainAudio'))
  assert.equal(r.lipSyncReady, false)
})

test('audit: complete env passes', () => {
  const nodes = ['MiniMaxH3AutoChainAudio', 'MiniMaxH3AutoChainMotionContext',
    'MiniMaxH3AutoChainMotionContextTrim', 'MiniMaxH3AutoChainSaveLatent',
    'MiniMaxH3AutoChainLoadLatent', 'MiniMaxH3AutoChainFrameReference',
    'MiniMaxH3AutoChain', 'MiniMaxH3SparseChainStitch',
    'MiniMaxH3ReferenceToVideo', 'MiniMaxH3AddGuide']
  const files = [H3_MODEL_REF2VA, 'minimax_h3_video_vae_fp16.safetensors',
    'minimax_h3_audio_vae_fp32.safetensors', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors']
  const r = auditH3Environment({ installedNodes: nodes, modelFiles: files })
  assert.equal(r.ok, true)
  assert.equal(r.lipSyncReady, true)
})

// ── workflow builder ───────────────────────────────────────────────────────
test('workflow: API format, chain wiring present, no dangling links', () => {
  const wf = buildH3OneShotWorkflow({
    chainId: 'test_chain', audioFile: 'song.mp3', clipPrompts: '[1] x\n[2] y',
    totalSeconds: 40, refImage: 'rose_sheet.png',
  })
  for (const node of Object.values(wf)) {
    assert.ok(node.class_type, 'every node has class_type')
  }
  // every link target must exist as a node id
  for (const [nid, node] of Object.entries(wf)) {
    for (const v of Object.values(node.inputs)) {
      if (Array.isArray(v) && typeof v[0] === 'string') {
        assert.ok(wf[v[0]], `node ${nid} links to missing node ${v[0]}`)
      }
    }
  }
  assert.equal(wf['2'].inputs.chain_id, 'test_chain')
  assert.equal(wf['3'].inputs.unet_name, H3_MODEL_REF2VA)
  assert.equal(wf['23'].inputs.audio_source, 'original audio input')
})

test('workflow: no refImage drops the LoadImage node cleanly', () => {
  const wf = buildH3OneShotWorkflow({ chainId: 'c', audioFile: 'a.mp3', clipPrompts: '[1] x', totalSeconds: 8 })
  assert.equal(wf['12'], undefined)
  assert.equal(wf['11'].inputs.initial_image, undefined)
})

// ── state / progress ───────────────────────────────────────────────────────
test('state: resume cursor tracks highest completed clip', () => {
  let s = createH3OneShotState({ audioFileName: 'a.mp3', durationSeconds: 40, scriptText: SCRIPT })
  s = reduceH3OneShotProgress(s, { event: 'audit_ok' })
  s = reduceH3OneShotProgress(s, { event: 'queued' })
  s = reduceH3OneShotProgress(s, { event: 'clip_done', clip: 1 })
  s = reduceH3OneShotProgress(s, { event: 'clip_done', clip: 2 })
  s = reduceH3OneShotProgress(s, { event: 'clip_failed', clip: 3 })
  assert.equal(s.stage, 'failed')
  assert.equal(s.lastCompletedClip, 2)
  assert.ok(s.log.length >= 5)
})

// ── disk watcher ───────────────────────────────────────────────────────────
function fakeFs(files, mtimes = {}) {
  return {
    listDir: () => Object.keys(files),
    statMtime: (p) => (p in mtimes ? mtimes[p] : files[p.split('/').pop()]?.mtime ?? null),
    readFile: (p) => files[p.split('/').pop()]?.body ?? null,
  }
}

test('watcher: clip files parse to done list, final detect works', () => {
  const files = ['c_clip_001.mp4', 'c_clip_002.mp4', 'other_clip_001.mp4', 'c.mp4']
  assert.deepEqual(parseClipFiles(files, 'c'), [1, 2])
  assert.equal(hasStitchedFinal(files, 'c'), true)
})

test('watcher: stalled chain detected when newest clip is old', () => {
  const now = Date.now()
  const fs = fakeFs({ 'c_clip_001.mp4': { mtime: now / 1000 - 5000 } }) // epoch SECONDS, 5000s old
  const p = chainProgress({ fsAdapter: fs, videoDir: 'v', chainId: 'c', clipsTotal: 3, now })
  assert.deepEqual(p.missing, [2, 3])
  assert.equal(p.stalled, true)
  const d = resumeDecision(p)
  assert.equal(d.action, 'resume')
  assert.equal(d.startClip, 2)
})

test('watcher: fresh clips are not stalled', () => {
  const now = Date.now()
  const fs = fakeFs({ 'c_clip_001.mp4': { mtime: now / 1000 - 10 } })
  const p = chainProgress({ fsAdapter: fs, videoDir: 'v', chainId: 'c', clipsTotal: 3, now })
  assert.equal(p.stalled, false)
})

test('watcher: all clips present but no final = stitch-only resume', () => {
  const fs = fakeFs({ 'c_clip_001.mp4': { mtime: 1 }, 'c_clip_002.mp4': { mtime: 1 } })
  const p = chainProgress({ fsAdapter: fs, videoDir: 'v', chainId: 'c', clipsTotal: 2, now: 10 })
  const d = resumeDecision(p)
  assert.equal(d.action, 'stitch-only')
})

test('progress percent monotonic 0-100', () => {
  assert.equal(clipProgressPercent(0, 40), 0)
  assert.equal(clipProgressPercent(20, 40), 50)
  assert.equal(clipProgressPercent(41, 40), 100)
})

test('plan: clipsTotal matches clip math', () => {
  const p = planChain({ durationSeconds: 60, chunkSeconds: 20 })
  assert.equal(p.clipsTotal, 3)
  assert.deepEqual(p.clipFiles, [1, 2, 3])
})

// ── RED-TEAM control: sabotage the watcher's stall math, battery must go red ──
// (manual procedure documented in EVEM-TEST-PLAN.md; this test guards the
// happy path only — the red-team is a file-patch ritual, not a code path.)
test('control: complete final chain yields action=none', () => {
  const fs = fakeFs({ 'c.mp4': { mtime: 1 }, 'c_clip_001.mp4': { mtime: 1 } })
  const p = chainProgress({ fsAdapter: fs, videoDir: 'v', chainId: 'c', clipsTotal: 1, now: 10 })
  assert.equal(resumeDecision(p).action, 'none')
})
