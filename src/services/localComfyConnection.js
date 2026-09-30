export const COMFY_CONNECTION_SETTING_KEY = 'comfyConnection'
export const COMFY_CONNECTION_LOCAL_KEY = 'comfystudio-comfy-connection'
export const COMFY_CONNECTION_CHANGED_EVENT = 'comfystudio-comfy-connection-changed'

export const LOCAL_COMFY_HOST = '127.0.0.1'
export const DEFAULT_COMFY_PORT = 8188

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

let cachedPort = DEFAULT_COMFY_PORT
let hydrated = false
let hydrationPromise = null
let connectionVersion = 0

// Remote-ComfyUI mode state (see resolveEffectivePort). The SSH tunnel
// forwards the remote ComfyUI onto 127.0.0.1:<tunnelLocalPort>, so when the
// tunnel is up the connection port MUST follow it - a stale localStorage
// port must never win (that was the silent mis-route: generation pointed at
// a dead local port while the tunnel served the real server).
let remoteModeEnabled = false
let tunnelActive = false
let tunnelLocalPort = null

function normalizePort(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return null
  if (parsed < 1 || parsed > 65535) return null
  return parsed
}

/**
 * Mode-explicit port resolution - the single source of truth for which port
 * the ComfyUI connection targets. Precedence:
 *   1. remote mode ON + tunnel up  -> tunnelLocalPort (the tunnel serves the
 *      remote server on loopback; the localStorage cache is ignored)
 *   2. otherwise                    -> cachedPort (local behavior unchanged)
 * Never probes a port to decide the mode - the mode is the explicit
 * belrogRemoteServer.enabled flag + tunnel state, per plan B.3.4.
 */
function resolveEffectivePort() {
  if (remoteModeEnabled && tunnelActive) {
    const tunnelPort = normalizePort(tunnelLocalPort)
    if (tunnelPort) return tunnelPort
  }
  return cachedPort
}

/** True when remote mode is on but the tunnel is not currently serving. */
function isReconnecting() {
  return remoteModeEnabled && !tunnelActive
}

function isLoopbackHost(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase()
  if (!normalized) return false
  if (LOOPBACK_HOSTS.has(normalized)) return true
  if (!/^127(?:\.\d{1,3}){3}$/.test(normalized)) return false
  return normalized
    .split('.')
    .map((part) => Number(part))
    .every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
}

function buildConnection(port, { mode = 'local', reconnecting = false } = {}) {
  const safePort = normalizePort(port) || DEFAULT_COMFY_PORT
  return {
    host: LOCAL_COMFY_HOST,
    port: safePort,
    httpBase: `http://${LOCAL_COMFY_HOST}:${safePort}`,
    wsBase: `ws://${LOCAL_COMFY_HOST}:${safePort}`,
    mode,
    reconnecting,
  }
}

function readLocalStoragePort() {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(COMFY_CONNECTION_LOCAL_KEY)
    if (!raw) return null
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = raw
    }
    const fromStored = parseStoredPortValue(parsed)
    return fromStored.success ? fromStored.port : null
  } catch {
    return null
  }
}

function writeLocalStoragePort(port) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(COMFY_CONNECTION_LOCAL_KEY, JSON.stringify({ port }))
  } catch {
    // Ignore storage write failures.
  }
}

function dispatchConnectionChanged(config) {
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
    window.dispatchEvent(new CustomEvent(COMFY_CONNECTION_CHANGED_EVENT, { detail: config }))
  } catch {
    // Ignore event dispatch failures.
  }
}

function parseStoredPortValue(raw) {
  if (raw && typeof raw === 'object') {
    if (raw.port !== undefined) {
      const normalized = normalizePort(raw.port)
      if (normalized) return { success: true, port: normalized }
    }
    if (raw.httpBase) {
      return parseLocalComfyPortInput(raw.httpBase)
    }
    if (raw.url) {
      return parseLocalComfyPortInput(raw.url)
    }
  }
  if (typeof raw === 'number') {
    const normalized = normalizePort(raw)
    if (normalized) return { success: true, port: normalized }
  }
  if (typeof raw === 'string') {
    return parseLocalComfyPortInput(raw)
  }
  return { success: false, error: 'No local ComfyUI setting found' }
}

function hydrateFromLocalStorage() {
  const fromLocalStorage = readLocalStoragePort()
  if (fromLocalStorage) {
    cachedPort = fromLocalStorage
  }
}

hydrateFromLocalStorage()

export function parseLocalComfyPortInput(input) {
  const raw = String(input ?? '').trim()
  if (!raw) {
    return { success: true, port: DEFAULT_COMFY_PORT }
  }

  if (/^\d+$/.test(raw)) {
    const port = normalizePort(raw)
    if (!port) {
      return { success: false, error: 'Port must be between 1 and 65535.' }
    }
    return { success: true, port }
  }

  let candidate = raw
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    candidate = `http://${candidate}`
  }

  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, error: 'Use a local http URL (or just the port number).' }
    }
    if (!isLoopbackHost(parsed.hostname)) {
      return { success: false, error: 'Remote ComfyUI is disabled. Use localhost/127.0.0.1 only.' }
    }
    const port = normalizePort(parsed.port || DEFAULT_COMFY_PORT)
    if (!port) {
      return { success: false, error: 'Port must be between 1 and 65535.' }
    }
    return { success: true, port }
  } catch {
    return { success: false, error: 'Invalid value. Use a local port like 8188.' }
  }
}

export function isLoopbackHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return isLoopbackHost(parsed.hostname)
  } catch {
    return false
  }
}

export function getLocalComfyConnectionSync() {
  return buildConnection(resolveEffectivePort(), {
    mode: remoteModeEnabled ? 'remote' : 'local',
    reconnecting: isReconnecting(),
  })
}

export function getLocalComfyHttpBaseSync() {
  return getLocalComfyConnectionSync().httpBase
}

export function getLocalComfyWsBaseSync() {
  return getLocalComfyConnectionSync().wsBase
}

export async function hydrateLocalComfyConnection() {
  if (hydrated) {
    return getLocalComfyConnectionSync()
  }
  if (hydrationPromise) {
    return hydrationPromise
  }

  hydrationPromise = (async () => {
    const startVersion = connectionVersion
    hydrateFromLocalStorage()

    if (typeof window !== 'undefined' && window?.electronAPI?.getSetting) {
      try {
        const stored = await window.electronAPI.getSetting(COMFY_CONNECTION_SETTING_KEY)
        let parsed = parseStoredPortValue(stored)

        // Legacy migration path if previous versions ever stored a free-form URL key.
        if (!parsed.success) {
          const legacyUrl = await window.electronAPI.getSetting('comfyUrl')
          parsed = parseStoredPortValue(legacyUrl)
        }

        if (parsed.success && startVersion === connectionVersion) {
          cachedPort = parsed.port
          writeLocalStoragePort(cachedPort)
        }
      } catch {
        // Ignore settings read failures and keep local/default values.
      }
    }

    // Resolve remote mode + tunnel state BEFORE sealing hydration: if the
    // tunnel is up, its local port wins over any cached port.
    await refreshComfyConnectionMode()

    hydrated = true
    const config = getLocalComfyConnectionSync()
    hydrationPromise = null
    return config
  })()

  return hydrationPromise
}

/**
 * Re-resolve mode + tunnel state from the main process and refresh the
 * effective connection. Called on startup (inside hydrate) and whenever the
 * tunnel connects/disconnects (wired by the caller - see
 * ComfyLauncherChip / App remote-status effects). Never throws: a failed
 * poll keeps the last known mode.
 */
export async function refreshComfyConnectionMode() {
  const api = typeof window !== 'undefined' ? window?.electronAPI : null
  if (!api) return getLocalComfyConnectionSync()

  let changed = false
  try {
    const remote = await api.getRemoteServerSettings?.()
    const enabled = Boolean(remote?.enabled)
    if (enabled !== remoteModeEnabled) {
      remoteModeEnabled = enabled
      changed = true
    }
    const status = await api.getTunnelStatus?.()
    const active = Boolean(status?.active)
    const port = normalizePort(status?.settings?.tunnelLocalPort ?? remote?.tunnelLocalPort)
    const stateChanged = active !== tunnelActive || port !== tunnelLocalPort
    tunnelActive = active
    if (port) tunnelLocalPort = port
    if (stateChanged) changed = true
  } catch {
    // IPC unavailable (dev/browser context) or transient failure:
    // keep the last known mode rather than guessing.
  }

  if (changed) {
    connectionVersion += 1
    dispatchConnectionChanged(getLocalComfyConnectionSync())
  }
  return getLocalComfyConnectionSync()
}

export async function saveLocalComfyConnectionPort(input) {
  const parsed = parseLocalComfyPortInput(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error }
  }

  connectionVersion += 1
  cachedPort = parsed.port
  const config = getLocalComfyConnectionSync()
  writeLocalStoragePort(config.port)

  try {
    if (typeof window !== 'undefined' && window?.electronAPI?.setSetting) {
      await window.electronAPI.setSetting(COMFY_CONNECTION_SETTING_KEY, {
        host: config.host,
        port: config.port,
      })
    }
  } catch (err) {
    return {
      success: false,
      error: err?.message || 'Failed to persist local ComfyUI setting.',
    }
  }

  dispatchConnectionChanged(config)
  return { success: true, config }
}

export async function checkLocalComfyConnection(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 4500
  const maybePort = options.port ?? cachedPort
  const normalizedPort = normalizePort(maybePort)
  if (!normalizedPort) {
    return { ok: false, error: 'Invalid local ComfyUI port.' }
  }

  const config = buildConnection(normalizedPort)

  if (typeof window !== 'undefined' && window?.electronAPI?.checkLocalComfyConnection) {
    try {
      const result = await window.electronAPI.checkLocalComfyConnection({
        port: config.port,
        timeoutMs,
      })
      if (result?.ok) {
        return {
          ok: true,
          status: result.status,
          httpBase: result.httpBase || config.httpBase,
          port: result.port || config.port,
          source: 'electron-main',
        }
      }
      const status = Number(result?.status) || null
      return {
        ok: false,
        status,
        httpBase: result?.httpBase || config.httpBase,
        port: result?.port || config.port,
        source: 'electron-main',
        error: status
          ? `ComfyUI returned HTTP ${status}.`
          : result?.timedOut
            ? `Timed out connecting to ${config.httpBase}.`
            : `Could not connect to ${config.httpBase}: ${result?.error || 'Unknown error'}`,
      }
    } catch {
      // Fall back to renderer fetch so browser/dev builds still get a result.
    }
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => {
    if (controller) controller.abort()
  }, timeoutMs)

  try {
    const response = await fetch(`${config.httpBase}/system_stats`, {
      signal: controller?.signal,
    })
    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        httpBase: config.httpBase,
        port: config.port,
      }
    }
    return {
      ok: false,
      status: response.status,
      httpBase: config.httpBase,
      port: config.port,
      error: response.status === 403
        ? 'ComfyUI returned HTTP 403. If this is a standalone ComfyUI session, launch it with --enable-cors-header * or use Belrog’s built-in launcher.'
        : `ComfyUI returned HTTP ${response.status}.`,
    }
  } catch (err) {
    const isTimeout = err?.name === 'AbortError'
    return {
      ok: false,
      httpBase: config.httpBase,
      port: config.port,
      error: isTimeout
        ? `Timed out connecting to ${config.httpBase}.`
        : `Could not connect to ${config.httpBase}: ${err?.message || 'Unknown error'}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Test-only: reset hydration + mode state so each test can install its own
 * window mock and re-hydrate. Production code never calls this.
 */
export function __resetLocalComfyConnectionForTests() {
  hydrated = false
  hydrationPromise = null
  connectionVersion = 0
  remoteModeEnabled = false
  tunnelActive = false
  tunnelLocalPort = null
  cachedPort = DEFAULT_COMFY_PORT
}

