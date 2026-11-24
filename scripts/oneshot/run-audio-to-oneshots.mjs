#!/usr/bin/env node
/**
 * ONE-SHOT H3 — audio → script → test clips, in one command (Belrog 0.5.0).
 *
 * The point: a track you already own is the only input. We read its clock and
 * its lyric tags, tile it into shots that cover the song exactly, write the
 * director script, and (only when asked) hand that script to the existing H3
 * chain runner to make the first few clips.
 *
 *   node run-audio-to-oneshots.mjs --audio song.m4a                  # plan only
 *   node run-audio-to-oneshots.mjs --audio song.m4a --limit 3 --run  # 3 test clips
 *   node run-audio-to-oneshots.mjs --audio song.m4a --max-seconds 60 --run
 *
 * Rendering is limited to an excerpt on purpose: these are one-shots for
 * checking motion, lip sync and cut rhythm. Full-song assembly is a separate
 * step and is not part of this tool.
 *
 * Requires ffprobe (FFPROBE env, PATH, or the Hermes copy) and, for --run,
 * ComfyUI with the H3 auto-chain addon at $COMFY (default 127.0.0.1:8188).
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const ARGS = (() => {
  const a = {
    target: 5,
    chunk: 20,
    seed: 1,
    planOnly: true,
    style: '',
    limit: 0,
    maxSeconds: 0,
    full: false,
    repo: process.env.BELROG_REPO || path.resolve(HERE, '..', '..'),
    comfy: process.env.COMFY || 'http://127.0.0.1:8188',
    out: process.env.H3_RUNS || path.join(process.env.HOME || '.', 'h3-oneshot-runs'),
  }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (k === '--audio') a.audio = argv[++i]
    else if (k === '--style') a.style = argv[++i] || ''
    else if (k === '--target') a.target = Number(argv[++i])
    else if (k === '--limit') a.limit = Number(argv[++i])
    else if (k === '--max-seconds') a.maxSeconds = Number(argv[++i])
    else if (k === '--full') a.full = true
    else if (k === '--run') a.planOnly = false
    else if (k === '--chunk') a.chunk = Number(argv[++i])
    else if (k === '--seed') a.seed = Number(argv[++i])
    else if (k === '--image') a.image = argv[++i]
    else if (k === '--repo') a.repo = argv[++i]
    else if (k === '--comfy') a.comfy = argv[++i]
    else if (k === '--out') a.out = argv[++i]
    else if (k === '--help' || k === '-h') a.help = true
    else {
      console.error(`unknown option: ${k}`)
      process.exit(2)
    }
  }
  return a
})()

function usage() {
  console.log(`audio → script → test one-shots

  --audio <file>        track to read (required)
  --style "..."         look of the piece, one line
  --target <sec>        preferred shot length (default 5, floor 3.5)
  --limit <n>           render only the first n shots
  --max-seconds <sec>   cut the audio excerpt at this length
  --full                render the whole track (not a one-shot test)
  --run                 actually queue clips; without it you only get the plan
  --chunk <sec>         H3 chain chunk (default 20)
  --image <file>        reference face for identity
  --repo <path>         Belrog checkout the engine loads from
  --comfy <url>         ComfyUI base (default $COMFY or 127.0.0.1:8188)
  --out <dir>           run directory root (default ~/h3-oneshot-runs)`)
}

if (ARGS.help || !ARGS.audio) {
  usage()
  process.exit(ARGS.help ? 0 : 2)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const runDir = path.join(ARGS.out, `audio_${stamp}`)
fs.mkdirSync(runDir, { recursive: true })

const logLines = []
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  logLines.push(line)
  console.log(line)
}

function findBinary(envName, candidates) {
  for (const candidate of [process.env[envName], ...candidates].filter(Boolean)) {
    const probe = spawnSync(candidate, ['-version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

const FFPROBE = findBinary('FFPROBE', ['ffprobe', '/home/henlafon/.hermes/tools/ffmpeg-9.0.1-linux-arm64/bin/ffprobe'])
const FFMPEG = findBinary('FFMPEG', ['ffmpeg', '/home/henlafon/.hermes/tools/ffmpeg-9.0.1-linux-arm64/bin/ffmpeg'])

async function loadIntake() {
  const repo = ARGS.repo
  const [intake, probe] = await Promise.all([
    import(pathToFileURL(path.join(repo, 'src/services/sunoIntake.js')).href),
    import(pathToFileURL(path.join(repo, 'src/services/sunoIntakeProbe.mjs')).href),
  ])
  return { ...intake, ...probe }
}

function clock(sec) {
  const m = Math.floor(sec / 60)
  const s = (sec - m * 60).toFixed(1).padStart(4, '0')
  return `${String(m).padStart(2, '0')}:${s}`
}

function shotTable(shots) {
  const rows = shots.map((s, i) => {
    const lyric = s.lyric?.length ? String(s.lyric.join(' / ')).slice(0, 52) : '—'
    return `  ${String(i + 1).padStart(3)}  ${clock(s.startSec)}  ${String(s.seconds).padStart(5)}s  ${lyric}`
  })
  return ['  shot   start   len    lyric', ...rows].join('\n')
}

;(async () => {
  if (!FFPROBE) {
    log('fatal: ffprobe not found. Set FFPROBE=/path/to/ffprobe.')
    process.exit(1)
  }
  const intake = await loadIntake()

  const probe = intake.probeSunoTrack(ARGS.audio, { ffprobeBin: FFPROBE })
  log(`track: ${path.basename(ARGS.audio)}  ${probe.durationSec.toFixed(2)}s  "${probe.title || 'untitled'}"`)
  log(`lyrics: ${probe.lyricsRaw.trim() ? `${probe.lyricsRaw.trim().split('\n').length} lines in the file tags` : 'none in the file — timing-only script'}`)

  // Decide how much audio this run is allowed to touch.
  let renderSeconds = probe.durationSec
  if (!ARGS.full && (ARGS.limit > 0 || ARGS.maxSeconds > 0)) {
    const preview = intake.tileShots(intake.parseLyricBlocks(probe.lyricsRaw, probe.durationSec), probe.durationSec, { targetSec: ARGS.target })
    if (ARGS.limit > 0) {
      if (ARGS.limit > preview.length) {
        log(`fatal: --limit ${ARGS.limit} but the track only tiles into ${preview.length} shots.`)
        process.exit(1)
      }
      const last = preview[ARGS.limit - 1]
      renderSeconds = last.startSec + last.seconds
      log(`limit: first ${ARGS.limit} shots end at ${renderSeconds.toFixed(2)}s`)
    }
    if (ARGS.maxSeconds > 0) {
      renderSeconds = Math.min(renderSeconds, ARGS.maxSeconds)
      log(`cap: excerpt is ${renderSeconds.toFixed(2)}s`)
    }
  } else if (!ARGS.full && !ARGS.planOnly) {
    log('fatal: --run needs --limit or --max-seconds (one-shot testing only). Use --full for a whole track.')
    process.exit(1)
  }

  const needsCut = renderSeconds < probe.durationSec - 0.05
  let audioForRun = ARGS.audio
  if (needsCut) {
    if (!FFMPEG) {
      log('fatal: cutting an excerpt needs ffmpeg. Set FFMPEG=/path/to/ffmpeg, or pass a shorter file.')
      process.exit(1)
    }
    audioForRun = path.join(runDir, `${path.basename(ARGS.audio, path.extname(ARGS.audio))}.excerpt${path.extname(ARGS.audio) || '.m4a'}`)
    const cut = spawnSync(FFMPEG, ['-y', '-i', ARGS.audio, '-t', renderSeconds.toFixed(3), '-c:a', 'aac', '-b:a', '192k', audioForRun], { encoding: 'utf8' })
    if (cut.status !== 0) {
      log(`fatal: ffmpeg could not cut the excerpt: ${(cut.stderr || '').slice(-300)}`)
      process.exit(1)
    }
    log(`excerpt: ${renderSeconds.toFixed(2)}s → ${path.relative(process.cwd(), audioForRun)}`)
  }

  const script = intake.generateSunoScript({
    durationSec: renderSeconds,
    lyricsRaw: probe.lyricsRaw,
    style: ARGS.style,
    targetSec: ARGS.target,
    title: probe.title,
  })
  const shots = intake.tileShots(intake.parseLyricBlocks(probe.lyricsRaw, renderSeconds), renderSeconds, { targetSec: ARGS.target })
  const issues = intake.auditTiling(shots, renderSeconds)
  if (issues.length) {
    log(`fatal: tiling refused — ${issues.map((i) => i.message).join('; ')}`)
    process.exit(1)
  }

  const scriptPath = path.join(runDir, 'script.txt')
  fs.writeFileSync(scriptPath, script)
  const planPath = path.join(runDir, 'plan.json')
  fs.writeFileSync(planPath, JSON.stringify({
    audio: path.resolve(audioForRun),
    sourceAudio: path.resolve(ARGS.audio),
    title: probe.title,
    durationSec: renderSeconds,
    targetSec: ARGS.target,
    style: ARGS.style,
    shots,
    createdAt: new Date().toISOString(),
  }, null, 2))

  log(`${shots.length} shots, gapless, covering 0 → ${renderSeconds.toFixed(2)}s`)
  console.log(shotTable(shots))
  log(`script: ${scriptPath}`)
  log(`plan:   ${planPath}`)

  if (ARGS.planOnly) {
    log('plan only — nothing queued. Add --run --limit 3 to make test clips.')
    fs.writeFileSync(path.join(runDir, 'oneshot-run.log'), logLines.join('\n') + '\n')
    console.log(`\nopen the script:  ${scriptPath}`)
    return
  }

  const chainRunner = path.join(HERE, 'run-oneshot-chain.mjs')
  const childArgs = [
    chainRunner,
    '--audio', audioForRun,
    '--script', scriptPath,
    '--duration', String(renderSeconds),
    '--chunk', String(ARGS.chunk),
    '--seed', String(ARGS.seed),
    '--repo', ARGS.repo,
  ]
  if (ARGS.style) childArgs.push('--style', ARGS.style)
  if (ARGS.image) childArgs.push('--image', ARGS.image)

  log(`queueing test clips via ${path.relative(process.cwd(), chainRunner)}`)
  const child = spawnSync(process.execPath, childArgs, {
    stdio: 'inherit',
    env: { ...process.env, COMFY: ARGS.comfy },
  })
  fs.writeFileSync(path.join(runDir, 'oneshot-run.log'), logLines.join('\n') + '\n')
  log(`chain runner exited with ${child.status}`)
  process.exit(child.status ?? 1)
})().catch((error) => {
  log(`fatal: ${error?.stack || error}`)
  try { fs.writeFileSync(path.join(runDir, 'oneshot-run.log'), logLines.join('\n') + '\n') } catch { /* ignore */ }
  process.exit(1)
})
