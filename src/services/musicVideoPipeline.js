/**
 * Music Video Pipeline — W22 Implementation
 *
 * Orchestrates the full m4a → plan.json pipeline:
 *  1. Suno intake (metadata + lyrics extraction)
 *  2. Audio analysis (envelope → beat timestamps + sections)
 *  3. Imagination engine (two-pass: plot → per-shot CSV with required columns)
 *  4. V-gate validation (ltx_prompt_lint.py grammar + schema validator + one repair retry)
 *  5. Emit plan.json conforming to frozen shotPlan.schema.json
 *
 * Extended for W22 app integration:
 *  - Project folder layout with song-id derivation
 *  - Per-shot state tracking for resume/pause/cancel
 *  - Llama sidecar integration for local LLM backend
 *  - Full IPC surface: music-video:start/resume/pause/cancel/get-state/list-projects
 *
 * Emits IPC events for UI progress:
 *   mv:progress     { stage, progress, message, detail }
 *   mv:shot-done    { shotIndex, totalShots, shot }
 *   mv:error        { stage, error, recoverable }
 *   mv:complete     { planPath, plan }
 *   mv:script-ready { songId, plan, plot, script }
 *   mv:cancelled    { songId }
 *   mv:paused       { songId }
 *   mv:resumed      { songId }
 */
import { parseLyricBlocks, tileShots, auditTiling, harvestCastSlugs, generateSunoScript } from './sunoIntake.js'
import { analyzeEnvelopeFFmpeg } from './audioAnalysis.js'
import { compilePlot, compileShots } from './actionProse.mjs'
import { validatePlan } from './shotPlanValidator.js'
import { getModelCatalog } from './modelCatalog.js'
import { compilePromptRequest } from './promptCompiler.js'
import { readFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { mkdir, writeFile, readFile, stat, readdir, rm, appendFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire as _createRequire } from 'node:module'
const nodeRequire = _createRequire(import.meta.url)

/**
 * Electron's `app` is optional: this module must also load under plain Node
 * (tests, CLI, and any host without Electron). A named `import { app }` would
 * throw at load time in those contexts, so probe it lazily instead.
 */
function electronApp() {
  try {
    const pkg = nodeRequire('electron')
    return pkg?.app || pkg?.default?.app || null
  } catch {
    return null
  }
}
import Ajv2020 from 'ajv/dist/2020.js'
import { clipsFromPlan, clipFileName, coveredShots, renderPlanClips, stitchRenderedClips } from './musicVideoRender.js'

// ═══════════════════════════════════════════
// Schema Validation
// ═══════════════════════════════════════════

const SCHEMA_PATH = resolve('src/schema/shotPlan.schema.json')
const AJV = new Ajv2020({ strict: true, allowUnionTypes: false, allErrors: true })
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
const VALIDATE = AJV.compile(SCHEMA)

// ═══════════════════════════════════════════
// Stage Weights for Progress Reporting
// ═══════════════════════════════════════════

const STAGE_WEIGHTS = {
  intake: 0.10,
  audio: 0.15,
  plot: 0.20,
  shots: 0.30,
  validate: 0.15,
  emit: 0.10,
}

function emitProgress(win, stage, progress, message, detail = {}) {
  // The render phase has its own bar: plan progress already reached 0.99, so
  // folding clips into the plan weights would either stall at 99% or produce
  // NaN for a stage the plan table does not know.
  if (stage === 'render' || stage === 'stitch') {
    win?.webContents.send('mv:progress', { stage, progress, overall: progress, phase: 'render', message, detail })
    return
  }
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

function emitScriptReady(win, songId, plan, plot, script) {
  win?.webContents.send('mv:script-ready', { songId, plan, plot, script })
}

// ═══════════════════════════════════════════
// Project Layout & State Management
// ═══════════════════════════════════════════

const PROJECTS_DIR_NAME = 'music-video-projects'
const STATE_FILE_NAME = 'state.json'
const PLAN_FILE_NAME = 'plan.json'
const SHOTS_DIR_NAME = 'shots'
const RENDERS_DIR_NAME = 'renders'
const FINAL_DIR_NAME = 'final'
const LOGS_DIR_NAME = 'logs'

const SHOT_STATUS = {
  PENDING: 'pending',
  QUEUED: 'queued',
  RENDERING: 'rendering',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
}

const PROJECT_STATUS = {
  INITIALIZING: 'initializing',
  ANALYZING_AUDIO: 'analyzing_audio',
  GENERATING_SCRIPT: 'generating_script',
  READY_TO_RENDER: 'ready_to_render',
  RENDERING: 'rendering',
  STITCHING: 'stitching',
  COMPLETE: 'complete',
  ERROR: 'error',
  CANCELLED: 'cancelled',
}

function getProjectsRoot() {
  const userData = electronApp()?.getPath('userData')
  return join(userData, PROJECTS_DIR_NAME)
}

async function ensureProjectsRoot() {
  return mkdir(getProjectsRoot(), { recursive: true })
}

/**
 * Derive a stable song-id from audio file metadata + content hash.
 * Format: <title-slug>_<artist-slug>_<hash8>
 * Falls back to filename hash if metadata unavailable.
 */
export async function deriveSongId(audioFilePath, metadata = {}) {
  const { title, artist } = metadata
  const fileStat = await stat(audioFilePath)
  const fileSize = fileStat.size

  const hash = createHash('sha256')
  const stream = createReadStream(audioFilePath, {
    start: 0,
    end: Math.min(65535, fileSize - 1),
  })

  for await (const chunk of stream) {
    hash.update(chunk)
  }

  if (fileSize > 131072) {
    const endStream = createReadStream(audioFilePath, {
      start: fileSize - 65536,
      end: fileSize - 1,
    })
    for await (const chunk of endStream) {
      hash.update(chunk)
    }
  }

  hash.update(String(fileSize))
  const contentHash = hash.digest('hex').slice(0, 8)

  const slugify = (str) =>
    String(str || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)

  const titleSlug = slugify(title) || 'unknown-title'
  const artistSlug = slugify(artist) || 'unknown-artist'

  return `${titleSlug}_${artistSlug}_${contentHash}`
}

/**
 * Create a new music video project structure.
 */
export async function createProject(audioFilePath, metadata = {}, options = {}) {
  const { existingSongId, plan } = options

  const songId = existingSongId || (await deriveSongId(audioFilePath, metadata))
  const projectPath = join(getProjectsRoot(), songId)

  await mkdir(projectPath, { recursive: true })
  await mkdir(join(projectPath, SHOTS_DIR_NAME), { recursive: true })
  await mkdir(join(projectPath, RENDERS_DIR_NAME), { recursive: true })
  await mkdir(join(projectPath, FINAL_DIR_NAME), { recursive: true })
  await mkdir(join(projectPath, LOGS_DIR_NAME), { recursive: true })

  const now = Date.now()
  const state = {
    schemaVersion: 1,
    songId,
    audioFile: audioFilePath,
    metadata: {
      title: metadata.title || '',
      artist: metadata.artist || '',
      durationSec: metadata.durationSec || 0,
      bpm: metadata.bpm || 0,
      hash: metadata.hash || '',
    },
    status: PROJECT_STATUS.INITIALIZING,
    createdAt: now,
    updatedAt: now,
    shots: [],
    currentShotIndex: -1,
    renderCalibration: null,
    etaSec: null,
    error: null,
    llm: {
      backend: options.llmBackend || 'local',
      modelId: options.llmModelId || '',
      endpoint: '',
      pid: 0,
      logPath: '',
      grammarEnforced: false,
      repairRetries: 0,
    },
    pipelineOptions: {
      engine: options.engine || 'ltx23',
      quality: options.quality || 'high',
    },
  }

  await writeFile(join(projectPath, STATE_FILE_NAME), JSON.stringify(state, null, 2), 'utf8')

  if (plan) {
    await writeFile(join(projectPath, PLAN_FILE_NAME), JSON.stringify(plan, null, 2), 'utf8')
    await initializeShotStates(projectPath, plan)
  }

  return { projectPath, songId, state }
}

async function initializeShotStates(projectPath, plan) {
  const shotsDir = join(projectPath, SHOTS_DIR_NAME)
  const statePath = join(projectPath, STATE_FILE_NAME)

  const shotStates = (plan.shots || []).map((shot, index) => ({
    index,
    shotId: shot.id || `shot_${String(index + 1).padStart(3, '0')}`,
    status: SHOT_STATUS.PENDING,
    prompt: shot.prompt || '',
    action: shot.action || '',
    startSec: shot.startSec || 0,
    endSec: shot.endSec || 0,
    renderPath: null,
    thumbnailPath: null,
    error: null,
    attempts: 0,
    startedAt: null,
    completedAt: null,
  }))

  for (const shotState of shotStates) {
    const shotFile = join(shotsDir, `${shotState.shotId}.json`)
    await writeFile(shotFile, JSON.stringify(shotState, null, 2), 'utf8')
  }

  const stateContent = await readFile(statePath, 'utf8')
  const state = JSON.parse(stateContent)
  state.shots = shotStates.map((s) => ({
    shotId: s.shotId,
    status: s.status,
    startSec: s.startSec,
    endSec: s.endSec,
  }))
  state.status = PROJECT_STATUS.READY_TO_RENDER
  state.updatedAt = Date.now()
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
}

/**
 * Load project state from disk.
 */
export async function loadProjectState(songId) {
  const projectPath = join(getProjectsRoot(), songId)
  const statePath = join(projectPath, STATE_FILE_NAME)

  try {
    const content = await readFile(statePath, 'utf8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

/**
 * Update project status and optionally other fields.
 */
export async function updateProjectState(songId, updates) {
  const projectPath = join(getProjectsRoot(), songId)
  const statePath = join(projectPath, STATE_FILE_NAME)

  let state
  try {
    const content = await readFile(statePath, 'utf8')
    state = JSON.parse(content)
  } catch {
    throw new Error(`Project not found: ${songId}`)
  }

  state.updatedAt = Date.now()
  Object.assign(state, updates)

  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
  return state
}

/**
 * Update a single shot's state.
 */
export async function updateShotState(songId, shotId, updates) {
  const projectPath = join(getProjectsRoot(), songId)
  const shotFile = join(projectPath, SHOTS_DIR_NAME, `${shotId}.json`)
  const statePath = join(projectPath, STATE_FILE_NAME)

  let shotState
  try {
    const content = await readFile(shotFile, 'utf8')
    shotState = JSON.parse(content)
  } catch {
    throw new Error(`Shot not found: ${shotId}`)
  }

  if (updates.status === SHOT_STATUS.RENDERING && !shotState.startedAt) {
    updates.startedAt = Date.now()
  }
  if (updates.status === SHOT_STATUS.DONE && !shotState.completedAt) {
    updates.completedAt = Date.now()
  }
  if (updates.status === SHOT_STATUS.ERROR) {
    updates.attempts = (shotState.attempts || 0) + 1
  }

  Object.assign(shotState, updates)
  await writeFile(shotFile, JSON.stringify(shotState, null, 2), 'utf8')

  const stateContent = await readFile(statePath, 'utf8')
  const state = JSON.parse(stateContent)
  const shotIndex = state.shots.findIndex((s) => s.shotId === shotId)
  if (shotIndex >= 0) {
    state.shots[shotIndex] = {
      ...state.shots[shotIndex],
      status: shotState.status,
      renderPath: shotState.renderPath,
      thumbnailPath: shotState.thumbnailPath,
      error: shotState.error,
    }
    state.updatedAt = Date.now()
    await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
  }

  return shotState
}

/**
 * Get the next pending shot index for rendering.
 */
export async function getNextPendingShot(songId) {
  const state = await loadProjectState(songId)
  if (!state) return null

  const pendingIndex = state.shots.findIndex((s) => s.status === SHOT_STATUS.PENDING)
  if (pendingIndex >= 0) return pendingIndex

  const retryIndex = state.shots.findIndex(
    (s) => s.status === SHOT_STATUS.ERROR && (s.attempts || 0) < 3
  )
  return retryIndex >= 0 ? retryIndex : null
}

/**
 * Mark all shots as cancelled (for pause/cancel).
 */
export async function cancelAllPendingShots(songId) {
  const state = await loadProjectState(songId)
  if (!state) return

  for (const shot of state.shots) {
    if (shot.status === SHOT_STATUS.PENDING || shot.status === SHOT_STATUS.QUEUED || shot.status === SHOT_STATUS.RENDERING) {
      await updateShotState(songId, shot.shotId, { status: SHOT_STATUS.CANCELLED })
    }
  }

  await updateProjectState(songId, { status: PROJECT_STATUS.CANCELLED })
}

/**
 * Resume a project — find next shot to render.
 */
export async function resumeProject(songId) {
  const state = await loadProjectState(songId)
  if (!state) return null

  const nextIndex = await getNextPendingShot(songId)
  if (nextIndex === null) {
    const allDone = state.shots.every((s) => s.status === SHOT_STATUS.DONE)
    if (allDone && state.status !== PROJECT_STATUS.COMPLETE) {
      await updateProjectState(songId, { status: PROJECT_STATUS.STITCHING })
      return { action: 'stitch' }
    }
    return { action: 'complete' }
  }

  await updateProjectState(songId, { status: PROJECT_STATUS.RENDERING, currentShotIndex: nextIndex })
  return { action: 'render', shotIndex: nextIndex }
}

/**
 * Get project paths for a songId.
 */
export function getProjectPaths(songId) {
  const projectPath = join(getProjectsRoot(), songId)
  return {
    root: projectPath,
    shots: join(projectPath, SHOTS_DIR_NAME),
    renders: join(projectPath, RENDERS_DIR_NAME),
    final: join(projectPath, FINAL_DIR_NAME),
    logs: join(projectPath, LOGS_DIR_NAME),
    state: join(projectPath, STATE_FILE_NAME),
    plan: join(projectPath, PLAN_FILE_NAME),
  }
}

/**
 * List all existing projects.
 */
export async function listProjects() {
  const root = getProjectsRoot()
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const projects = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const state = await loadProjectState(entry.name)
        if (state) {
          projects.push({
            songId: entry.name,
            title: state.metadata?.title || '',
            artist: state.metadata?.artist || '',
            status: state.status,
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
            shotCount: state.shots?.length || 0,
            completedShots: state.shots?.filter((s) => s.status === SHOT_STATUS.DONE).length || 0,
          })
        }
      }
    }
    return projects.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

/**
 * Delete a project entirely.
 */
export async function deleteProject(songId) {
  const projectPath = join(getProjectsRoot(), songId)
  await rm(projectPath, { recursive: true, force: true })
}

export { SHOT_STATUS, PROJECT_STATUS, getProjectsRoot }

// ═══════════════════════════════════════════
// Suno Metadata Extraction
// ═══════════════════════════════════════════

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

// ═══════════════════════════════════════════
// Main Pipeline Entry Point
// ═══════════════════════════════════════════

/**
 * Main pipeline entry point.
 * @param {Object} opts - { filePath, win (BrowserWindow), options }
 * @returns {Promise<{ planPath, plan, songId, projectPath }>}
 */
export async function runMusicVideoPipeline({ filePath, win, options = {} }) {
  const {
    style = 'mtv-1990s',
    creativePreset = 'narrative',
    backend = 'local',
    modelId = null,
    targetSec = 5,
    outputDir = null,
    llmBackend = backend,
    llmModelId = modelId,
    engine = 'ltx23',
    quality = 'high',
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
    const analysis = await analyzeEnvelopeFFmpeg({ absolutePath: filePath })
    emitProgress(win, 'audio', 0.6, `Envelope: ${analysis.durationSec.toFixed(1)}s, ${analysis.onsets?.length ?? 0} onsets, ${analysis.sections?.length ?? 0} sections`)

    const sections = analysis.sections
    emitProgress(win, 'audio', 1.0, `Audio done: ${sections.length} sections detected`)

    // ═══════════════════════════════════
    // Create project folder structure
    // ═══════════════════════════════════
    emitProgress(win, 'project', 0.1, 'Creating project folders…')
    const metadata = {
      title,
      artist,
      durationSec,
      bpm: analysis.bpm || 0,
      hash: analysis.hash || '',
    }

    const { songId, projectPath } = await createProject(filePath, metadata, {
      llmBackend,
      llmModelId,
      engine,
      quality,
    })

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
      beats: [],
      style,
      creativePreset,
      castSlugs,
    }, { backend: llmBackend, modelId: llmModelId, win })
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
      beats: [],
      shots: shots.map(s => ({ startSec: s.startSec, endSec: s.endSec, lyric: s.lyric })),
      style,
      creativePreset,
      castSlugs,
    }, { backend: llmBackend, modelId: llmModelId, win, onShot: (shot, idx, total) => emitShotDone(win, idx, total, shot) })
    emitProgress(win, 'shots', 1.0, `Shots done: ${shotPlan.shots.length}`)

    // ═══════════════════════════════════
    // STAGE 5: V-Gate Validation (grammar + schema + one repair)
    // ═══════════════════════════════════
    emitProgress(win, 'validate', 0.1, 'Validating plan (V-gate)…')
    plan = await validatePlan(shotPlan, { backend: llmBackend, modelId: llmModelId, win })
    emitProgress(win, 'validate', 1.0, `Validation passed (repairs: ${plan.llm?.repairRetries ?? 0})`)

    // Inject audio metadata into plan
    plan.track.path = filePath
    plan.track.hash = analysis.hash || ''
    plan.track.bpm = analysis.bpm || 0
    plan.track.beats = analysis.onsets || []
    plan.track.sections = analysis.sections || []
    plan.track.profileSource = 'envelope'

    // Add llm field to plan
    plan.llm = {
      ...plan.llm,
      backend: llmBackend,
      modelId: llmModelId,
      endpoint: '',
      pid: 0,
      logPath: '',
      grammarEnforced: true,
      repairRetries: plan.llm?.repairRetries ?? 0,
    }

    // ═══════════════════════════════════
    // STAGE 6: Emit plan.json
    // ═══════════════════════════════════
    emitProgress(win, 'emit', 0.1, 'Writing plan.json…')
    const outDir = outputDir || projectPath
    await mkdir(outDir, { recursive: true })
    planPath = resolve(outDir, 'plan.json')
    await writeFile(planPath, JSON.stringify(plan, null, 2))

    // Initialize shot states for rendering
    await initializeShotStates(projectPath, plan)

    emitProgress(win, 'emit', 1.0, `Plan written to ${planPath}`)

    // Emit script-ready event for the Generate Script Modal
    const script = {
      shots: shots.map(s => ({ startSec: s.startSec, endSec: s.endSec, lyric: s.lyric })),
      shotCount: shots.length,
      hasLyrics: lyricsRaw.length > 0,
      lyricSource: lyricsRaw.length > 0 ? 'file' : 'none',
      durationSec,
      title,
    }
    emitScriptReady(win, songId, plan, plot, script)

    emitComplete(win, planPath, plan)
    return { planPath, plan, songId, projectPath }

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

// ═══════════════════════════════════════════
// Render phase (plan.json → clips → final mp4)
// ═══════════════════════════════════════════

/**
 * In-process cancel flags. On-disk state says "cancelled" for the UI; this map
 * is what makes a long-running render loop actually stop between clips.
 */
const cancelFlags = new Map()

export function requestCancel(songId, on = true) {
  cancelFlags.set(String(songId), !!on)
}

export function isCancelRequested(songId) {
  return !!cancelFlags.get('*') || !!cancelFlags.get(String(songId))
}

/** Clear every flag — used when the user presses resume. */
export function clearCancelFlags() {
  cancelFlags.clear()
}

async function loadPlanForProject(songId) {
  const paths = getProjectPaths(songId)
  let plan
  try {
    plan = JSON.parse(await readFile(paths.plan, 'utf8'))
  } catch (err) {
    throw new Error(`project ${songId} has no readable plan.json — the script stage must finish first (${err.message})`)
  }
  return { plan, paths }
}

function projectLogger(paths) {
  const logFile = join(paths.logs, 'render.log')
  return (entry) => {
    const line = `${new Date().toISOString()} ${JSON.stringify(entry)}\n`
    appendFile(logFile, line).catch(() => {})
  }
}

/**
 * Render a project's clips and stitch the final video.
 *
 * The GPU gate stays on. A click on Render is the user's go, so the go flag is
 * set for this call's environment only — never written into the app's global
 * process.env, which would silently permit every later render.
 */
export async function renderProjectClips({ songId, win = null, options = {}, env = process.env, gate = true } = {}) {
  const { plan, paths } = await loadPlanForProject(songId)
  await mkdir(paths.renders, { recursive: true })
  await mkdir(paths.logs, { recursive: true })

  const state = await loadProjectState(songId)
  const renderEnv = gate ? { ...env, BELROG_GPU_GO: env.BELROG_GPU_GO || '1' } : env
  const log = projectLogger(paths)
  requestCancel(songId, false)

  await updateProjectState(songId, { status: PROJECT_STATUS.RENDERING, error: null })

  const totalClips = (plan.clips || []).length
  let finished = 0

  const result = await renderPlanClips(plan, paths.renders, {
    env: renderEnv,
    gate,
    options: { ...options, quality: state?.pipelineOptions?.quality },
    log,
    shotStates: state?.shots || [],
    shouldCancel: async () => isCancelRequested(songId),
    onClip: async (res) => {
      finished += 1
      const ids = res.shotIds || coveredShots(plan, { shotIds: [], index: res.clipIndex })
      for (const shotId of ids) {
        await updateShotState(songId, shotId, res.ok === false
          ? { status: SHOT_STATUS.ERROR, error: res.error || 'render failed' }
          : { status: SHOT_STATUS.DONE, renderPath: res.outPath })
      }
      win?.webContents.send('mv:shot-done', {
        shotIndex: finished,
        totalShots: totalClips,
        clipIndex: res.clipIndex,
        shot: { id: ids, renderPath: res.outPath, skipped: !!res.skipped, error: res.error || null },
      })
      emitProgress(win, 'render', finished / Math.max(1, totalClips), `Clip ${res.clipIndex + 1} of ${totalClips}${res.skipped ? ' (already rendered)' : ''}`, {
        etaSec: res.report?.etaSec ?? null,
        renderTimeMs: res.renderTimeMs ?? null,
      })
    },
  })

  if (result.cancelled) {
    await updateProjectState(songId, { status: PROJECT_STATUS.CANCELLED })
    win?.webContents.send('mv:cancelled', { songId })
    return { ok: false, cancelled: true, results: result.results }
  }

  if (result.failed?.length) {
    const message = result.failed.map((f) => `clip ${f.clipIndex}: ${f.error}`).join('; ')
    await updateProjectState(songId, { status: PROJECT_STATUS.ERROR, error: message })
    emitError(win, 'render', message, true)
    return { ok: false, failed: result.failed, results: result.results }
  }

  const stitched = await stitchRenderedClips({
    plan,
    results: result.results,
    outPath: join(paths.final, `${songId}.mp4`),
    ffmpegPath: options.ffmpegPath,
    ffprobePath: options.ffprobePath,
    env: renderEnv,
    onProgress: (p) => emitProgress(win, 'stitch', 0.5, 'Stitching clips and laying the track…', p),
  })

  await writeFile(join(paths.final, 'stitch-report.json'), JSON.stringify(stitched, null, 2))
  await updateProjectState(songId, { status: PROJECT_STATUS.COMPLETE, currentShotIndex: -1 })
  win?.webContents.send('mv:video-ready', {
    songId,
    videoPath: stitched.outPath,
    drift: stitched.drift,
    command: stitched.command,
  })
  log({ phase: 'stitched', outPath: stitched.outPath, drift: stitched.drift })

  return { ok: true, videoPath: stitched.outPath, drift: stitched.drift, results: result.results }
}

/**
 * Resume a project and render whatever is left, then stitch.
 * Safe to call twice: clips already on disk with an agreeing report are skipped.
 */
export async function resumeAndRender({ songId, win, options = {}, env = process.env } = {}) {
  const state = await loadProjectState(songId)
  if (!state) throw new Error('Project not found')

  const allDone = (state.shots || []).length > 0 && state.shots.every((s) => s.status === SHOT_STATUS.DONE)
  if (allDone && state.status === PROJECT_STATUS.COMPLETE) {
    const paths = getProjectPaths(songId)
    return { ok: true, alreadyComplete: true, videoPath: join(paths.final, `${songId}.mp4`) }
  }

  return renderProjectClips({ songId, win, options, env })
}

/**
 * Render one clip by index — the "retry this one" path from the UI.
 * Marks its shots done; does not stitch (call stitchFinal after).
 */
export async function renderSingleShot(songId, shot, shotIndex, plan, options = {}) {
  const paths = getProjectPaths(songId)
  const storedPlan = plan || JSON.parse(await readFile(paths.plan, 'utf8'))
  const clips = clipsFromPlan(storedPlan)
  const clip = clips.find((c) => c.index === shotIndex) || clips[shotIndex]
  if (!clip) throw new Error(`clip ${shotIndex} is not in this plan (it has ${clips.length} clips)`)

  const result = await renderPlanClips({ ...storedPlan, clips: [clip] }, paths.renders, {
    env: options.env || process.env,
    gate: options.gate !== false,
    options,
    log: projectLogger(paths),
  })
  const first = result.results[0]
  if (!first?.ok && !first?.skipped) throw new Error(first?.error || `clip ${clip.index} did not render`)
  for (const shotId of coveredShots(storedPlan, clip)) {
    await updateShotState(songId, shotId, { status: SHOT_STATUS.DONE, renderPath: first.outPath })
  }
  return first.outPath
}

/**
 * Stitch already-rendered clips. Re-reads the plan so the cut order comes from
 * the plan, never from whatever order the files happen to be in on disk.
 */
export async function stitchFinal(songId, { env = process.env, win = null } = {}) {
  const { plan, paths } = await loadPlanForProject(songId)
  await updateProjectState(songId, { status: PROJECT_STATUS.STITCHING })

  const clips = clipsFromPlan(plan)
  const results = []
  for (const clip of clips) {
    const outPath = join(paths.renders, clipFileName(clip))
    try {
      const s = await stat(outPath)
      if (!s.size) throw new Error('empty file')
      results.push({ clipIndex: clip.index, outPath, ok: true })
    } catch (err) {
      await updateProjectState(songId, { status: PROJECT_STATUS.ERROR, error: `clip ${clip.index} is not rendered (${err.message})` })
      throw new Error(`cannot stitch: clip ${clip.index} has no render in ${paths.renders}`)
    }
  }

  const stitched = await stitchRenderedClips({
    plan,
    results,
    outPath: join(paths.final, `${songId}.mp4`),
    env,
  })
  await writeFile(join(paths.final, 'stitch-report.json'), JSON.stringify(stitched, null, 2))
  await updateProjectState(songId, { status: PROJECT_STATUS.COMPLETE })
  win?.webContents.send('mv:video-ready', { songId, videoPath: stitched.outPath, drift: stitched.drift })
  return stitched.outPath
}
// IPC handlers are registered in electron/musicVideoIpc.js (thin wrappers here).
// Do NOT register ipcMain handlers in this file — the IPC contract test
// (tests/ipcChannelContract.test.mjs) scans electron/ only for handler calls.
