#!/usr/bin/env node
/**
 * music-video-render — Belrog music-video render CLI.
 *
 * Turns a validated plan.json into one clip per shot on a remote ComfyUI and
 * stitches them over the single shared track. Modes, cheapest first, and the
 * ordering is the point:
 *
 *   --dry-run   build the graph and the stitch command, contact nothing
 *   --stills    one PNG per clip (same compiled prompt, same seed, no video)
 *   --single    one short calibration clip, to measure this machine
 *   --full      every clip, then stitch   (needs BELROG_GPU_GO=1)
 *
 * Laws:
 *  - Nothing reaches ComfyUI before renderPreflight's gate passes. It refuses
 *    video/audio while vLLM answers on the render host, and refuses everything
 *    when the ComfyUI URL is unset. No localhost default, no tailnet guess.
 *  - Graphs are built by shotRenderer, never by this file. If a field needs to
 *    change, it changes there, so the app and the CLI cannot drift apart.
 *  - Henry is the visual test. A run that produces no media is a normal outcome
 *    of --dry-run and of a refused gate, not a failure to hide.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validatePlanStrict } from '../src/services/shotPlanValidator.js'
import {
  renderShot,
  renderStills,
  loadShotGraph,
  auditShotGraph,
  buildShotGraph,
  shotsForClip,
  seedFor,
  RENDER_DEFAULTS,
  CALIBRATION,
  calibrationLengthSeconds,
  WORKFLOW_PATH,
} from '../src/services/shotRenderer.js'
import { buildStitchCommand, stitchClips } from '../src/services/stitcher.js'
import { createComfyClient } from '../src/services/comfyClient.js'
export { createComfyClient }
import {
  assertFullRenderApproved,
  resolveComfyTarget,
  RenderGateError,
  COMFY_URL_ENV,
  GPU_GO_ENV,
} from '../src/services/renderPreflight.js'

void dirname(fileURLToPath(import.meta.url))

const HELP = `music-video-render — plan.json to beat-synced video

  node scripts/music-video-render.mjs --dry-run --plan <plan.json>
  node scripts/music-video-render.mjs --stills  --plan <plan.json> [--out <dir>]
  node scripts/music-video-render.mjs --single  --plan <plan.json> [--clip N] [--out <dir>]
  node scripts/music-video-render.mjs --full    --plan <plan.json> [--out <dir>]

  --comfy <url>   override the ComfyUI base URL for this run
  --json          append a machine-readable result line

Cost gate: ${GPU_GO_ENV}=1 is required for --full. Video and audio are refused
while vLLM answers on the render host; stills are refused then too. Nothing is
queued before that check passes.`

/* ------------------------------- args --------------------------------- */

function parseArgs(argv) {
  const out = { mode: null, planPath: null, outDir: null, clipIndex: 0, comfyUrl: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run' || a === '--dryRun') out.mode = 'dry-run'
    else if (a === '--stills') out.mode = 'stills'
    else if (a === '--single') out.mode = 'single'
    else if (a === '--full' || a === '--render') out.mode = 'full'
    else if (a === '--plan' || a === '-p') out.planPath = argv[++i]
    else if (a === '--out' || a === '--outDir') out.outDir = argv[++i]
    else if (a === '--clip' || a === '--shot') out.clipIndex = Number(argv[++i])
    else if (a === '--comfy') out.comfyUrl = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '--engine') {
      if (argv[++i] !== 'ltx23') throw new Error('Only --engine ltx23 is implemented; h3 has no per-shot renderer.')
    }
    else if (a === '--help' || a === '-h') out.mode = 'help'
    else if (!a.startsWith('-') && !out.planPath) out.planPath = a
    else throw new Error(`Unknown argument: ${a}`)
  }
  if (!Number.isInteger(out.clipIndex)) throw new Error('--clip needs a whole number')
  return out
}

/* ---------------------------- comfy client ----------------------------
 * The client lives in src/services/comfyClient.js so the app and this CLI
 * cannot drift on URLs, upload fields or polling. Re-exported here for callers
 * that already import the CLI.
 */
/* ------------------------------- plan --------------------------------- */

export async function loadPlan(planPath) {
  if (!planPath) throw new Error('No plan given. Pass --plan <plan.json>.')
  const plan = JSON.parse(await readFile(resolve(planPath), 'utf8'))
  // Strict, no repair: the CLI has no LLM in front of it and must not silently
  // rewrite a plan it was handed. Errors are listed so they can be fixed by hand.
  const result = validatePlanStrict(plan)
  if (result && result.ok === false) {
    const list = [...(result.grammarErrors || []), ...(result.schemaErrors || [])]
      .map((e) => (typeof e === 'string' ? e : `${e.path || e.instancePath || '?'}: ${e.message || e}`))
    throw new Error(`plan.json failed validation:\n  ${list.join('\n  ')}`)
  }
  if (!Array.isArray(plan.clips) || plan.clips.length === 0) throw new Error('plan.json has no clips')
  if (!plan.track?.path) throw new Error('plan.json has no track.path — the render needs one shared audio source')
  return plan
}

const clipPathFor = (outDir, clip) => join(outDir, 'renders', `clip_${String(clip.index).padStart(2, '0')}.mp4`)

function printProgress(evt) {
  if (!evt || typeof evt !== 'object') return
  const secs = evt.elapsedMs != null ? ` ${(evt.elapsedMs / 1000).toFixed(0)}s` : ''
  const extra = evt.frames != null ? ` ${evt.frames} frames` : evt.promptChars != null ? ` ${evt.promptChars} prompt chars` : ''
  process.stdout.write(`  · ${evt.phase || 'work'}${evt.clip != null ? ` clip ${evt.clip}` : ''}${extra}${secs}\n`)
}

function pickClip(plan, clipIndex) {
  const clip = plan.clips.find((c) => Number(c.index) === clipIndex) || plan.clips[clipIndex]
  if (!clip) throw new Error(`clip ${clipIndex} is not in this plan (it has ${plan.clips.length})`)
  return clip
}

/* ------------------------------ modes --------------------------------- */

/**
 * Dry run: exactly what would be sent, and exactly the command that would
 * stitch it. No network and no gate needed, which is what makes it the safe
 * default proof of the render path.
 */
export async function dryRun({ plan, outDir, clipIndex = 0, comfyTarget }) {
  const graph = await loadShotGraph()
  const audit = auditShotGraph(graph)
  if (!audit.ok) throw new Error(`shipped workflow failed its own audit: ${audit.problems.join('; ')}`)

  const clip = pickClip(plan, clipIndex)
  const built = buildShotGraph({ plan, clip, graph, options: { ...RENDER_DEFAULTS, seed: seedFor(clip) } })

  const clips = plan.clips.map((c) => ({
    path: clipPathFor(outDir, c),
    index: c.index,
    usableSec: c.lengthSec,
    usableFrames: Math.round(Number(c.lengthSec) * RENDER_DEFAULTS.fps),
  }))
  const stitch = buildStitchCommand({ clips, track: plan.track, outPath: join(outDir, 'final', 'music_video.mp4') })

  const result = {
    mode: 'dry-run',
    workflow: { path: WORKFLOW_PATH, nodes: audit.nodes },
    comfy: comfyTarget,
    clip: {
      index: clip.index,
      shots: shotsForClip(plan, clip).map((s) => s.id),
      window: built.window,
      seed: built.seed,
      promptChars: built.prompt.length,
    },
    stitch: { command: stitch.command, trims: stitch.trims || [] },
    generated: false,
  }

  console.log('=== DRY RUN — nothing was contacted, nothing was generated ===\n')
  console.log(`workflow     ${WORKFLOW_PATH}  (${audit.nodes} nodes, no enhancer node: ${audit.ok})`)
  console.log(`comfy        ${comfyTarget?.url || 'unset'}  (from ${comfyTarget?.source || 'not resolved'})`)
  console.log(`clip ${clip.index}        shots ${result.clip.shots.join(', ')}`)
  console.log(`             ${built.window.usableSec}s usable + ${built.window.lookAheadSec}s look-ahead`
    + ` = ${built.window.renderLengthSec}s rendered (${built.window.renderFrames} frames at ${RENDER_DEFAULTS.fps} fps)`)
  console.log(`seed         ${built.seed}    prompt ${built.prompt.length} chars\n`)
  console.log('--- compiled prompt (what this shot would be sent as) ---')
  console.log(built.prompt)
  console.log('\n--- /prompt payload ---')
  console.log(JSON.stringify(built.graph))
  console.log('\n--- stitch command ---')
  console.log(stitch.command)
  console.log('\n--- filter graph ---')
  console.log(stitch.filterGraph)
  return result
}

export async function stills({ plan, outDir, comfy }) {
  const out = join(outDir, 'stills')
  await mkdir(out, { recursive: true })
  const result = await renderStills({ plan, comfy, outDir: out, onProgress: printProgress })
  console.log(`\n${result.results.length} still(s) under ${out}`)
  for (const r of result.results) {
    console.log(`  clip ${r.clipIndex} -> ${basename(r.outPath)} (seed ${r.seed}, ${r.prompt.length} prompt chars)`)
  }
  return { mode: 'stills', gate: result.gate, results: result.results, generated: true }
}

export async function single({ plan, outDir, clipIndex = 0, comfy }) {
  const clip = pickClip(plan, clipIndex)
  await mkdir(join(outDir, 'renders'), { recursive: true })
  const outPath = clipPathFor(outDir, clip)
  const calib = calibrationLengthSeconds({ fps: CALIBRATION.fps, maxSeconds: CALIBRATION.maxSeconds })
  const options = { ...CALIBRATION, lengthSec: calib.lengthSec }
  console.log(`Rendering one calibration clip: ${calib.lengthSec}s (${calib.frames} frames) at ${CALIBRATION.fps} fps (clip ${clip.index}).`)
  const result = await renderShot({ plan, clip, comfy, outPath, mode: 'video', options, onProgress: printProgress })

  const report = {
    label: CALIBRATION.label,
    wallClockPerRenderedSec: result.wallClockPerRenderedSec,
    renderTimeMs: result.renderTimeMs,
    renderedSeconds: result.window.renderFrames / CALIBRATION.fps,
    fps: CALIBRATION.fps,
    seed: result.seed,
    gate: result.gate,
  }
  await writeFile(join(outDir, 'render-calibration.json'), JSON.stringify(report, null, 2), 'utf8')
  const songSec = Number(plan.track?.durationSec) || 0
  const etaMin = songSec * report.wallClockPerRenderedSec / 60
  console.log(`\n${outPath}`)
  console.log(`wall clock per rendered second: ${report.wallClockPerRenderedSec.toFixed(2)}s`)
  if (songSec) console.log(`a ${songSec.toFixed(0)}s song would take about ${etaMin.toFixed(1)} min at this rate`)
  return { mode: 'single', outPath, calibration: report, etaMinutes: etaMin || null, generated: true }
}

export async function full({ plan, outDir, comfy }) {
  assertFullRenderApproved({})
  await mkdir(join(outDir, 'renders'), { recursive: true })
  await mkdir(join(outDir, 'final'), { recursive: true })

  const rendered = []
  for (const clip of plan.clips) {
    const outPath = clipPathFor(outDir, clip)
    console.log(`clip ${clip.index} of ${plan.clips.length - 1}  (${clip.startSec}s, +${clip.lengthSec}s)`)
    const result = await renderShot({ plan, clip, comfy, outPath, mode: 'video', onProgress: printProgress })
    await writeFile(join(outDir, 'renders', `clip_${String(clip.index).padStart(2, '0')}.window.json`),
      JSON.stringify({ window: result.window, seed: result.seed, prompt: result.prompt }, null, 2), 'utf8')
    rendered.push({
      path: outPath,
      index: clip.index,
      usableSec: clip.lengthSec,
      usableFrames: result.window.usableFrames,
      renderedFrames: result.window.renderFrames,
      fps: RENDER_DEFAULTS.fps,
    })
  }

  const finalPath = join(outDir, 'final', 'music_video.mp4')
  const stitch = await stitchClips({ clips: rendered, track: plan.track, outPath: finalPath })
  console.log(`\nstitched -> ${finalPath}${stitch.sizeBytes ? ` (${(stitch.sizeBytes / 1048576).toFixed(1)} MB)` : ''}`)
  for (const t of stitch.trims || []) {
    console.log(`  clip ${t.index}: ${t.action} by ${t.deltaFrames} frame(s) (${t.deltaSec}s) — reported, not padded`)
  }
  return { mode: 'full', outPath: finalPath, clips: rendered.length, trims: stitch.trims || [], generated: true }
}

/* ------------------------------- main --------------------------------- */

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.mode === 'help' || !args.mode) {
    console.log(HELP)
    return args.mode === 'help' ? 0 : 2
  }

  const plan = await loadPlan(args.planPath)
  const outDir = resolve(args.outDir || join(dirname(resolve(args.planPath)), 'render'))
  await mkdir(outDir, { recursive: true })
  console.log(`plan ${plan.clips.length} clips / ${plan.shots?.length || 0} shots, track ${plan.track.path} (${Number(plan.track.durationSec || 0).toFixed(1)}s)`)

  let comfy = null
  if (args.mode !== 'dry-run') {
    const target = args.comfyUrl ? { url: args.comfyUrl, source: 'argument' } : await resolveComfyTarget({})
    if (!target.url) {
      console.error(`ComfyUI URL is unset (${COMFY_URL_ENV} empty and no render.json) — nothing was queued.`)
      return 3
    }
    comfy = createComfyClient(target.url)
    console.log(`ComfyUI ${target.url} (from ${target.source})`)
  }

  let result
  if (args.mode === 'dry-run') result = await dryRun({ plan, outDir, clipIndex: args.clipIndex, comfyTarget: args.comfyUrl ? { url: args.comfyUrl, source: 'argument' } : await resolveComfyTarget({}) })
  else if (args.mode === 'stills') result = await stills({ plan, outDir, comfy })
  else if (args.mode === 'single') result = await single({ plan, outDir, clipIndex: args.clipIndex, comfy })
  else result = await full({ plan, outDir, comfy })

  if (args.json) console.log(JSON.stringify(result))
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code)).catch((err) => {
    if (err instanceof RenderGateError) {
      console.error(`\nREFUSED — ${err.message}`)
      if (err.details?.check) console.error(`check:  ${err.details.check}`)
      if (err.details?.remedy) console.error(`remedy: ${err.details.remedy}`)
      process.exit(4)
    }
    console.error(`\nerror: ${err?.message || err}`)
    if (process.env.BELROG_CLI_STACK) console.error(err?.stack)
    process.exit(1)
  })
}
