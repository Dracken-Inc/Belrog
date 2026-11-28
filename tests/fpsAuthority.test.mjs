#!/usr/bin/env node
/**
 * F1 (belrog-0.6.4-fix-plan): frame-rate authority laws, CPU only.
 *
 * The bug class this locks out: fps rounded to an integer somewhere between
 * the plan and the graph, while frame counts are derived from a DIFFERENT fps
 * elsewhere (node 1651 recomputing length*fps, or RENDER_DEFAULTS.fps = 25 as
 * a silent fallback). 23.976 is not 24 and must never be treated as such on
 * the music-video path. No GPU calls, no network, no generation.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

import { buildShotGraph, loadShotGraph, RENDER_DEFAULTS, NODE, graphFrames } from '../src/services/shotRenderer.js'

const HERE0 = dirname(fileURLToPath(import.meta.url))
const ROOT0 = join(HERE0, '..')

// comfyui.js reaches for localComfyConnection without a .js extension (works
// under the bundler, not under bare Node), so run the import in a child
// process with the extension-fixing loader registered via module.register.
let modifyMusicVideoShotWorkflow
{
  // Node <22.5 ignores --experimental-loader in -e; use the module.register API.
  const { execFileSync } = await import('node:child_process')
  const probe = "import('node:module').then(({ register }) => register('./tests/fpsAuthorityLoader.mjs', import.meta.url))"
    + ".then(() => import('./src/services/comfyui.js'))"
    + ".then((m) => process.stdout.write(m.modifyMusicVideoShotWorkflow ? 'ok' : 'missing'))"
    + ".catch((e) => { console.error(e && e.message); process.exit(1) })"
  try {
    execFileSync(process.execPath, ['--no-warnings', '-e', probe], { cwd: ROOT0, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 })
  } catch { /* loader unavailable in this Node; the registered import below still tries */ }
  try {
    const { register } = await import('node:module')
    register(new URL('./fpsAuthorityLoader.mjs', import.meta.url))
  } catch { /* older Node without module.register — direct import will try anyway */ }
  try {
    ;({ modifyMusicVideoShotWorkflow } = await import('../src/services/comfyui.js'))
  } catch {
    modifyMusicVideoShotWorkflow = null
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const results = []
function check(name, fn) {
  try { fn(); results.push([true, name, '']) }
  catch (e) { results.push([false, name, String(e.message || e).split('\n')[0]]) }
}

// A plan shaped like the real director plan: fps stamped at plan time.
const FPS = 23.976
const shot = {
  id: 'shot-1', index: 0, startSec: 0, endSec: 5,
  shotType: 'performance', assets: [],
  timing: { audioStartSec: 0, audioEndSec: 5 },
}
const clip = { index: 0, shotIds: ['shot-1'], startSec: 0, lengthSec: 5, endSec: 5, shots: [shot] }
const plan = {
  schemaVersion: 1, id: 'f1-test-plan', fps: FPS,
  track: { path: '/tmp/fake-song.mp3', durationSec: 300 },
  clips: [clip], shots: [shot],
}

const graph = await loadShotGraph()

check('buildShotGraph stamps node 1586 with the FLOAT plan fps, not a rounded one', () => {
  const built = buildShotGraph({ plan, clip, graph: structuredClone(graph), options: { ...RENDER_DEFAULTS, fps: FPS } })
  assert.equal(built.graph[NODE.fps].inputs.value, FPS, `node 1586 holds ${built.graph[NODE.fps].inputs.value}`)
})

check('node 1651 carries the frame count JS computed, not an expression that recomputes from fps', () => {
  const built = buildShotGraph({ plan, clip, graph: structuredClone(graph), options: { ...RENDER_DEFAULTS, fps: FPS } })
  const want = built.window.renderFrames
  assert.equal(want, graphFrames(built.window.renderLengthSec, FPS), 'window disagrees with graphFrames')
  assert.equal(Number(built.graph[NODE.frameCalc].inputs.expression), want,
    `node 1651 is "${built.graph[NODE.frameCalc].inputs.expression}", expected the literal ${want}`)
  assert.ok(!('variables.a' in built.graph[NODE.frameCalc].inputs) && !('variables.b' in built.graph[NODE.frameCalc].inputs),
    'node 1651 still recomputes from graph variables — two authorities again')
})

check('options.fps absent falls back to plan.fps (the plan is the authority)', () => {
  const built = buildShotGraph({ plan, clip, graph: structuredClone(graph), options: {} })
  assert.equal(built.graph[NODE.fps].inputs.value, FPS)
})

check('a plan with no fps throws naming the plan and the field instead of rendering at a default', () => {
  const noFps = structuredClone(plan)
  delete noFps.fps
  assert.throws(
    () => buildShotGraph({ plan: noFps, clip, graph: structuredClone(graph), options: {} }),
    /f1-test-plan[\s\S]*plan\.fps/,
  )
})

check('a non-finite plan.fps is refused the same way', () => {
  const bad = structuredClone(plan)
  bad.fps = 'soon'
  assert.throws(
    () => buildShotGraph({ plan: bad, clip, graph: structuredClone(graph), options: {} }),
    /plan\.fps/,
  )
})

check('the music-video workflow modifier keeps 23.976 in node 1586', () => {
  if (!modifyMusicVideoShotWorkflow) throw new Error('comfyui.js could not be imported under bare Node (extensionless import)')
  const built = modifyMusicVideoShotWorkflow(structuredClone(graph), {
    shot: { shotType: 'performance', length: 5, audioStart: 0, shotPrompt: 'x' },
    width: 1280, height: 720, fps: FPS,
  })
  assert.equal(built['1586'].inputs.value, FPS, `node 1586 holds ${built['1586'].inputs.value}`)
})

check('the music-video workflow modifier refuses to guess an fps', () => {
  assert.throws(
    () => modifyMusicVideoShotWorkflow(structuredClone(graph), {
      shot: { shotType: 'performance', length: 5, audioStart: 0, shotPrompt: 'x' },
    }),
    /fps/,
  )
})

check('no Math.round(Number(fps)) survives in a frame-count path', () => {
  const offenders = []
  const bad = /Math\.round\(\s*Number\(\s*(opts\.)?fps\s*\)/
  for (const file of ['src/services/comfyui.js', 'src/services/shotRenderer.js', 'electron/agentTools.js', 'src/services/agentTools.js', 'src/services/musicVideoRender.js', 'electron/mcpServer.js']) {
    let text
    try { text = readFileSync(join(ROOT, file), 'utf8') } catch { continue }
    text.split('\n').forEach((line, i) => {
      if (bad.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], `fps was rounded at: ${offenders.join(' | ')}`)
})

check('RENDER_DEFAULTS stays untouched for unrelated paths (8n+1 law intact)', () => {
  assert.equal(RENDER_DEFAULTS.fps, 24)
  assert.equal(graphFrames(4.0, 25), graphFrames(4.0, 25)) // sanity, law unchanged:
  assert.equal((graphFrames(5.0, FPS) - 1) % 8, 0)         // 8n+1 alignment holds at NTSC fps
})

const failed = results.filter(([ok]) => !ok)
for (const [ok, name, err] of results) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${err ? ` — ${err}` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} fps-authority checks pass`)
if (failed.length) process.exitCode = 1
