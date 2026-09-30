/**
 * Remote model install — server-side download routing for the workflow-setup
 * installer (remote-ComfyUI mode, plan C3).
 *
 * In remote mode, model bytes must land on the REMOTE server, never stream
 * through the SSH tunnel, and never hit the local disk. Everything here runs
 * on the server via execRemoteCommand (injected for testability):
 *
 *   1. preflight:  df available-space check against the expected size
 *   2. download:   resumable wget/curl/aria2c -c to modelsPath/<subdir>/
 *                  (run detached with nohup; a big model must not block the
 *                  single SSH client that also carries health checks)
 *   3. progress:   poll remote file size until it reaches the expected size
 *   4. verify:     remote sha256sum against the recipe's pinned hash
 *
 * All shell values are shell-quoted (quoteRemoteArg) — model roots, URLs and
 * filenames come from settings + the install catalog and must never become
 * command injection.
 */

const DEFAULT_DOWNLOAD_POLL_MS = 1500
const MAX_DOWNLOAD_POLLS = 4 * 60 * 10 // ~100 min at 1.5s polls

/**
 * Quote one argument for remote POSIX sh. Backslash-escapes the single
 * quotes, then wraps in single quotes. Handles spaces, quotes, backticks,
 * $, newlines, glob chars.
 */
function quoteRemoteArg(value) {
  const safe = String(value ?? '').replace(/'/g, "'\\''")
  return `'${safe}'`
}

/**
 * Build the remote download command for one model file. Prefers aria2c
 * (fastest), then wget, then curl -L. All three support resume (-c).
 */
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

/**
 * Remote disk-space preflight. Returns { ok, availableBytes, error }.
 * Compares against `requiredBytes` (expected file size + 10% headroom).
 */
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

/**
 * Start the remote download DETACHED (nohup ... &) so the single SSH client
 * stays free for tunnel health checks while a big model transfers.
 * Returns { ok, error }.
 */
async function startRemoteDownload(execRemoteCommand, { url, targetDir, filename }) {
  const downloadCommand = buildRemoteDownloadCommand({ url, targetDir, filename })
  // Detach with nohup + & so the single SSH client stays free for tunnel
  // health checks while a big model transfers. The inner command is passed
  // as ONE quoted argument to sh -c (no nested quoting hazards).
  const result = await execRemoteCommand(
    `nohup sh -c ${quoteRemoteArg(downloadCommand)} > /dev/null 2>&1 &`
  )
  if (!result.success) {
    return { ok: false, error: `Could not start remote download: ${result.stderr || result.error || 'unknown'}` }
  }
  return { ok: true }
}

/**
 * Poll the remote file size until it reaches the expected size (or a
 * not-growing window indicates a stalled transfer).
 *
 * expectedBytes = null -> poll until the file stops growing (unknown size).
 */
async function pollRemoteDownload(
  execRemoteCommand,
  { targetDir, filename, expectedBytes = null, pollMs = DEFAULT_DOWNLOAD_POLL_MS, maxPolls = MAX_DOWNLOAD_POLLS, onProgress = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }
) {
  const targetPath = `${targetDir}/${filename}`
  const pathArg = quoteRemoteArg(targetPath)
  let lastSize = -1
  let stagnantPolls = 0

  for (let poll = 0; poll < maxPolls; poll += 1) {
    // File must exist to be measured. stat -c %s is stable on Linux.
    const probe = await execRemoteCommand(`test -f ${pathArg} && stat -c %s ${pathArg} 2>/dev/null || echo missing`)
    if (!probe.success) {
      await sleep(pollMs)
      continue
    }
    const out = String(probe.stdout || '').trim()
    if (out === 'missing') {
      // Download process may not have created the file yet; give it polls.
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

/**
 * Verify the remote file's sha256 against the pinned hash.
 * expectedSha256 = '' -> size sanity only (file exists and is non-empty).
 */
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

function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${bytes} B`
}

module.exports = {
  quoteRemoteArg,
  buildRemoteDownloadCommand,
  checkRemoteDiskSpace,
  startRemoteDownload,
  pollRemoteDownload,
  verifyRemoteFile,
  formatBytes,
}