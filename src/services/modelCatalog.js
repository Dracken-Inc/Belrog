/**
 * Model Catalog — GGUF Presets, VRAM Fit, First-Run Decision
 *
 * Curated presets with exact metadata for local llama-server sidecar.
 * VRAM envelope: 4-6 GB working set. Default pick: Mistral-7B Q4_K_M.
 * Download delegates to electron/remoteModelInstall.js (resume, checksum, progress).
 */

import { downloadLocalModel, computeLocalSha256 } from '../../electron/remoteModelInstall.js'
import { join } from 'node:path'
import { mkdir, stat, readdir } from 'node:fs/promises'

// ═══════════════════════════════════════════
// Curated Presets (exact metadata per spec)
// ═══════════════════════════════════════════

export const MODEL_PRESETS = [
  {
    id: 'mistral-7b-instruct-v0.3.Q4_K_M',
    name: 'Mistral 7B Instruct v0.3 Q4_K_M',
    description: 'Default pick — strong creative prose, ~5.4 GB VRAM working set',
    repo: 'lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF',
    filename: 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
    sizeBytes: 4372812000,
    vramGB: 5.4,
    sha256: '1270d22c0fbb3d092fb725d4d96c457b7b687a5f5a715abe1e818da303e562b6',
    hfCommit: 'main',
    contextLength: 32768,
    tags: ['creative', 'default', 'fast'],
  },
  {
    id: 'meta-llama-3.1-8b-instruct.Q4_K_M',
    name: 'Meta Llama 3.1 8B Instruct Q4_K_M',
    description: 'Solid reasoning + creative, ~6.0 GB VRAM working set',
    repo: 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF',
    filename: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    sizeBytes: 4920739168,
    vramGB: 6.0,
    sha256: 'f2be3e1a239c12c9f3f01a962b11fb2807f8032fdb63b0a5502ea42ddef55e44',
    hfCommit: 'main',
    contextLength: 131072,
    tags: ['reasoning', 'large-context'],
  },
  {
    id: 'mistral-nemo-instruct-2407.Q2_K',
    name: 'Mistral Nemo Instruct 2407 Q2_K',
    description: 'Smaller quant, ~6.0 GB VRAM — sha256 is SINGLE-SOURCED (not independently confirmed)',
    repo: 'unsloth/Mistral-Nemo-Instruct-2407-GGUF',
    filename: 'Mistral-Nemo-Instruct-2407-Q2_K.gguf',
    sizeBytes: 4791047712,
    vramGB: 6.0,
    sha256: 'e2631c7397d90d3a5338f25d204e704f4acb65211fa225a0e48257e4c24cfc6e',
    sha256SingleSourced: true,
    hfCommit: 'main',
    contextLength: 131072,
    tags: ['compact', 'single-sourced-hash'],
  },
]

// ═══════════════════════════════════════════
// VRAM Detection
// ═══════════════════════════════════════════

let cachedVramGB = null

/**
 * Detect available VRAM in GB.
 * Returns null when detection fails so UI can say "unknown" instead of guessing.
 */
export async function detectVramGb() {
  if (cachedVramGB !== null) return cachedVramGB

  try {
    // Try nvidia-smi first (Linux/Windows with NVIDIA)
    const { spawn } = await import('node:child_process')
    const proc = spawn('nvidia-smi', [
      '--query-gpu=memory.total',
      '--format=csv,noheader,nounits'
    ])

    let stdout = ''
    proc.stdout.on('data', d => stdout += d)
    await new Promise((resolve, reject) => {
      proc.on('close', code => code === 0 ? resolve() : reject(new Error('nvidia-smi failed')))
      proc.on('error', reject)
    })

    const totalMB = parseInt(stdout.trim().split('\n')[0], 10)
    if (Number.isFinite(totalMB) && totalMB > 0) {
      cachedVramGB = totalMB / 1024
      return cachedVramGB
    }
  } catch {}

  try {
    // Fallback: Apple Silicon unified memory
    const { spawn } = await import('node:child_process')
    const proc = spawn('system_profiler', ['SPDisplaysDataType', '-json'])
    let stdout = ''
    proc.stdout.on('data', d => stdout += d)
    await new Promise((resolve, reject) => {
      proc.on('close', code => code === 0 ? resolve() : reject())
      proc.on('error', reject)
    })
    const data = JSON.parse(stdout)
    for (const display of data.SPDisplaysDataType || []) {
      if (display.sppci_model?.includes('Apple') && display.spcores) {
        // Conservative estimate for M-series
        cachedVramGB = 8
        return cachedVramGB
      }
    }
  } catch {}

  // Detection failed — return null so caller knows it's unknown
  return null
}

/**
 * Filter presets to only those that fit within measured VRAM.
 * Envelope: 4-6 GB working set. Leaves 15% headroom for OS + other apps.
 */
export function getPresetsForVRAM(vramGB) {
  if (vramGB === null || vramGB === undefined) return []
  const safeLimit = vramGB * 0.85
  return MODEL_PRESETS.filter(p => p.vramGB <= safeLimit).sort((a, b) => b.vramGB - a.vramGB)
}

/**
 * Get the default preset for a given VRAM.
 * Mistral-7B Q4_K_M is the default pick when it fits.
 */
export function getDefaultPreset(vramGB) {
  const fitting = getPresetsForVRAM(vramGB)
  const mistral = fitting.find(p => p.id === 'mistral-7b-instruct-v0.3.Q4_K_M')
  return mistral || fitting[0] || null
}

/**
 * Get all presets with fit flags for a given VRAM (or all if vramGB is null).
 */
export function getPresetsWithFit(vramGB) {
  return MODEL_PRESETS.map(p => ({
    ...p,
    fits: vramGB !== null && vramGB !== undefined ? p.vramGB <= vramGB * 0.85 : false,
  }))
}

// ═══════════════════════════════════════════
// Local Model Directory
// ═══════════════════════════════════════════

let _electronApp = null
export function setElectronApp(app) { _electronApp = app }

function getApp() {
  if (_electronApp) return _electronApp
  try {
    const pkg = require('electron')
    return pkg.app || pkg.default?.app || pkg
  } catch {
    return null
  }
}

function getModelsDir() {
  const app = getApp()
  const userData = app?.getPath?.('userData')
  if (userData) return join(userData, 'llama-models')
  // Test fallback
  return join(process.cwd(), 'test-models')
}

export async function ensureModelDir() {
  const dir = getModelsDir()
  await mkdir(dir, { recursive: true })
  return dir
}

export async function listLocalModels() {
  const dir = await ensureModelDir()
  try {
    const files = await readdir(dir)
    return files
      .filter(f => f.endsWith('.gguf'))
      .map(f => ({
        id: f.replace('.gguf', ''),
        name: f,
        path: join(dir, f),
      }))
  } catch {
    return []
  }
}

// ═══════════════════════════════════════════
// Download (delegates to remoteModelInstall.js recipe)
// ═══════════════════════════════════════════

/**
 * Download a preset model using the verified download recipe.
 * @param {string} presetId - ID from MODEL_PRESETS
 * @param {Object} opts - { onProgress(bytes, total), onStageChange(stage), abortSignal }
 * @returns {Object} { ok, path, preset, size, hash, cached, error }
 */
export async function downloadPreset(presetId, { onProgress, onStageChange, abortSignal } = {}) {
  const preset = MODEL_PRESETS.find(p => p.id === presetId)
  if (!preset) throw new Error(`Unknown preset: ${presetId}`)

  const modelsDir = await ensureModelDir()
  const targetPath = join(modelsDir, preset.filename)
  const url = `https://huggingface.co/${preset.repo}/resolve/main/${preset.filename}`

  // Check if already complete and verified
  try {
    const st = await stat(targetPath)
    if (st.size === preset.sizeBytes) {
      const hash = await computeLocalSha256(targetPath)
      if (hash.toLowerCase() === preset.sha256.toLowerCase()) {
        if (onStageChange) onStageChange('complete')
        if (onProgress) onProgress(st.size, st.size)
        return { ok: true, path: targetPath, preset, size: st.size, hash, cached: true }
      }
      // Hash mismatch — will re-download
    }
  } catch {}

  const result = await downloadLocalModel({
    url,
    filename: preset.filename,
    expectedSha256: preset.sha256,
    expectedSize: preset.sizeBytes,
    onProgress,
    onStageChange,
    abortSignal,
  })

  if (!result.ok) return { ok: false, error: result.error, preset }
  return { ok: true, path: result.path, preset, size: result.size, hash: result.hash, cached: false }
}

// ═══════════════════════════════════════════
// First-Run Decision (pure, testable function)
// ═══════════════════════════════════════════

/**
 * Decide first-run model choice.
 * @param {Object} opts
 *   - hasLocalGguf: boolean — any .gguf already in modelsDir
 *   - modelsDir: string — path to models directory
 *   - presets: Array — MODEL_PRESETS (or filtered subset)
 *   - vramGb: number|null — measured VRAM or null if unknown
 * @returns {Object} { action: 'pick-model'|'use-existing'|'custom-path', preset?, path?, reason }
 *
 * Fallback order encoded: local sidecar -> LM Studio -> OpenRouter.
 * Cancelling falls through, never dead-ends.
 */
export function chooseModel({ hasLocalGguf, modelsDir, presets, vramGb }) {
  // If user already has a local GGUF, offer to use it
  if (hasLocalGguf) {
    return {
      action: 'use-existing',
      reason: 'Local GGUF found in models directory',
      modelsDir,
    }
  }

  // No local model — filter presets by VRAM
  const fitting = vramGb !== null && vramGb !== undefined
    ? presets.filter(p => p.vramGB <= vramGb * 0.85)
    : presets // unknown VRAM: show all, let user decide

  if (fitting.length === 0) {
    // Nothing fits measured VRAM — still show all presets with warning
    return {
      action: 'pick-model',
      preset: presets[0], // default to first (Mistral)
      presets: MODEL_PRESETS,
      reason: 'No presets fit measured VRAM; showing all options',
      warning: 'Measured VRAM may be insufficient for any preset',
    }
  }

  // Default pick: Mistral-7B Q4_K_M if it fits, else largest fitting
  const defaultPreset = fitting.find(p => p.id === 'mistral-7b-instruct-v0.3.Q4_K_M')
    || fitting.reduce((a, b) => (b.vramGB > a.vramGB ? b : a))

  return {
    action: 'pick-model',
    preset: defaultPreset,
    presets: fitting,
    reason: 'No local model; default preset pre-selected',
  }
}

// ═══════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════

export function getModelCatalog() {
  return MODEL_PRESETS
}

export async function getModelCatalogWithVRAM() {
  const vram = await detectVramGb()
  return {
    vramGB: vram,
    presets: getPresetsWithFit(vram),
  }
}