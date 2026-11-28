#!/usr/bin/env node
/**
 * Render-layer tests: shotRenderer graph laws, stitcher ffmpeg laws, and the
 * CLI's dry-run path. CPU only — nothing here contacts ComfyUI, and nothing
 * here generates video or audio. The dry run IS the contract check: it builds
 * the exact /prompt payload and the exact ffmpeg command with no network.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import {
  buildShotGraph,
  audioWindowForClip,
  auditShotGraph,
  loadShotGraph,
  shotsForClip,
  seedFor,
  RENDER_DEFAULTS,
  CALIBRATION,
  calibrationLengthSeconds,
  NODE,
} from '../src/services/shotRenderer.js'
import { buildStitchCommand, STITCH_DEFAULTS } from '../src/services/stitcher.js'
import { dryRun, loadPlan } from '../scripts/music-video-render.mjs'

const results = []
function check(name, fn) {
  try { fn(); results.push([true, name, '']) }
  catch (e) { results.push([false, name, String(e.message || e).split('\n')[0]]) }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push([true, name, '']) }
  catch (e) { results.push([false, name, String(e.message || e).split('\n')[0]]) }
}
const at = (graph, id) => graph[id]?.inputs

const plan = {
  schemaVersion: 1,
  track: {
    path: '/music/video/song.m4a', durationSec: 173.02, bpm: 120,
    sections: [{ id: 's1', startSec: 0, endSec: 173.02, kind: 'verse' }],
    profileSource: 'envelope',
  },
  look: {
    preset: 'mtv-1990s', film: '35mm push', lighting: 'hard backlight',
    palette: 'cyan, amber', letterbox: '2.39:1 anamorphic',
    location: { slug: 'club', lock: 'the same club, same brick wall, same haze' },
  },
  cast: [{ slug: 'singer', role: 'lead', lock: 'same face, same jacket' }],
  shots: [
    { id: 'shot_001', sectionId: 's1', startSec: 12, endSec: 15.5, shotType: 'performance', size: 'medium',
      cameraMove: 'push-in', energy: 'building', performanceMode: 'lip-sync', cast: ['singer'],
      lyric: 'the bridge is holding', lipSync: true, action: 'leans into the mic' },
  ],
  clips: [{ index: 0, startSec: 12, lengthSec: 3.5, shotIds: ['shot_001'] }],
  llm: { backend: 'local', modelId: 'x' },
}
const clip = plan.clips[0]
const graph = structuredClone(await loadShotGraph())
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn() } finally { console.log = log } }

/* ---------------------------- frame law ------------------------------- */

check('every render length lands on 8n+1 frames', () => {
  for (const len of [0.6, 3.5, 4.93, 12.1, 20]) {
    const w = audioWindowForClip({ clip: { ...clip, lengthSec: len }, options: RENDER_DEFAULTS })
    assert.equal((w.renderFrames - 1) % 8, 0, `${len}s produced ${w.renderFrames} frames`)
  }
})

check('the shipped frame rate is 24 and the look-ahead is one frame', () => {
  assert.equal(RENDER_DEFAULTS.fps, 24)
  assert.equal(RENDER_DEFAULTS.lookAheadFrames, 1)
  const w = audioWindowForClip({ clip, options: RENDER_DEFAULTS })
  assert.ok(Math.abs(w.lookAheadSec - 1 / 24) < 1e-6, `${w.lookAheadSec} is not one frame at 24 fps`)
})

check('the look-ahead is trimmed at stitch time, never added to the cut', () => {
  const w = audioWindowForClip({ clip, options: RENDER_DEFAULTS })
  assert.ok(Math.abs(w.usableSec + w.lookAheadSec - w.renderLengthSec) < 1e-6)
  assert.equal(w.usableFrames, Math.round(clip.lengthSec * 24))
})

check('a clip with no length is refused, not rendered at a default length', () => {
  assert.throws(() => audioWindowForClip({ clip: { index: 9 }, options: RENDER_DEFAULTS }), /lengthSec/)
})

check('the calibration clip obeys the frame law under its own cap', () => {
  const { lengthSec, frames } = calibrationLengthSeconds({ fps: CALIBRATION.fps, maxSeconds: CALIBRATION.maxSeconds })
  const w = audioWindowForClip({ clip: { ...clip, lengthSec }, fps: CALIBRATION.fps, lookAheadFrames: CALIBRATION.lookAheadFrames })
  assert.equal((w.renderFrames - 1) % 8, 0)
  assert.equal(frames % 8, 1)
  assert.ok(w.renderLengthSec <= CALIBRATION.maxSeconds, `${w.renderLengthSec}s exceeds the ${CALIBRATION.maxSeconds}s cap`)
})

/* ------------------------------ graph --------------------------------- */

const built = buildShotGraph({ plan, clip, graph, options: { ...RENDER_DEFAULTS, seed: 4321 } })

check('the clip trims audio from its own start in the song', () => {
  assert.equal(at(built.graph, NODE.audioStart).value, 12)
})

check('a clip starting at zero trims from zero', () => {
  const g = buildShotGraph({ plan, clip: { ...clip, startSec: 0 }, graph: structuredClone(graph), options: RENDER_DEFAULTS })
  assert.equal(at(g.graph, NODE.audioStart).value, 0)
})

check('a clip deep in the track uses that offset', () => {
  const g = buildShotGraph({ plan, clip: { ...clip, startSec: 137.42 }, graph: structuredClone(graph), options: RENDER_DEFAULTS })
  assert.equal(at(g.graph, NODE.audioStart).value, 137.42)
})

check('the graph carries the rendered length, look-ahead included', () => {
  assert.equal(at(built.graph, NODE.length).value, built.window.renderLengthSec)
})

check('both sampler seeds derive from one seed', () => {
  assert.equal(at(built.graph, NODE.seedPass1).noise_seed, 4321)
  assert.equal(at(built.graph, NODE.seedPass2).noise_seed, 4322)
})

check('the seed is deterministic per clip and differs between clips', () => {
  assert.equal(seedFor(clip), seedFor(clip))
  assert.notEqual(seedFor(clip), seedFor({ ...clip, index: 4, startSec: 90 }))
  assert.equal(seedFor(clip, { seed: 77 }), 77)
})

check('the graph carries no prompt-enhancer node', () => {
  const audit = auditShotGraph(graph)
  assert.ok(audit.ok, audit.problems?.join('; '))
  assert.ok(!Object.values(graph).some((n) => n.class_type === 'TextGenerateLTX2Prompt'))
})

check('the graph names the uploaded file, not a local path', () => {
  const audio = at(built.graph, NODE.audioFile).audio
  assert.ok(!audio.includes('/'), `${audio} is a path; Comfy wants a bare uploaded name`)
  assert.equal(audio, 'song.m4a')
})

check('the compiled prompt carries this shot, not boilerplate', () => {
  assert.ok(built.prompt.includes(clip.shotIds.length && plan.shots[0].action))
  assert.ok(built.prompt.includes('the bridge is holding'))
  assert.ok(built.prompt.includes(plan.look.palette))
  assert.ok(built.prompt.includes(plan.look.letterbox))
})

check('the compiled prompt leaks no timestamps or schema keys', () => {
  // The deleted enhancer collapsed every prompt to the same boilerplate, and a
  // timestamp inside an image-model prompt is noise the model cannot use.
  assert.ok(!/\b\d+(\.\d+)?\s*(s|sec|seconds)\b/.test(built.prompt), built.prompt)
  for (const key of ['shotType', 'cameraMove', 'performanceMode', 'startSec']) {
    assert.ok(!built.prompt.includes(key), `${key} leaked into the prompt`)
  }
})

check('a different clip yields a different prompt', () => {
  const other = structuredClone(plan)
  other.clips[0] = { ...clip, startSec: 90, lengthSec: 6 }
  other.shots[0] = { ...plan.shots[0], startSec: 90, endSec: 96, action: 'walks backward into the smoke' }
  const g = buildShotGraph({ plan: other, clip: other.clips[0], graph: structuredClone(graph), options: RENDER_DEFAULTS })
  assert.notEqual(g.prompt, built.prompt)
  assert.ok(g.prompt.includes('walks backward into the smoke'))
})

check('an empty cast list does not crash the compiler', () => {
  const bare = structuredClone(plan); bare.cast = []
  const g = buildShotGraph({ plan: bare, clip, graph: structuredClone(graph), options: RENDER_DEFAULTS })
  assert.ok(g.prompt.length > 0)
})

check('shotsForClip returns the shots the clip covers', () => {
  assert.deepEqual(shotsForClip(plan, clip).map((s) => s.id), ['shot_001'])
})

check('an unknown option changes nothing in the graph', () => {
  const g = buildShotGraph({ plan, clip, graph: structuredClone(graph), options: { ...RENDER_DEFAULTS, seed: 4321, nonsense: 42 } })
  assert.deepEqual(g.graph, built.graph)
})

/* ----------------------------- stitcher ------------------------------- */

const clips = [0, 1, 2].map((i) => ({
  path: `/tmp/renders/clip_${i}.mp4`, index: i, usableSec: 5,
  usableFrames: i === 1 ? 121 : 120, renderedFrames: 120, fps: 24,
}))
const cmd = buildStitchCommand({ clips, track: plan.track, outPath: '/tmp/final/music_video.mp4' })
const str = cmd.command.join(' ')

check('the track is the only audio master', () => {
  assert.equal(cmd.command.filter((a) => a === plan.track.path).length, 1)
  assert.deepEqual(cmd.maps, { video: '[cv]', audio: '[3:a]', audioSource: plan.track.path })
  assert.equal((str.match(/-map/g) || []).length, 2, str)
})

check('clips contribute video only', () => {
  assert.ok(cmd.filterComplex.includes('concat=n=3:v=1:a=0'), cmd.filterComplex)
  // Regression: the filter used to be written `${n}concat`, which ffmpeg rejects
  // with "No such filter: '3concat'" — the stitch could never run.
  assert.ok(!/\d concat|\dconcat/.test(cmd.filterComplex), cmd.filterComplex)
})

check('a long clip is trimmed to its window', () => {
  // F1: deltaFrames is rendered minus usable (positive for a long clip).
  const s = buildStitchCommand({
    clips: [{ path: '/tmp/renders/clip_0.mp4', index: 0, usableFrames: 121, renderedFrames: 145, fps: 24 }],
    track: plan.track, outPath: '/tmp/o.mp4',
  })
  assert.ok(s.filterComplex.includes('trim=start_frame=0:end_frame=121'), s.filterComplex)
  assert.ok(!s.filterComplex.includes('tpad'), 'tpad would freeze-frame and slide every later cut off the beat')
  // F1: deltaFrames = rendered - usable (a long clip must TRIM, not pad).
  assert.equal(s.trims.find((t) => t.index === 0)?.deltaFrames, 145 - 121, JSON.stringify(s.trims))
  assert.ok(s.filterComplex.includes('end_frame=121') && !s.filterComplex.includes('tpad'), '145 rendered vs 121 usable trims to 121')
})

check('a clip that came back short is reported as drift, not padded', () => {
  const s = buildStitchCommand({
    clips: [{ path: '/tmp/renders/clip_0.mp4', index: 0, usableFrames: 121, renderedFrames: 120, fps: 24 }],
    track: plan.track, outPath: '/tmp/o.mp4',
  })
  assert.equal(s.drift.shortClips.length, 1, JSON.stringify(s.drift))
  assert.equal(s.drift.shortClips[0].action, 'short')
  assert.ok(!s.filterComplex.includes('tpad'))
  assert.ok(!s.trims.some((t) => t.action === 'exact'), 'a short clip must not also be reported as exact')
})

check('the output is encoded for the web', () => {
  for (const f of ['-c:v libx264', '-crf 18', '-pix_fmt yuv420p', '-movflags +faststart', '-c:a aac']) {
    assert.ok(str.includes(f), `${f} missing from: ${str}`)
  }
})

check('the command varies with the clips', () => {
  const other = buildStitchCommand({
    clips: clips.map((c) => ({ ...c, usableFrames: c.usableFrames + 24 })),
    track: plan.track, outPath: '/tmp/final/music_video.mp4',
  })
  assert.notEqual(other.command.join(' '), str)
})

check('a clip with no path is refused instead of reading "undefined"', () => {
  assert.throws(() => buildStitchCommand({ clips: [{ index: 0 }], track: plan.track, outPath: '/tmp/o.mp4' }), /no path/)
})

check('a track with no path is refused', () => {
  assert.throws(() => buildStitchCommand({ clips, track: { path: '' }, outPath: '/tmp/o.mp4' }), /track\.path/)
})

check('one clip still stitches over the track', () => {
  const one = buildStitchCommand({ clips: [clips[0]], track: plan.track, outPath: '/tmp/o.mp4' })
  assert.ok(one.filterComplex.includes('concat=n=1:v=1:a=0'), one.filterComplex)
})

check('the stitch rate matches the render rate', () => {
  assert.equal(STITCH_DEFAULTS.fps, RENDER_DEFAULTS.fps)
})

/* ------------------------------- CLI ---------------------------------- */

const dir = mkdtempSync(join(tmpdir(), 'belrog-cli-'))
const planPath = join(dir, 'plan.json')
writeFileSync(planPath, JSON.stringify(plan, null, 2))
const dry = await quiet(() => dryRun({ plan, outDir: dir, clipIndex: 0, comfyTarget: { url: null, source: 'unset' } }))

check('dry run generates nothing and contacts nothing', () => {
  assert.equal(dry.generated, false)
  assert.equal(dry.mode, 'dry-run')
})

check('dry run reports the values that would actually be sent', () => {
  assert.equal(dry.clip.window.renderFrames % 8, 1)
  assert.equal(dry.clip.seed, seedFor(clip))
  assert.equal(dry.comfy.source, 'unset')
  assert.deepEqual(dry.clip.shots, ['shot_001'])
})

check('dry run hands back the real stitch command', () => {
  assert.equal(dry.stitch.command[0], 'ffmpeg')
  assert.ok(dry.stitch.command.includes('-filter_complex'))
})

await checkAsync('a plan that fails validation stops before any render', async () => {
  const bad = structuredClone(plan); bad.clips[0].startSec = 'twelve'
  const badPath = join(dir, 'bad.json')
  writeFileSync(badPath, JSON.stringify(bad))
  await assert.rejects(() => loadPlan(badPath), /validation/)
})

await checkAsync('a plan with no clips is refused', async () => {
  const empty = structuredClone(plan); empty.clips = []
  const p = join(dir, 'empty.json')
  writeFileSync(p, JSON.stringify(empty))
  await assert.rejects(() => loadPlan(p), /no clips|validation/)
})

await checkAsync('a plan with no track path is refused before the render', async () => {
  const noTrack = structuredClone(plan); noTrack.track.path = ''
  const p = join(dir, 'notrack.json')
  writeFileSync(p, JSON.stringify(noTrack))
  await assert.rejects(() => loadPlan(p), /track|validation/)
})

/* ------------------------------ report -------------------------------- */

let failed = 0
for (const [ok, name, msg] of results) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${msg ? ` — ${msg}` : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} render-layer checks pass`)
process.exit(failed ? 1 : 0)
