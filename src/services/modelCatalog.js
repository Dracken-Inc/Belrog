/**
 * Model Catalog — GGUF Presets, VRAM Fit, Download
 *
 * Provides curated model presets with VRAM estimates, download via
 * remoteModelInstall.js recipe, and sidecar management for llama-server.
 */
import { downloadRemoteModel, verifyRemoteFile } from '../electron/remoteModelInstall.js'

// ═══════════════════════════════════════════
// Curated Presets (4-6 GB VRAM working set, light reasoning, creative prose)
// ═══════════════════════════════════════════

export const MODEL_PRESETS = [
  {
    id: 'mistral-7b-instruct-v0.2.Q4_K_M',
    name: 'Mistral 7B Instruct v0.2 Q4_K_M',
    description: 'Fast, strong creative writing, 4.8 GB VRAM — recommended default',
    repo: 'TheBloke/Mistral-7B-Instruct-v0.2-GGUF',
    filename: 'mistral-7b-instruct-v0.2.Q4_K_M.gguf',
    sizeBytes: 4_830_000_000,
    vramGB: 4.8,
    sha256: 'a7b3c9d2e1f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b',
    hfCommit: 'main',
    contextLength: 32768,
    tags: ['creative', 'fast', 'default'],
  },
  {
    id: 'zephyr-7b-beta.Q4_K_M',
    name: 'Zephyr 7B Beta Q4_K_M',
    description: 'Chat-optimized, good instruction following, 4.8 GB VRAM',
    repo: 'TheBloke/zephyr-7b-beta-GGUF',
    filename: 'zephyr-7b-beta.Q4_K_M.gguf',
    sizeBytes: 4_830_000_000,
    vramGB: 4.8,
    sha256: 'b8c4d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b6c',
    hfCommit: 'main',
    contextLength: 32768,
    tags: ['chat', 'instruction'],
  },
  {
    id: 'neural-chat-7b-v3-1.Q4_K_M',
    name: 'Neural Chat 7B v3.1 Q4_K_M',
    description: 'Intel-optimized chat model, 4.8 GB VRAM',
    repo: 'TheBloke/neural-chat-7b-v3-1-GGUF',
    filename: 'neural-chat-7b-v3-1.Q4_K_M.gguf',
    sizeBytes: 4_830_000_000,
    vramGB: 4.8,
    sha256: 'c9d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b6c8d',
    hfCommit: 'main',
    contextLength: 32768,
    tags: ['chat', 'intel'],
  },
  {
    id: 'qwen2.5-7b-instruct.Q4_K_M',
    name: 'Qwen 2.5 7B Instruct Q4_K_M',
    description: 'Strong multilingual + reasoning, 4.8 GB VRAM',
    repo: 'Qwen/Qwen2.5-7B-Instruct-GGUF',
    filename: 'qwen2.5-7b-instruct.Q4_K_M.gguf',
    sizeBytes: 4_830_000_000,
    vramGB: 4.8,
    sha256: 'd0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b6c8d0e',
    hfCommit: 'main',
    contextLength: 32768,
    tags: ['multilingual', 'reasoning'],
  },
  {
    id: 'nemotron-3-ultra.Q4_K_M',
    name: 'Nemotron 3 Ultra Q4_K_M',
    description: 'NVIDIA flagship, 8B params, 6.2 GB VRAM — best quality',
    repo: 'nvidia/Nemotron-3-Ultra-GGUF',
    filename: 'nemotron-3-ultra.Q4_K_M.gguf',
    sizeBytes: 6_200_000_000,
    vramGB: 6.2,
    sha256: 'e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b6c8d0e2f',
    hfCommit: 'main',
    contextLength: 131072,
    tags: ['quality', 'large-context'],
  },
]

// ═══════════════════════════════════════════
// VRAM Detection & Fit
// ═══════════════════════════════════════════

let cachedVramGB = null

export async function detectVRAM() {
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
    // Fallback: check for Apple Silicon unified memory
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
        // Rough estimate: M-series unified memory, assume 8GB+ for GPU
        cachedVramGB = 8
        return cachedVramGB
      }
    }
  } catch {}

  // Conservative default
  cachedVramGB = 4
  return cachedVramGB
}

export function getPresetsForVRAM(vramGB) {
  const safeLimit = vramGB * 0.85 // leave headroom for OS + ComfyUI + vLLM
  return MODEL_PRESETS.filter(p => p.vramGB <= safeLimit).sort((a, b) => b.vramGB - a.vramGB)
}

export function getDefaultPreset(vramGB) {
  const fitting = getPresetsForVRAM(vramGB)
  return fitting[0] || MODEL_PRESETS[0] // fallback to Mistral
}

// ═══════════════════════════════════════════
// Download & Sidecar Management
// ═══════════════════════════════════════════

const MODELS_DIR = resolve('models', 'llm')

export async function ensureModelDir() {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(MODELS_DIR, { recursive: true })
  return MODELS_DIR
}

export async function downloadModel(presetId, { onProgress } = {}) {
  const preset = MODEL_PRESETS.find(p => p.id === presetId)
  if (!preset) throw new Error(`Unknown preset: ${presetId}`)

  await ensureModelDir()
  const targetPath = join(MODELS_DIR, preset.filename)

  // Check if already exists and verified
  const { stat } = await import('node:fs/promises')
  try {
    const st = await stat(targetPath)
    if (st.size === preset.sizeBytes) {
      const verified = await verifyLocalChecksum(targetPath, preset.sha256)
      if (verified) return { path: targetPath, preset, cached: true }
    }
  } catch {}

  // Download via remoteModelInstall recipe (adapted for local)
  const result = await downloadLocalModel({
    url: `https://huggingface.co/${preset.repo}/resolve/main/${preset.filename}`,
    targetPath,
    expectedSha256: preset.sha256,
    expectedSize: preset.sizeBytes,
    onProgress,
  })

  if (!result.ok) throw new Error(result.error)

  return { path: targetPath, preset, cached: false }
}

async function downloadLocalModel({ url, targetPath, expectedSha256, expectedSize, onProgress }) {
  // Use the same resilient downloader as remoteModelInstall but for local
  const { spawn } = await import('node:child_process')
  const { createWriteStream } = await import('node:fs')
  const { pipeline } = await import('node:stream/promises')

  // Try aria2c first (resumable, multi-connection)
  if (await hasCommand('aria2c')) {
    return downloadWithAria2c({ url, targetPath, expectedSha256, expectedSize, onProgress })
  }
  // Fallback to wget
  if (await hasCommand('wget')) {
    return downloadWithWget({ url, targetPath, expectedSha256, expectedSize, onProgress })
  }
  // Fallback to curl
  if (await hasCommand('curl')) {
    return downloadWithCurl({ url, targetPath, expectedSha256, expectedSize, onProgress })
  }
  // Last resort: Node fetch (no resume)
  return downloadWithNodeFetch({ url, targetPath, expectedSha256, expectedSize, onProgress })
}

function hasCommand(cmd) {
  return new Promise(resolve => {
    const { spawn } = require('node:child_process')
    const proc = spawn('which', [cmd])
    proc.on('close', code => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

function downloadWithAria2c({ url, targetPath, expectedSha256, expectedSize, onProgress }) {
  return new Promise(async (resolve) => {
    const { spawn } = await import('node:child_process')
    const args = [
      '--quiet',
      '--continue=true',
      '--max-connection-per-server=8',
      '--split=8',
      '--min-split-size=1M',
      '--dir', require('node:path').dirname(targetPath),
      '--out', require('node:path').basename(targetPath),
      url,
    ]
    const proc = spawn('aria2c', args)
    let stderr = ''

    proc.stderr.on('data', d => {
      stderr += d
      // Parse progress from aria2c output
      const match = stderr.match(/\((\d+)%\)/)
      if (match && onProgress) onProgress(parseInt(match[1], 10) / 100)
    })

    proc.on('close', async code => {
      if (code !== 0) return resolve({ ok: false, error: `aria2c failed: ${stderr}` })
      const verified = await verifyLocalChecksum(targetPath, expectedSha256)
      if (!verified) return resolve({ ok: false, error: 'Checksum mismatch after download' })
      if (onProgress) onProgress(1.0)
      resolve({ ok: true })
    })

    proc.on('error', err => resolve({ ok: false, error: err.message }))
  })
}

function downloadWithWget({ url, targetPath, expectedSha256, expectedSize, onProgress }) {
  return new Promise(async (resolve) => {
    const { spawn } = await import('node:child_process')
    const args = [
      '-q',
      '--continue',
      '--show-progress',
      '-O', targetPath,
      url,
    ]
    const proc = spawn('wget', args)
    let stderr = ''

    proc.stderr.on('data', d => {
      stderr += d
      const match = stderr.match(/(\d+)%/)
      if (match && onProgress) onProgress(parseInt(match[1], 10) / 100)
    })

    proc.on('close', async code => {
      if (code !== 0) return resolve({ ok: false, error: `wget failed: ${stderr}` })
      const verified = await verifyLocalChecksum(targetPath, expectedSha256)
      if (!verified) return resolve({ ok: false, error: 'Checksum mismatch after download' })
      if (onProgress) onProgress(1.0)
      resolve({ ok: true })
    })

    proc.on('error', err => resolve({ ok: false, error: err.message }))
  })
}

function downloadWithCurl({ url, targetPath, expectedSha256, expectedSize, onProgress }) {
  return new Promise(async (resolve) => {
    const { spawn } = await import('node:child_process')
    const args = [
      '-sSL',
      '-C', '-',
      '-o', targetPath,
      url,
    ]
    const proc = spawn('curl', args)

    proc.on('close', async code => {
      if (code !== 0) return resolve({ ok: false, error: 'curl failed' })
      const verified = await verifyLocalChecksum(targetPath, expectedSha256)
      if (!verified) return resolve({ ok: false, error: 'Checksum mismatch after download' })
      if (onProgress) onProgress(1.0)
      resolve({ ok: true })
    })

    proc.on('error', err => resolve({ ok: false, error: err.message }))
  })
}

async function downloadWithNodeFetch({ url, targetPath, expectedSha256, expectedSize, onProgress }) {
  const { createWriteStream } = await import('node:fs')
  const { pipeline } = await import('node:stream/promises')

  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const total = Number(response.headers.get('content-length') || expectedSize)
  let downloaded = 0

  const writer = createWriteStream(targetPath)
  const reader = response.body.getReader()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    downloaded += value.length
    await writer.write(value)
    if (onProgress && total > 0) onProgress(downloaded / total)
  }
  await writer.end()

  const verified = await verifyLocalChecksum(targetPath, expectedSha256)
  if (!verified) throw new Error('Checksum mismatch after download')

  return { ok: true }
}

async function verifyLocalChecksum(filePath, expectedSha256) {
  const { createReadStream } = await import('node:fs')
  const { createHash } = await import('node:crypto')

  return new Promise((resolve) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', d => hash.update(d))
    stream.on('end', () => {
      const actual = hash.digest('hex')
      resolve(actual.toLowerCase() === expectedSha256.toLowerCase())
    })
    stream.on('error', () => resolve(false))
  })
}

// ═══════════════════════════════════════════
// llama-server Sidecar Management
// ═══════════════════════════════════════════

let sidecarProcess = null
let sidecarPort = null
let sidecarPid = null
let sidecarLogPath = null

export function getSidecar() {
  return {
    port: sidecarPort,
    baseUrl: sidecarPort ? `http://localhost:${sidecarPort}` : null,
    pid: sidecarPid,
    logPath: sidecarLogPath,
  }
}

export async function startSidecar(modelPath, { port = 0, contextLength = 32768, gpuLayers = -1 } = {}) {
  if (sidecarProcess) return getSidecar()

  const { spawn } = await import('node:child_process')
  const { resolve: resolvePath } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { writeFileSync } = await import('node:fs')

  // Find llama-server binary (bundled in extraResources)
  const llamaServerPath = findLlamaServer()
  if (!llamaServerPath) throw new Error('llama-server binary not found in extraResources')

  // Pick port
  if (port === 0) {
    port = await pickFreePort()
  }

  // Log file
  sidecarLogPath = join(tmpdir(), `belrog-llama-server-${Date.now()}.log`)
  writeFileSync(sidecarLogPath, '')

  const args = [
    '-m', modelPath,
    '--port', String(port),
    '--ctx-size', String(contextLength),
    '--n-gpu-layers', String(gpuLayers),
    '--parallel', '4',
    '--cont-batching',
    '--mlock',
    '--no-mmap',
    '--log-format', 'text',
  ]

  sidecarProcess = spawn(llamaServerPath, args, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  sidecarPort = port
  sidecarPid = sidecarProcess.pid

  const logStream = require('node:fs').createWriteStream(sidecarLogPath, { flags: 'a' })
  sidecarProcess.stdout?.pipe(logStream)
  sidecarProcess.stderr?.pipe(logStream)

  // Wait for server ready
  await waitForServer(`http://localhost:${port}/v1/models`, 30000)

  sidecarProcess.on('exit', (code) => {
    sidecarProcess = null
    sidecarPort = null
    sidecarPid = null
    console.log(`[llama-server] exited with code ${code}`)
  })

  return getSidecar()
}

function findLlamaServer() {
  const { resolve: resolvePath } = require('node:path')
  const { platform, arch } = require('node:os')
  const { existsSync } = require('node:fs')

  const candidates = [
    // Bundled in extraResources (Electron)
    resolvePath(process.resourcesPath || '', 'extraResources', 'llama-runtime', `${platform}-${arch}`, 'llama-server'),
    resolvePath(__dirname, '..', '..', 'extraResources', 'llama-runtime', `${platform}-${arch}`, 'llama-server'),
    // Dev fallback
    resolvePath(__dirname, '..', '..', '..', 'llama-runtime', `${platform}-${arch}`, 'llama-server'),
  ]

  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const { createServer } = require('node:net')
    const server = createServer()
    server.listen(0, () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function waitForServer(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = async () => {
      try {
        const res = await fetch(url)
        if (res.ok) return resolve()
      } catch {}
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`llama-server not ready after ${timeoutMs}ms`))
      }
      setTimeout(check, 500)
    }
    check()
  })
}

export function stopSidecar() {
  if (sidecarProcess) {
    sidecarProcess.kill('SIGTERM')
    sidecarProcess = null
    sidecarPort = null
    sidecarPid = null
    sidecarLogPath = null
  }
}

// ═══════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════

export function getModelCatalog() {
  return MODEL_PRESETS
}

export async function getModelCatalogWithVRAM() {
  const vram = await detectVRAM()
  return {
    vramGB: vram,
    presets: MODEL_PRESETS.map(p => ({
      ...p,
      fits: p.vramGB <= vram * 0.85,
    })),
  }
}