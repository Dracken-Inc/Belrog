/**
 * Llama Sidecar — Local LLM Server Lifecycle
 *
 * Spawns bundled llama-server from extraResources/llama-runtime/${os}-${arch}/
 * on a loopback port chosen at runtime. Registers cleanup hooks so a sidecar
 * can never outlive the app (zombie llama-server holding GB of RAM = failure).
 *
 * Exports:
 *   - start({ modelPath, port, ctxShift, extraArgs }) -> { url, pid, port }
 *   - stop(pid) -> Promise<void>
 *   - registerCleanup(app) -> void
 *   - buildRequestOptions(schema) -> { response_format: { type: 'json_schema', json_schema: {...} } }
 */

import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { stat, access, constants, readdir } from 'node:fs/promises'
import { EventEmitter } from 'node:events'

// This file must be loadable from an ESM context (Electron main imports it), and
// ESM has no require(). createRequire keeps the optional-dependency probes working.
import { createRequire as _createRequire } from 'node:module'
const nodeRequire = _createRequire(import.meta.url)

let _electronApp = null
export function setElectronApp(app) { _electronApp = app }
function getApp() {
  if (_electronApp) return _electronApp
  try {
    const pkg = nodeRequire('electron')
    return pkg.app || pkg.default?.app || pkg
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════

const LLAMA_RUNTIME_DIR = 'llama-runtime'
const LLAMA_SERVER_BIN = {
  win32: 'llama-server.exe',
  darwin: 'llama-server',
  linux: 'llama-server',
}

const STARTUP_TIMEOUT_MS = 30000
const GRACEFUL_SHUTDOWN_MS = 5000

// ═══════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════

function getRuntimeDir() {
  const resourcesPath = app.isPackaged
    ? join(process.resourcesPath, LLAMA_RUNTIME_DIR)
    : join(__dirname, '..', '..', '..', 'llama-runtime') // dev: repo root/llama-runtime
  return resourcesPath
}

function getBinaryPath() {
  const platform = process.platform
  const arch = process.arch
  const runtimeDir = getRuntimeDir()
  const binName = LLAMA_SERVER_BIN[platform] || LLAMA_SERVER_BIN.linux
  return join(runtimeDir, `${platform}-${arch}`, binName)
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const { createServer } = nodeRequire('node:net')
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function waitForReady(url, timeoutMs) {
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

// ═══════════════════════════════════════════
// Sidecar Instance Management
// ═══════════════════════════════════════════

let activeSidecar = null

class LlamaSidecar extends EventEmitter {
  constructor() {
    super()
    this.process = null
    this.port = null
    this.pid = null
    this.modelPath = null
    this.ctxShift = 0
    this.extraArgs = []
  }

  async start({ modelPath, port = 0, ctxShift = 0, extraArgs = [] }) {
    if (this.process) {
      throw new Error('Sidecar already running; call stop() first')
    }

    // Verify binary exists
    const binaryPath = getBinaryPath()
    const exists = await fileExists(binaryPath)
    if (!exists) {
      throw new Error(`llama-server binary not found at ${binaryPath}`)
    }
    const executable = await isExecutable(binaryPath)
    if (!executable) {
      throw new Error(`llama-server binary not executable at ${binaryPath}`)
    }

    // Verify model exists
    const modelExists = await fileExists(modelPath)
    if (!modelExists) {
      throw new Error(`Model not found: ${modelPath}`)
    }

    this.modelPath = modelPath
    this.ctxShift = ctxShift
    this.extraArgs = extraArgs

    // Pick port
    this.port = port || await findFreePort()

    // Build args for llama-server
    // Base args: loopback only, context size, performance opts
    const args = [
      '-m', this.modelPath,
      '--port', String(this.port),
      '--host', '127.0.0.1',
      '--ctx-size', String(8192 + this.ctxShift),
      '--batch-size', '512',
      '--ubatch-size', '512',
      '--threads', '0',
      '--cont-batching',
      '--mlock',
      '--no-mmap',
      '--embedding',
      ...this.extraArgs,
    ]

    // Spawn process (CPU only for sidecar)
    this.process = spawn(binaryPath, args, {
      cwd: resolve(this.modelPath, '..'),
      env: {
        ...process.env,
        CUDA_VISIBLE_DEVICES: '', // CPU only
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.pid = this.process.pid

    // Capture stdout/stderr for debugging
    let startupOutput = ''
    this.process.stdout.on('data', (data) => {
      const text = data.toString()
      startupOutput += text
      this.emit('log', { type: 'stdout', text })
    })

    this.process.stderr.on('data', (data) => {
      const text = data.toString()
      startupOutput += text
      this.emit('log', { type: 'stderr', text })
    })

    this.process.on('error', (err) => {
      this.emit('error', err)
    })

    this.process.on('exit', (code, signal) => {
      const wasRunning = this.process !== null
      this.process = null
      this.port = null
      this.pid = null
      if (wasRunning) {
        this.emit('unexpected-exit', { code, signal })
      }
    })

    // Wait for /health or /v1/models readiness
    const healthUrl = `http://127.0.0.1:${this.port}/health`
    const modelsUrl = `http://127.0.0.1:${this.port}/v1/models`
    try {
      await Promise.race([
        waitForReady(healthUrl, STARTUP_TIMEOUT_MS),
        waitForReady(modelsUrl, STARTUP_TIMEOUT_MS),
      ])
    } catch (err) {
      // Cleanup on timeout
      this.process.kill('SIGTERM')
      await new Promise(r => setTimeout(r, GRACEFUL_SHUTDOWN_MS))
      if (this.process) this.process.kill('SIGKILL')
      this.process = null
      this.port = null
      this.pid = null
      throw err
    }

    return { url: `http://127.0.0.1:${this.port}`, pid: this.pid, port: this.port }
  }

  async stop() {
    if (!this.process) return

    const pid = this.pid
    this.process.kill('SIGTERM')

    // Wait for graceful exit
    await new Promise((resolve) => {
      if (!this.process) return resolve()
      this.process.once('exit', resolve)
      setTimeout(() => {
        if (this.process) this.process.kill('SIGKILL')
        resolve()
      }, GRACEFUL_SHUTDOWN_MS)
    })

    this.process = null
    this.port = null
    this.pid = null
    this.modelPath = null
  }

  getStatus() {
    return {
      running: this.process !== null,
      port: this.port,
      pid: this.pid,
      modelPath: this.modelPath,
      baseUrl: this.port ? `http://127.0.0.1:${this.port}` : null,
    }
  }
}

// ═══════════════════════════════════════════
// Public API (clean functions for main.js to call)
// ═══════════════════════════════════════════

/**
 * Start the llama-server sidecar.
 * @param {Object} opts
 *   - modelPath: string — absolute path to .gguf file
 *   - port: number — port to bind (0 = auto-pick free loopback port)
 *   - ctxShift: number — additional context size beyond base 8192
 *   - extraArgs: string[] — extra llama-server args
 * @returns {Promise<{url:string, pid:number, port:number}>}
 */
export async function start({ modelPath, port, ctxShift, extraArgs }) {
  if (activeSidecar) {
    throw new Error('Sidecar already active; call stop() first')
  }
  activeSidecar = new LlamaSidecar()
  return activeSidecar.start({ modelPath, port, ctxShift, extraArgs })
}

/**
 * Stop the sidecar by PID (or current active sidecar).
 * Terminates gracefully, then force-kills after grace period.
 * @param {number} [pid] — PID to stop (defaults to active sidecar)
 * @returns {Promise<void>}
 */
export async function stop(pid) {
  if (!activeSidecar) return
  if (pid && activeSidecar.pid !== pid) {
    throw new Error(`PID mismatch: active=${activeSidecar.pid}, requested=${pid}`)
  }
  await activeSidecar.stop()
  activeSidecar = null
}

/**
 * Register cleanup hooks so sidecar can never outlive the app.
 * Hooks: app 'before-quit', process 'exit', process 'uncaughtException'.
 * @param {Electron.App} app — Electron app instance
 */
export function registerCleanup(app) {
  const shutdown = async () => {
    if (activeSidecar) {
      try {
        await activeSidecar.stop()
      } catch {}
      activeSidecar = null
    }
  }

  // App quit (window close, Cmd+Q, etc.)
  app.on('before-quit', shutdown)

  // Process exit (normal)
  process.on('exit', () => {
    if (activeSidecar) {
      // Synchronous cleanup on hard exit
      try { activeSidecar.process?.kill('SIGKILL') } catch {}
      activeSidecar = null
    }
  })

  // Uncaught exception / unhandled rejection
  process.on('uncaughtException', async (err) => {
    console.error('[llamaSidecar] Uncaught exception, shutting down sidecar:', err)
    await shutdown()
    process.exit(1)
  })

  process.on('unhandledRejection', async (reason) => {
    console.error('[llamaSidecar] Unhandled rejection, shutting down sidecar:', reason)
    await shutdown()
    process.exit(1)
  })

  // SIGTERM/SIGINT (system shutdown, kill)
  process.on('SIGTERM', async () => {
    await shutdown()
    process.exit(0)
  })
  process.on('SIGINT', async () => {
    await shutdown()
    process.exit(0)
  })
}

/**
 * Build request options for llama.cpp /v1/chat/completions with json_schema.
 *
 * WHY json_schema (not json_object): llama.cpp enforces json_schema at the
 * TOKEN level via GBNF grammar — every emitted token is constrained to stay
 * grammatically valid against the schema. `json_object` only asks the model to
 * emit *something* parseable as JSON and gives NO structure guarantee, which is
 * how malformed shot plans appeared (valid JSON, wrong/missing fields).
 *
 * Strict mode requires that every object property be listed in `required` and
 * that additionalProperties be false. The ShotPlan schema may leave fields
 * optional, so we DERIVE required=[all keys] and additionalProperties:false
 * recursively here — the model then cannot omit or invent a field.
 *
 * @param {Object} schema — JSON Schema (GBNF-friendly subset: no $ref/oneOf/anyOf)
 * @returns {Object} — { response_format: { type:'json_schema', json_schema:{ name, schema, strict:true } } }
 */
function makeStrict(node) {
  if (Array.isArray(node)) return node.map(makeStrict)
  if (!node || typeof node !== 'object') return node

  const out = { ...node }

  if (out.type === 'object' || out.properties) {
    const props = out.properties || {}
    out.properties = {}
    for (const [k, v] of Object.entries(props)) out.properties[k] = makeStrict(v)
    // Strict: every declared key is required, no extra keys allowed.
    out.required = Object.keys(props)
    out.additionalProperties = false
  } else if (out.type === 'array' || out.items) {
    if (out.items) out.items = makeStrict(out.items)
  }

  return out
}

export function buildRequestOptions(schema) {
  return {
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'shot_plan',
        schema: makeStrict(schema),
        strict: true,
      },
    },
  }
}

/**
 * Get current sidecar status (for main.js wiring).
 */
export function getStatus() {
  return activeSidecar?.getStatus() ?? { running: false, port: null, pid: null, modelPath: null, baseUrl: null }
}