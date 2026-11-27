/**
 * Remote Model Install — Server-side + Local GGUF Download
 *
 * Dual-mode model installer:
 *  1. REMOTE mode (original): downloads to remote ComfyUI server via SSH
 *  2. LOCAL mode (new): downloads GGUF models locally for llama-server sidecar
 *
 * Both modes support:
 *  - Resumable downloads (aria2c/wget/curl)
 *  - Progress polling with callbacks
 *  - SHA256 verification
 *  - Disk space preflight
 */

const { app } = require('electron')
const path = require('path')
const fs = require('fs/promises')
const { spawn } = require('child_process')
const crypto = require('crypto')

// ═══════════════════════════════════════════
// Shared Utilities
// ═══════════════════════════════════════════

const DEFAULT_DOWNLOAD_POLL_MS = 1000
const MAX_DOWNLOAD_POLLS = 4 * 60 * 60 // ~100 min at 1s polls

function formatBytes(bytes) {
  const b = Number(bytes) || 0
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`
  return `${b} B`
}

function pickDownloader() {
  // Return the best available downloader command builder
  return {
    aria2c: (url, targetPath, filename) => [
      'aria2c', '--quiet', '--continue=true', '--max-connection-per-server=8',
      '--dir', path.dirname(targetPath), '--out', filename, url,
    ],
    wget: (url, targetPath, filename) => [
      'wget', '-q', '--continue', '-O', targetPath, url,
    ],
    curl: (url, targetPath, filename) => [
      'curl', '-sSL', '-C', '-', '-o', targetPath, url,
    ],
  }
}

async function hasCommand(cmd) {
  return new Promise(resolve => {
    const proc = spawn('which', [cmd])
    proc.on('close', code => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

async function getBestDownloader() {
  const downloaders = pickDownloader()
  for (const name of ['aria2c', 'wget', 'curl']) {
    if (await hasCommand(name)) return { name, args: downloaders[name] }
  }
  return { name: 'node', args: null } // fallback to Node fetch
}

// ═══════════════════════════════════════════
// LOCAL MODE: GGUF Download for llama-server sidecar
// ═══════════════════════════════════════════

/**
 * Local model directory (beside app or in user data)
 */
function getLocalModelsDir() {
  // Prefer ~/models/llm for visibility, fallback to app userData
  const home = process.env.HOME || process.env.USERPROFILE
  const preferred = path.join(home, 'models', 'llm')
  return preferred
}

async function ensureLocalModelsDir() {
  const dir = getLocalModelsDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * Check local disk space.
 */
async function checkLocalDiskSpace(requiredBytes) {
  const dir = await ensureLocalModelsDir()
  try {
    // Use df on the target directory's filesystem
    const { stdout } = await spawnAsync('df', ['-P', '-B1', '--output=avail', dir])
    const availableBytes = Number(stdout.trim().split('\n').pop().trim())
    const required = Math.ceil(Number(requiredBytes) * 1.1) // +10% headroom
    if (required > 0 && availableBytes < required) {
      return {
        ok: false,
        availableBytes,
        error: `Local disk has ${formatBytes(availableBytes)} free; model needs ~${formatBytes(required)} (size + 10%).`,
      }
    }
    return { ok: true, availableBytes }
  } catch {
    // If df fails, assume OK (can't verify)
    return { ok: true, availableBytes: Infinity }
  }
}

/**
 * Compute SHA256 of local file.
 */
async function computeLocalSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = require('fs').createReadStream(filePath)
    stream.on('data', d => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * Download a GGUF model locally with progress + resume + verification.
 *
 * @param {Object} opts
 *   - url: Hugging Face download URL
 *   - filename: target filename
 *   - expectedSha256: pinned hash (optional)
 *   - expectedSize: expected file size in bytes (optional)
 *   - onProgress: callback(bytesDownloaded, totalBytes)
 *   - onStageChange: callback(stage) — 'preflight' | 'downloading' | 'verifying' | 'complete'
 *   - abortSignal: AbortSignal for cancellation
 * @returns {Object} { ok, path, hash, size, error }
 */
async function downloadLocalModel({
  url,
  filename,
  expectedSha256,
  expectedSize,
  onProgress,
  onStageChange,
  abortSignal,
}) {
  const modelsDir = await ensureLocalModelsDir()
  const targetPath = path.join(modelsDir, filename)
  const tempPath = targetPath + '.part'

  // Stage: preflight
  onStageChange?.('preflight')
  if (expectedSize) {
    const spaceCheck = await checkLocalDiskSpace(expectedSize)
    if (!spaceCheck.ok) return { ok: false, error: spaceCheck.error }
  }

  // Check if already complete and verified
  try {
    const stat = await fs.stat(targetPath)
    if (stat.size === expectedSize || !expectedSize) {
      if (expectedSha256) {
        const hash = await computeLocalSha256(targetPath)
        if (hash.toLowerCase() === expectedSha256.toLowerCase()) {
          onStageChange?.('complete')
          onProgress?.(stat.size, stat.size)
          return { ok: true, path: targetPath, hash, size: stat.size, cached: true }
        }
        // Hash mismatch — will re-download
      } else if (!expectedSha256 && stat.size > 0) {
        onStageChange?.('complete')
        onProgress?.(stat.size, stat.size)
        return { ok: true, path: targetPath, hash: null, size: stat.size, cached: true }
      }
    }
  } catch {}

  // Stage: downloading
  onStageChange?.('downloading')

  const downloader = await getBestDownloader()
  let proc
  let downloaded = 0

  try {
    if (downloader.name === 'node') {
      // Node.js fetch fallback (no resume)
      const response = await fetch(url, { signal: abortSignal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const writer = require('fs').createWriteStream(tempPath)
      const reader = response.body.getReader()
      const total = Number(response.headers.get('content-length') || expectedSize || 0)

      while (true) {
        if (abortSignal?.aborted) throw new Error('Aborted')
        const { done, value } = await reader.read()
        if (done) break
        await writer.write(value)
        downloaded += value.length
        onProgress?.(downloaded, total || undefined)
      }
      await writer.end()
    } else {
      // External downloader with resume support
      const args = downloader.args(url, tempPath, filename)
      proc = spawn(args[0], args.slice(1))
      let stderr = ''

      proc.stderr.on('data', d => { stderr += d.toString() })

      // Poll file size for progress
      const pollProgress = async () => {
        while (!abortSignal?.aborted) {
          try {
            const stat = await fs.stat(tempPath).catch(() => null)
            if (stat) {
              downloaded = stat.size
              onProgress?.(downloaded, expectedSize)
            }
          } catch {}
          await new Promise(r => setTimeout(r, DEFAULT_DOWNLOAD_POLL_MS))
          // Check if process exited
          try { proc.kill(0) } catch { break } // process ended
        }
      }
      const pollPromise = pollProgress()

      await new Promise((resolve, reject) => {
        proc.on('close', code => {
          if (code === 0) resolve()
          else reject(new Error(`${downloader.name} failed: ${stderr}`))
        })
        proc.on('error', reject)
      })

      await pollPromise
    }

    // Verify size if expected
    const finalStat = await fs.stat(tempPath)
    if (expectedSize && finalStat.size < expectedSize * 0.99) {
      throw new Error(`Download incomplete: got ${finalStat.size}, expected ${expectedSize}`)
    }

    // Stage: verifying
    onStageChange?.('verifying')

    // Verify SHA256
    if (expectedSha256) {
      const hash = await computeLocalSha256(tempPath)
      if (hash.toLowerCase() !== expectedSha256.toLowerCase()) {
        await fs.unlink(tempPath).catch(() => {})
        return {
          ok: false,
          hash,
          error: `SHA256 mismatch: got ${hash}, expected ${expectedSha256}. File deleted.`,
        }
      }
    }

    // Atomic rename
    await fs.rename(tempPath, targetPath)

    onStageChange?.('complete')
    onProgress?.(finalStat.size, finalStat.size)

    return { ok: true, path: targetPath, hash: expectedSha256, size: finalStat.size, cached: false }
  } catch (err) {
    // Cleanup on error
    await fs.unlink(tempPath).catch(() => {})
    if (proc) proc.kill('SIGTERM')
    return { ok: false, error: err.message }
  }
}

/**
 * Show model picker dialog and download selected model.
 * Returns { ok, path, modelId, error }
 */
async function pickAndDownloadLocalModel(win, { modelCatalog, onProgress, onStageChange }) {
  const { dialog } = require('electron')

  // Build choices from catalog
  const choices = modelCatalog.map(m => ({
    id: m.id,
    label: `${m.name} — ${m.vramGB.toFixed(1)} GB VRAM`,
    detail: m.description,
    preset: m,
  }))

  const result = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Download Local Model',
    message: 'Select a model to download for the local llama-server sidecar.',
    detail: 'Models are saved to ~/models/llm/ and used by the Generate Script modal.',
    buttons: choices.map(c => c.label).concat(['Cancel']),
    defaultId: 0,
    cancelId: choices.length,
    noLink: true,
  })

  if (result.response >= choices.length) return { ok: false, error: 'Cancelled' }

  const selected = choices[result.response]
  const preset = selected.preset
  const url = `https://huggingface.co/${preset.repo}/resolve/main/${preset.filename}`

  const dlResult = await downloadLocalModel({
    url,
    filename: preset.filename,
    expectedSha256: preset.sha256,
    expectedSize: preset.sizeBytes,
    onProgress,
    onStageChange,
  })

  return { ...dlResult, modelId: preset.id, preset }
}

// ═══════════════════════════════════════════
// REMOTE MODE (original, kept for ComfyUI workflows)
// ═══════════════════════════════════════════

const DEFAULT_DOWNLOAD_POLL_MS_REMOTE = 1500
const MAX_DOWNLOAD_POLLS_REMOTE = 4 * 60 * 10

function quoteRemoteArg(value) {
  const safe = String(value ?? '').replace(/'/g, "'\\''")
  return `'${safe}'`
}

function buildRemoteDownloadCommand({ url, targetDir, filename, outFile }) {
  const dirArg = quoteRemoteArg(targetDir)
  const fileArg = quoteRemoteArg(outFile || filename)
  const urlArg = quoteRemoteArg(url)
  return [
    `mkdir -p ${dirArg}`,
    `(command -v aria2c >/dev/null 2>&1 && aria2c --quiet --continue=true --max-connection-per-server=8 ${urlArg} -d ${dirArg} -o ${fileArg})`,
    `|| (command -v wget >/dev/null 2>&1 && wget -q --continue ${urlArg} -P ${dirArg} -O ${fileArg})`,
    `|| (command -v curl >/dev/null 2>&1 && curl -sSL -C - ${urlArg} -o ${fileArg})`,
  ].join(' ')
}

async function checkRemoteDiskSpace(execRemoteCommand, modelRoot, requiredBytes) {
  const rootArg = quoteRemoteArg(modelRoot)
  const result = await execRemoteCommand(
    `mkdir -p ${rootArg} 2>/dev/null; df -P -B1 --output=avail ${rootArg} 2>/dev/null | tail -1 | tr -d ' '`
  )
  if (!result.success) {
    return { ok: false, availableBytes: 0, error: `Could not check remote disk space: ${result.stderr || result.error || 'unknown'}` }
  }
  const availableBytes = Number(String(result.stdout || '').trim())
  if (!Number.isFinite(availableBytes) || availableBytes <= 0) {
    return { ok: false, availableBytes: 0, error: 'Could not read remote disk space.' }
  }
  const required = Math.ceil(Number(requiredBytes) * 1.1) || 0
  if (required > 0 && availableBytes < required) {
    return {
      ok: false,
      availableBytes,
      error: `Remote disk has ${formatBytes(availableBytes)} free; this model needs about ${formatBytes(required)} (size + 10% headroom). Free up space on the server first.`,
    }
  }
  return { ok: true, availableBytes }
}

async function startRemoteDownload(execRemoteCommand, { url, targetDir, filename }) {
  const downloadCommand = buildRemoteDownloadCommand({ url, targetDir, filename })
  const result = await execRemoteCommand(
    `nohup sh -c ${quoteRemoteArg(downloadCommand)} > /dev/null 2>&1 &`
  )
  if (!result.success) {
    return { ok: false, error: `Could not start remote download: ${result.stderr || result.error || 'unknown'}` }
  }
  return { ok: true }
}

async function pollRemoteDownload(
  execRemoteCommand,
  { targetDir, filename, expectedBytes = null, pollMs = DEFAULT_DOWNLOAD_POLL_MS_REMOTE, maxPolls = MAX_DOWNLOAD_POLLS_REMOTE, onProgress = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }
) {
  const targetPath = `${targetDir}/${filename}`
  const pathArg = quoteRemoteArg(targetPath)
  let lastSize = -1
  let stagnantPolls = 0

  for (let poll = 0; poll < maxPolls; poll += 1) {
    const probe = await execRemoteCommand(`test -f ${pathArg} && stat -c %s ${pathArg} 2>/dev/null || echo missing`)
    if (!probe.success) {
      await sleep(pollMs)
      continue
    }
    const out = String(probe.stdout || '').trim()
    if (out === 'missing') {
      await sleep(pollMs)
      continue
    }
    const size = Number(out)
    if (!Number.isFinite(size)) {
      await sleep(pollMs)
      continue
    }
    if (Number.isFinite(expectedBytes) && size >= expectedBytes) {
      if (onProgress) onProgress(size, expectedBytes)
      return { ok: true, size }
    }
    if (size === lastSize) {
      stagnantPolls += 1
      if (stagnantPolls >= 20 && (expectedBytes === null || size < expectedBytes)) {
        return {
          ok: false,
          size,
          error: `Remote download stalled at ${formatBytes(size)}${expectedBytes === null ? '' : ` of ${formatBytes(expectedBytes)}`}.`,
        }
      }
    } else {
      stagnantPolls = 0
    }
    lastSize = size
    if (onProgress) onProgress(size, expectedBytes)
    await sleep(pollMs)
  }
  return { ok: false, size: Math.max(0, lastSize), error: 'Remote download timed out while polling.' }
}

async function verifyRemoteFile(execRemoteCommand, { targetDir, filename, expectedSha256 }) {
  const pathArg = quoteRemoteArg(`${targetDir}/${filename}`)
  const probe = await execRemoteCommand(`test -s ${pathArg} && sha256sum ${pathArg} 2>/dev/null`)
  if (!probe.success) {
    return { ok: false, error: `Remote file missing or empty after download: ${filename}` }
  }
  const hash = String(probe.stdout || '').trim().split(/\s+/)[0].toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    return { ok: false, error: `Could not compute remote sha256 for ${filename}.` }
  }
  if (expectedSha256 && hash !== String(expectedSha256).toLowerCase()) {
    return {
      ok: false,
      hash,
      error: `Remote sha256 mismatch for ${filename}: got ${hash}, expected ${expectedSha256.toLowerCase()}. The file was removed from the server — do not use it.`,
    }
  }
  return { ok: true, hash }
}

// ═══════════════════════════════════════════
// Helper: spawnAsync
// ═══════════════════════════════════════════

function spawnAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => stdout += d)
    proc.stderr.on('data', d => stderr += d)
    proc.on('close', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr || `exit code ${code}`))
    })
    proc.on('error', reject)
  })
}

// ═══════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════

module.exports = {
  // Local mode (new)
  getLocalModelsDir,
  ensureLocalModelsDir,
  checkLocalDiskSpace,
  computeLocalSha256,
  downloadLocalModel,
  pickAndDownloadLocalModel,

  // Remote mode (original)
  quoteRemoteArg,
  buildRemoteDownloadCommand,
  checkRemoteDiskSpace,
  startRemoteDownload,
  pollRemoteDownload,
  verifyRemoteFile,
  formatBytes,
}