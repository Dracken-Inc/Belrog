#!/usr/bin/env node
/**
 * ONE-SHOT H3 — headless chain runner (offline test rig).
 *
 * Runs OUTSIDE the app on the Spark box. Queues the H3 auto-chain workflow,
 * watches disk, auto-resues stalled chains, logs everything. Designed to be
 * run with the agent OFF: nohup / tmux, come back, read the log.
 *
 * Usage:
 *   node run-oneshot-chain.mjs --audio song.mp3 --script script.txt \
 *        [--style "..."] [--chain my_chain] [--duration 40] \
 *        [--resume] [--audit-only] [--chunk 20] [--seed 1] [--image face.png]
 *
 * Requires: h3OneShot.js + utils/yoloPlanning.js reachable via --repo,
 * or bundled copy next to this script. ComfyUI at $COMFY (default :8188).
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

const ARGS = (() => {
  const a = { comfy: process.env.COMFY || 'http://127.0.0.1:8188', chunk: 20, seed: 1, resume: false, auditOnly: false }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (k === '--audio') a.audio = argv[++i]
    else if (k === '--script') a.script = argv[++i]
    else if (k === '--style') a.style = argv[++i] || ''
    else if (k === '--chain') a.chain = argv[++i]
    else if (k === '--duration') a.duration = Number(argv[++i])
    else if (k === '--chunk') a.chunk = Number(argv[++i])
    else if (k === '--seed') a.seed = Number(argv[++i])
    else if (k === '--image') a.image = argv[++i]
    else if (k === '--resume') a.resume = true
    else if (k === '--audit-only') a.auditOnly = true
    else if (k === '--repo') a.repo = argv[++i]
  }
  return a
})()

const LOG_FILE = process.env.H3_LOG || 'oneshot-run.log'
const STATE_FILE = process.env.H3_STATE || 'oneshot-state.json'
const POLL_SECONDS = 30
const STALL_SECONDS = 45 * 60

function log(level, msg) {
  const line = `${new Date().toISOString()} ${String(level).toUpperCase().padEnd(5)} ${msg}`
  fs.appendFileSync(LOG_FILE, line + '\n')
  console.log(line)
}

function httpJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, ARGS.comfy)
    const data = body ? Buffer.from(JSON.stringify(body)) : null
    const req = http.request({
      hostname: url.hostname, port: url.port || 80, path: url.pathname, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        try { resolve(JSON.parse(buf || '{}')) } catch (e) { reject(new Error(`bad JSON from ${urlPath}: ${buf.slice(0, 120)}`)) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

async function objectInfo() {
  return httpJson('GET', '/object_info')
}

function loadEngine() {
  // Prefer the repo copy so the rig always matches shipped logic.
  const repo = ARGS.repo || process.env.BELROG_REPO || '.'
  return Promise.all([
    import(path.resolve(repo, 'src/services/h3OneShot.js')),
    import(path.resolve(repo, 'src/services/h3OneShotWatch.js')),
  ]).then(([e, w]) => ({ ...e, ...w }))
}

function outputDirs() {
  // The Spark maps host output dir; override with H3_OUTPUT for other boxes.
  const base = process.env.H3_OUTPUT || '/home/henlafon/shared/image-generation'
  return { videoDir: path.join(base, 'video'), h3ctx: path.join(base, 'h3_context') }
}

;(async () => {
  const engine = await loadEngine()
  const state = {
    chainId: ARGS.chain || `oneshot_${new Date().toISOString().replace(/\D/g, '').slice(0, 12)}`,
    startClip: 1, clipsTotal: 0, stage: 'boot', done: [], final: false,
  }
  const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2))
  saveState()

  log('info', `ONE-SHOT runner boot | chain=${state.chainId} comfy=${ARGS.comfy}`)

  // ── 1. AUDIT ──────────────────────────────────────────────────────────────
  let info
  try { info = await objectInfo() } catch (e) {
    log('fatal', `ComfyUI unreachable at ${ARGS.comfy}: ${e.message}`); state.stage = 'failed'; return saveState()
  }
  // Model file lists come from the loader combos themselves.
  const present = (loader, field, name) => {
    const spec = info[loader]?.input?.required?.[field]
    const list = Array.isArray(spec?.[0]) ? spec[0] : (Array.isArray(spec) ? spec : [])
    return list.some((x) => String(x).endsWith(name))
  }
  const installedNodes = Object.keys(info)
  const modelFiles = [
    present('UNETLoader', 'unet_name', engine.H3_MODEL_REF2VA) && engine.H3_MODEL_REF2VA,
    present('VAELoader', 'vae_name', engine.H3_VIDEO_VAE) && engine.H3_VIDEO_VAE,
    present('VAELoader', 'vae_name', engine.H3_AUDIO_VAE) && engine.H3_AUDIO_VAE,
    present('CLIPLoader', 'clip_name', engine.H3_TEXT_ENCODER) && engine.H3_TEXT_ENCODER,
  ].filter(Boolean)
  const audit = engine.auditH3Environment({ installedNodes, modelFiles })
  log(audit.ok ? 'info' : 'error', `audit ok=${audit.ok} lipSync=${audit.lipSyncReady} missingNodes=[${audit.missingNodes}] missingModels=[${audit.missingModels}]`)
  if (ARGS.auditOnly) { state.stage = 'audited'; return saveState() }
  if (!audit.ok) { state.stage = 'failed'; log('fatal', 'environment audit failed — fix models/nodes above'); return saveState() }

  // ── 2. INPUTS ─────────────────────────────────────────────────────────────
  const scriptText = fs.readFileSync(ARGS.script, 'utf8')
  let duration = ARGS.duration
  if (!duration && ARGS.audio) {
    // ffprobe resolution order matters for detached/background runs:
    // explicit env, PATH, then the known Hermes-local binary.
    const { execSync } = await import('node:child_process')
    const candidates = [
      process.env.FFPROBE,
      'ffprobe',
      '/home/henlafon/.hermes/tools/ffmpeg-9.0.1-linux-arm64/bin/ffprobe',
    ].filter(Boolean)
    for (const probe of candidates) {
      try {
        duration = Number(execSync(`"${probe}" -v error -show_entries format=duration -of csv=p=0 "${ARGS.audio}"`).toString().trim())
        if (duration > 0) break
      } catch { /* next candidate */ }
    }
  }
  if (!duration) { state.stage = 'failed'; return saveState(log('fatal', 'no --duration and ffprobe failed — cannot size the chain')) }
  log('info', `audio=${ARGS.audio} duration=${duration.toFixed(2)}s script=${ARGS.script}`)

  const compiled = engine.compileScriptToClips(scriptText)
  for (const w of compiled.warnings) log('warn', `script: ${w}`)
  if (!compiled.clips.length) { state.stage = 'failed'; return saveState(log('fatal', 'script compiled to zero clips')) }
  const plan = engine.planChain({ durationSeconds: duration, chunkSeconds: ARGS.chunk })
  state.clipsTotal = plan.clipsTotal
  log('info', `chain plan: ${plan.clipsTotal} clips (audio ${duration.toFixed(1)}s vs ${plan.clipsTotal * ARGS.chunk}s of clip budget)`)
  saveState()

  // resume? keep existing clips, start at first missing
  const { videoDir } = outputDirs()
  if (ARGS.resume) {
    const files = fs.readdirSync(videoDir).filter((f) => f.startsWith(`${state.chainId}_clip_`))
    const done = engine.parseClipFiles(files, state.chainId)
    if (done.length) {
      for (let i = 1; i <= plan.clipsTotal; i += 1) if (!done.includes(i)) { state.startClip = i; break }
      state.done = done
      log('info', `resume: clips [${done}] exist → start_clip=${state.startClip}`)
    }
  }

  // ── 3. QUEUE ──────────────────────────────────────────────────────────────
  const audioBase = path.basename(ARGS.audio)
  const graph = engine.buildH3OneShotWorkflow({
    chainId: state.chainId,
    audioFile: audioBase, // must already be in ComfyUI input dir (step 0 copies it)
    stylePrompt: ARGS.style || '',
    clipPrompts: compiled.clipPrompts,
    totalSeconds: duration,
    chunkSeconds: ARGS.chunk,
    seed: ARGS.seed,
    refImage: ARGS.image || null,
    lipSync: true,
    startClip: state.startClip,
    reset: true,
  })
  let resp
  try {
    resp = await httpJson('POST', '/prompt', { prompt: graph, client_id: 'oneshot-runner' })
  } catch (e) {
    state.stage = 'failed'; return saveState(log('fatal', `queue rejected: ${e.message}`))
  }
  if (resp.node_errors || resp.error) {
    state.stage = 'failed'
    log('fatal', `graph rejected: ${JSON.stringify(resp.node_errors || resp.error).slice(0, 900)}`)
    return saveState()
  }
  state.stage = 'running'
  log('info', `queued prompt ${resp.prompt_id} (start_clip=${state.startClip}, end=until audio)`)
  saveState()

  // ── 4. WATCH LOOP (disk = ground truth) ───────────────────────────────────
  const started = Date.now()
  let lastCount = -1
  while (!state.final) {
    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000))
    let files = []
    try { files = fs.readdirSync(videoDir) } catch { /* dir may lag */ }
    const done = engine.parseClipFiles(files, state.chainId)
    state.final = engine.hasStitchedFinal(files, state.chainId)
    if (done.length !== lastCount) {
      lastCount = done.length
      state.done = done
      const pct = engine.clipProgressPercent(done.length, plan.clipsTotal)
      const eta = done.length ? `eta ~${Math.round(((Date.now() - started) / done.length) * (plan.clipsTotal - done.length) / 60000)}min` : ''
      log('info', `progress ${done.length}/${plan.clipsTotal} clips (${pct}%) ${eta} clips=[${done.slice(-6)}${done.length > 6 ? '…' : ''}]`)
      saveState()
    }
    if (state.final) {
      log('info', `STITCHED FINAL: ${path.join(videoDir, `${state.chainId}.mp4`)}`)
      state.stage = 'done'; saveState(); break
    }
    // stall detection → single auto-resume
    const p = engine.chainProgress({
      fsAdapter: {
        listDir: () => { try { return fs.readdirSync(videoDir) } catch { return [] } },
        statMtime: (f) => { try { return fs.statSync(f).mtimeMs } catch { return null } },
      },
      videoDir, chainId: state.chainId, clipsTotal: plan.clipsTotal, stallSeconds: STALL_SECONDS,
    })
    if (p.stalled) {
      const d = engine.resumeDecision(p)
      if (d.action === 'resume') {
        log('warn', `stalled — newest clip mtime > ${STALL_SECONDS / 60}min, missing [${p.missing}]. auto-resume from clip ${d.startClip}`)
        state.startClip = d.startClip
        graph['2'].inputs.start_clip = d.startClip
        graph['2'].inputs.reset = true
        graph['2'].is_changed = Math.random() // force re-execute of the chain node
        try {
          const r2 = await httpJson('POST', '/prompt', { prompt: graph, client_id: 'oneshot-runner' })
          log('info', `re-queued ${r2.prompt_id} from clip ${d.startClip}`)
        } catch (e) { log('error', `auto-resume failed: ${e.message}`) }
        saveState()
        await new Promise((r) => setTimeout(r, POLL_SECONDS * 4 * 1000))
      } else if (d.action === 'stitch-only') {
        log('warn', 'all clips present, final missing — re-queueing for stitch')
        graph['2'].inputs.reset = true
        graph['2'].is_changed = Math.random()
        try { await httpJson('POST', '/prompt', { prompt: graph, client_id: 'oneshot-runner' }) } catch (e) { log('error', `stitch re-queue failed: ${e.message}`) }
        saveState()
      }
    }
    // hard guard: 3x expected runtime
    if (Date.now() - started > plan.clipsTotal * Math.max(ARGS.chunk * 60 * 3, 3600 * 1000)) {
      state.stage = 'failed'; saveState(); log('fatal', 'guard: exceeded 3x expected runtime, bailing'); break
    }
  }
  log('info', `runner exit stage=${state.stage} done=[${state.done}]`)
})().catch((e) => { log('fatal', `uncaught: ${e.stack || e.message}`); process.exit(1) })
