/**
 * Music Video Pipeline — W-A Implementation
 *
 * Orchestrates the full m4a → plan.json pipeline:
 *  1. Suno intake (metadata + lyrics extraction)
 *  2. Audio analysis (envelope → beat timestamps + sections)
 *  3. Imagination engine (two-pass: plot → per-shot CSV with required columns)
 *  4. V-gate validation (ltx_prompt_lint.py grammar + schema validator + one repair retry)
 *  5. Emit plan.json conforming to frozen shotPlan.schema.json
 *
 * Emits IPC events for UI progress:
 *   mv:progress   { stage, progress, message, detail }
 *   mv:shot-done  { shotIndex, totalShots, shot }
 *   mv:error      { stage, error, recoverable }
 *   mv:complete   { planPath, plan }
 */
import { parseLyricBlocks, tileShots, auditTiling, harvestCastSlugs, generateSunoScript } from './sunoIntake.js'
import { analyzeAudioSource } from './audioAnalysis.js'
import { compilePlot, compileShots } from './actionProse.mjs'
import { validatePlan, repairPlan } from './shotPlanValidator.js'
import { getModelCatalog, downloadModel } from './modelCatalog.js'
import { compilePromptRequest } from './promptCompiler.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'

const SCHEMA_PATH = resolve('src/schema/shotPlan.schema.json')
const AJV = new Ajv2020({ strict: true, allowUnionTypes: false, allErrors: true })
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
const VALIDATE = AJV.compile(SCHEMA)

// Stage weights for progress reporting (sum = 1.0)
const STAGE_WEIGHTS = {
  intake: 0.10,
  audio: 0.15,
  plot: 0.20,
  shots: 0.30,
  validate: 0.15,
  emit: 0.10,
}

function emitProgress(win, stage, progress, message, detail = {}) {
  const weightSum = Object.values(STAGE_WEIGHTS).reduce((a, b) => a + b, 0)
  let cumulative = 0
  for (const [s, w] of Object.entries(STAGE_WEIGHTS)) {
    if (s === stage) break
    cumulative += w
  }
  const overall = Math.min(0.99, cumulative + progress * STAGE_WEIGHTS[stage])
  win?.webContents.send('mv:progress', { stage, progress, overall, message, detail })
}

function emitError(win, stage, error, recoverable = false) {
  win?.webContents.send('mv:error', { stage, error: String(error), recoverable })
}

function emitShotDone(win, shotIndex, totalShots, shot) {
  win?.webContents.send('mv:shot-done', { shotIndex, totalShots, shot })
}

function emitComplete(win, planPath, plan) {
  win?.webContents.send('mv:complete', { planPath, plan })
}

/**
 * Extract lyrics from m4a metadata using ffprobe.
 * Returns { lyricsRaw, durationSec, title, artist }.
 */
async function extractSunoMetadata(filePath) {
  const { spawn } = await import('node:child_process')
  const ffprobeStatic = await import('@derhuerst/ffprobe-static')
  const ffprobePath = ffprobeStatic.default?.path || ffprobeStatic.path

  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ])
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => stdout += d)
    proc.stderr.on('data', d => stderr += d)
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${stderr}`))
      try {
        const data = JSON.parse(stdout)
        const format = data.format || {}
        const tags = format.tags || {}
        const durationSec = Number(format.duration) || 0
        const lyricsRaw = tags.lyrics || tags['©lyr'] || tags['\xa9lyr'] || ''
        const title = tags.title || tags['©nam'] || ''
        const artist = tags.artist || tags['©ART'] || ''
        resolve({ lyricsRaw, durationSec, title, artist })
      } catch (e) {
        reject(new Error(`Failed to parse ffprobe output: ${e.message}`))
      }
    })
    proc.on('error', reject)
  })
}

/**
 * Detect song sections from audio envelope (loudness curve + silence + onsets).
 * Returns array of { id, kind, startSec, endSec, energy }.
 */
function detectSectionsFromEnvelope(analysis, durationSec) {
  const { loudnessCurve = [], beats = [], onsets = [], silences = [], bpm } = analysis
  if (!loudnessCurve.length) return []

  // Find energy peaks and valleys to segment
  const sections = []
  const minSectionSec = 8 // minimum section length
  let lastBoundary = 0

  // Use silence spans as hard boundaries
  const boundaries = [0]
  for (const s of silences) {
    if (s.duration >= 1.0 && s.start > lastBoundary + minSectionSec) {
      boundaries.push(s.start)
      lastBoundary = s.start
    }
  }
  boundaries.push(durationSec)

  // Classify each segment by energy profile and position
  const kindOrder = ['intro', 'verse', 'pre_chorus', 'chorus', 'bridge', 'breakdown', 'outro']
  let kindIndex = 0

  for (let i = 0; i < boundaries.length - 1; i++) {
    const startSec = boundaries[i]
    const endSec = boundaries[i + 1]
    if (endSec - startSec < 2) continue

    // Sample energy in this segment
    const segmentCurve = loudnessCurve.filter(p => p.time >= startSec && p.time < endSec)
    const avgEnergy = segmentCurve.length
      ? segmentCurve.reduce((s, p) => s + Math.pow(10, p.db / 10), 0) / segmentCurve.length
      : 0
    const normEnergy = Math.min(1, Math.max(0, (avgEnergy + 60) / 60)) // rough -60..0 dB → 0..1

    // Position-based kind assignment with energy override
    let kind = kindOrder[Math.min(kindIndex, kindOrder.length - 1)]
    if (i === 0) kind = 'intro'
    else if (i === boundaries.length - 2) kind = 'outro'
    else if (normEnergy > 0.7 && kindIndex < 3) kind = 'chorus'
    else if (normEnergy > 0.5 && kind === 'verse') kind = 'pre_chorus'
    else if (normEnergy < 0.3 && kind !== 'intro' && kind !== 'outro') kind = 'breakdown'

    sections.push({
      id: `${kind}-${i + 1}`,
      kind,
      startSec: Math.round(startSec * 10) / 10,
      endSec: Math.round(endSec * 10) / 10,
      energy: Math.round(normEnergy * 100) / 100,
    })
    kindIndex++
  }

  return sections
}

/**
 * Main pipeline entry point.
 * @param {Object} opts - { filePath, win (BrowserWindow), options }
 * @returns {Promise<{ planPath, plan }>}
 */
export async function runMusicVideoPipeline({ filePath, win, options = {} }) {
  const {
    style = 'mtv-1990s',
    creativePreset = 'narrative',
    backend = 'local',
    modelId = null, // null = auto-pick from catalog
    targetSec = 5,
    outputDir = null,
  } = options

  let plan = null
  let planPath = null

  try {
    // ═══════════════════════════════════
    // STAGE 1: Suno Intake (metadata + lyrics)
    // ═══════════════════════════════════
    emitProgress(win, 'intake', 0.1, 'Reading Suno metadata…')
    const { lyricsRaw, durationSec, title, artist } = await extractSunoMetadata(filePath)
    emitProgress(win, 'intake', 0.5, `Track: ${title || 'untitled'} (${durationSec.toFixed(1)}s)`)

    const blocks = parseLyricBlocks(lyricsRaw, durationSec)
    const shots = tileShots(blocks, durationSec, { targetSec })
    const issues = auditTiling(shots, durationSec)
    if (issues.length) throw new Error(`Tiling failed: ${issues.map(i => i.message).join('; ')}`)

    const castSlugs = harvestCastSlugs({ cast: [], lyricsRaw })
    emitProgress(win, 'intake', 1.0, `Intake done: ${shots.length} shots, ${castSlugs.length} cast`)

    // ═══════════════════════════════════
    // STAGE 2: Audio Analysis (envelope → beats + sections)
    // ═══════════════════════════════════
    emitProgress(win, 'audio', 0.1, 'Analyzing audio envelope…')
    const analysis = await analyzeAudioSource({ absolutePath: filePath }, {
      includeLoudnessCurve: true,
      maxCurvePoints: 400,
      silenceThresholdDb: -45,
      minSilenceSeconds: 0.35,
    })
    emitProgress(win, 'audio', 0.6, `BPM: ${analysis.bpm?.toFixed(1) ?? 'unknown'}, ${analysis.beats?.length ?? 0} beats`)

    const sections = detectSectionsFromEnvelope(analysis, durationSec)
    emitProgress(win, 'audio', 1.0, `Audio done: ${sections.length} sections detected`)

    // ═══════════════════════════════════
    // STAGE 3: Imagination Engine — Pass 1: Plot
    // ═══════════════════════════════════
    emitProgress(win, 'plot', 0.1, 'Generating narrative plot…')
    const plot = await compilePlot({
      title,
      artist,
      durationSec,
      lyricsRaw,
      sections,
      beats: analysis.beats,
      style,
      creativePreset,
      castSlugs,
    }, { backend, modelId, win })
    emitProgress(win, 'plot', 1.0, 'Plot generated')

    // ═══════════════════════════════════
    // STAGE 4: Imagination Engine — Pass 2: Per-shot CSV
    // ═══════════════════════════════════
    emitProgress(win, 'shots', 0.1, 'Generating per-shot plan…')
    const shotPlan = await compileShots({
      plot,
      title,
      durationSec,
      sections,
      beats: analysis.beats,
      shots: shots.map(s => ({ startSec: s.startSec, endSec: s.endSec, lyric: s.lyric })),
      style,
      creativePreset,
      castSlugs,
    }, { backend, modelId, win, onShot: (shot, idx, total) => emitShotDone(win, idx, total, shot) })
    emitProgress(win, 'shots', 1.0, `Shots done: ${shotPlan.shots.length}`)

    // ═══════════════════════════════════
    // STAGE 5: V-Gate Validation (grammar + schema + one repair)
    // ═══════════════════════════════════
    emitProgress(win, 'validate', 0.1, 'Validating plan (V-gate)…')
    plan = await validatePlan(shotPlan, { backend, modelId, win })
    emitProgress(win, 'validate', 1.0, `Validation passed (repairs: ${plan.llm?.repairRetries ?? 0})`)

    // ═══════════════════════════════════
    // STAGE 6: Emit plan.json
    // ═══════════════════════════════════
    emitProgress(win, 'emit', 0.1, 'Writing plan.json…')
    const outDir = outputDir || resolve('projects', `belrog_${Date.now()}`)
    await import('node:fs/promises').then(fs => fs.mkdir(outDir, { recursive: true }))
    planPath = resolve(outDir, 'plan.json')
    await import('node:fs/promises').then(fs => fs.writeFile(planPath, JSON.stringify(plan, null, 2)))
    emitProgress(win, 'emit', 1.0, `Plan written to ${planPath}`)

    emitComplete(win, planPath, plan)
    return { planPath, plan }

  } catch (err) {
    emitError(win, 'pipeline', err, false)
    throw err
  }
}

/**
 * Convenience: run pipeline headless (no UI window) for CLI/testing.
 */
export async function runMusicVideoPipelineHeadless(filePath, options = {}) {
  return runMusicVideoPipeline({ filePath, win: null, options })
}