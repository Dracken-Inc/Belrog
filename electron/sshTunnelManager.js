/**
 * SSH Tunnel Manager for Belrog
 * Establishes SSH port forwarding to enable remote ComfyUI access
 * as if it were running on localhost:8188
 */

const { Client } = require('ssh2')
const net = require('net')
const os = require('os')
const http = require('http')

// Settings keys
const REMOTE_SERVER_SETTING_KEY = 'belrogRemoteServer'
const DEFAULT_REMOTE_SERVER_SETTINGS = {
  enabled: false,
  sshHost: '',
  sshPort: 22,
  sshUsername: '',
  sshKeyPath: '',
  comfyModelRoot: '',    // Remote models folder (e.g., /home/user/ComfyUI/models)
  comfyNodesRoot: '',    // Remote custom_nodes folder (e.g., /home/user/ComfyUI/custom_nodes)
  tunnelLocalPort: 8188, // Local port to bind
  tunnelRemotePort: 8188,// Remote ComfyUI port
}

let sshClient = null
let tunnelServer = null
let isConnecting = false
let currentSettings = null

// Drop-and-retry state. wantTunnel is only true while the user wants the tunnel
// up, so a manual Disconnect (or a failed first attempt) never loops.
let tunnelOptions = null
let wantTunnel = false
let reconnectTimer = null
let reconnectDelayMs = 3000
let reconnectAttempts = 0
const RECONNECT_BASE_MS = 3000
const RECONNECT_MAX_MS = 30000
const RECONNECT_MAX_ATTEMPTS = 8

function log(...args) {
  console.log('[sshTunnelManager]', new Date().toISOString(), ...args)
}

function logError(...args) {
  console.error('[sshTunnelManager ERROR]', new Date().toISOString(), ...args)
}

/**
 * Get settings from main process settings store
 * Called by main.js IPC handler
 */
async function getRemoteServerSettings(readSettingsRaw) {
  try {
    const settings = await readSettingsRaw()
    const stored = settings?.[REMOTE_SERVER_SETTING_KEY]
    if (stored && typeof stored === 'object') {
      return { ...DEFAULT_REMOTE_SERVER_SETTINGS, ...stored }
    }
    return { ...DEFAULT_REMOTE_SERVER_SETTINGS }
  } catch {
    return { ...DEFAULT_REMOTE_SERVER_SETTINGS }
  }
}

/**
 * Save remote server settings
 */
async function saveRemoteServerSettings(writeSettingsRaw, settings) {
  try {
    await writeSettingsRaw((current) => ({
      ...current,
      [REMOTE_SERVER_SETTING_KEY]: { ...settings },
    }))
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

/**
 * Get SSH key contents from file path
 */
function getPrivateKey(keyPath) {
  try {
    return require('fs').readFileSync(keyPath)
  } catch {
    return null
  }
}

/**
 * Does something on this machine already answer as ComfyUI on this port?
 * Used to explain a busy port instead of blaming the user for it.
 *
 * Raw socket on purpose: http.get leaves the answer up to keep-alive and
 * parser events, and a listener that accepts the connection and then says
 * nothing (or hangs up immediately) left the promise pending with nothing
 * holding the event loop. That is how "is the port busy" turned into a hang.
 * Here the socket's own events plus one hard timer always settle it.
 */
function probeLocalComfyPort(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    // Two different facts: the port accepts connections at all, and the thing
    // behind it speaks ComfyUI. A plain listener that drops the request is still
    // "occupied" as far as the tunnel is concerned.
    let settled = false
    let open = false
    let text = ''
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Say goodbye before hanging up. A server that already sent its own FIN
      // (a plain net server with allowHalfOpen) waits for ours, and without it
      // the connection sits half-open on the user's machine while we walk away.
      try { socket.end() } catch {}
      const bye = setTimeout(() => { try { socket.destroy() } catch {} }, 50)
      if (bye.unref) bye.unref() // probing must never be the reason the app stays alive
      resolve({ open, comfy: /HTTP\/[\d.]+ 200/.test(text) && /comfyui_version|"system"/.test(text) })
    }
    const timer = setTimeout(finish, timeoutMs)

    socket.on('connect', () => {
      open = true
      socket.write('GET /system_stats HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
    })
    socket.on('data', (chunk) => { text += chunk })
    // Anything that ends the conversation settles it: a normal ComfyUI answers
    // and closes, an unrelated service hangs up, a refused port errors out.
    socket.on('end', finish)
    socket.on('close', finish)
    socket.on('error', finish)
  })
}

/** One bind attempt. Rejects with the listen error (EADDRINUSE is the common one). */
function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('error', onError); reject(err) }
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
}

/**
 * Bind the forwarder on the requested port, or the next free ones. A machine
 * that already runs ComfyUI on 8188 is normal, not an error worth stopping for:
 * the tunnel moves to 8189 and the app follows the port it reports.
 */
async function bindForwarder(createServer, requestedPort, { maxTries = 8 } = {}) {
  const attempts = []
  for (let i = 0; i < maxTries; i += 1) {
    const port = requestedPort + i
    const server = createServer()
    try {
      await listenOnce(server, port)
      return { server, port, attempts }
    } catch (err) {
      if (err && err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
        try { server.close() } catch {}
        return { server: null, port: null, attempts, error: err }
      }
      // Only probe once a bind actually failed, so the common free-port path
      // stays instant. The probe is purely for a better error message.
      const probe = await probeLocalComfyPort(port)
      attempts.push({ port, comfy: probe.open && probe.comfy })
    }
  }
  return { server: null, port: null, attempts }
}

/** Plain-language reason a port range could not be bound. */
function describeBusyPorts(attempts) {
  if (!attempts.length) return 'Could not open a local port.'
  const comfy = attempts.filter((a) => a.comfy).map((a) => a.port)
  const last = attempts[attempts.length - 1].port
  const range = attempts.length === 1 ? `${attempts[0].port}` : `${attempts[0].port}–${last}`
  if (comfy.length) {
    const who = comfy.length === 1
      ? `127.0.0.1:${comfy[0]} is already running a ComfyUI`
      : `Ports ${comfy.join(' and ')} already run ComfyUI instances`
    return `${who}, and the tunnel could not open a port up to ${last}.`
  }
  return `Ports ${range} are all in use by other programs.`
}

/**
 * Forwarding server. `getForwardOut` hands back the live SSH client's forwardOut,
 * or null once the tunnel is gone. A request that arrives after teardown must drop
 * the socket: dereferencing a dead connection here used to throw straight out of
 * the server callback and crash the app in a tight loop.
 */
function createForwardingServer(getForwardOut, remotePort) {
  const server = net.createServer((localSocket) => {
    const forwardOut = getForwardOut()
    if (typeof forwardOut !== 'function') {
      localSocket.destroy()
      return
    }
    forwardOut(localSocket.remoteAddress, localSocket.remotePort, '127.0.0.1', remotePort, (err, stream) => {
      if (err) {
        logError('Forward error:', err.message)
        localSocket.end()
        return
      }
      localSocket.pipe(stream).pipe(localSocket)
      localSocket.on('error', () => {
        // Client disconnected, stream will clean up
      })
      stream.on('error', () => {
        // Remote disconnected
      })
    })
  })

  // server.close() alone waits for keep-alive sockets to finish, so a browser
  // tab or a hung generation request can hold the port open forever after
  // Disconnect - which then reads as "port in use" on the next Connect.
  const live = new Set()
  server.on('connection', (socket) => {
    live.add(socket)
    socket.on('close', () => live.delete(socket))
  })
  server.closeLiveSockets = () => {
    for (const socket of live) {
      try { socket.destroy() } catch {}
    }
    live.clear()
  }
  return server
}

/**
 * Force a forwarder down: drop everything still connected, then release the port.
 */
function closeForwardingServer(server) {
  if (!server) return
  try { if (typeof server.closeLiveSockets === 'function') server.closeLiveSockets() } catch {}
  try { server.close() } catch {}
}

/**
 * Establish SSH tunnel and port forwarding
 * @param {Object} opts - Tunnel options
 * @param {string} opts.sshHost - SSH server hostname/IP
 * @param {number} opts.sshPort - SSH server port
 * @param {string} opts.sshUsername - SSH username
 * @param {string} opts.sshKeyPath - Path to SSH private key file
 * @param {number} opts.tunnelLocalPort - Local port to bind (default 8188)
 * @param {number} opts.tunnelRemotePort - Remote port to forward to (default 8188)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
function establishTunnel(opts) {
  return new Promise((resolve) => {
    log('=== establishTunnel called ===')
    log('Options received:', JSON.stringify({
      sshHost: opts.sshHost,
      sshPort: opts.sshPort,
      sshUsername: opts.sshUsername,
      sshKeyPath: opts.sshKeyPath,
      tunnelLocalPort: opts.tunnelLocalPort,
      tunnelRemotePort: opts.tunnelRemotePort
    }))
    
    if (!opts.sshHost || !opts.sshUsername || !opts.sshKeyPath) {
      logError('Missing required SSH settings')
      resolve({ success: false, error: 'SSH settings incomplete: host, username, and key path are required' })
      return
    }
    
    if (isConnecting) {
      resolve({ success: false, error: 'Already attempting to connect' })
      return
    }
    if (sshClient && sshClient._connectSocket) {
      resolve({ success: false, error: 'Tunnel already active' })
      return
    }

    isConnecting = true
    log(`Connecting to SSH ${opts.sshUsername}@${opts.sshHost}:${opts.sshPort}`)

    const privateKey = getPrivateKey(opts.sshKeyPath)
    log('Private key read result:', privateKey ? 'SUCCESS' : 'FAILED')
    if (!privateKey) {
      isConnecting = false
      resolve({ success: false, error: `Could not read SSH key: ${opts.sshKeyPath}` })
      return
    }

    sshClient = new Client()
    // Every event below belongs to THIS client. Destroying an old tunnel only
    // queues its 'close'/'error' for a later tick, so a fast Disconnect ->
    // Connect (and auto-reconnect right after a drop) used to have the dying
    // connection tear down the brand-new one: the new forwarder vanished before
    // 'ready' and the connect hung until the 30s timeout. Events from a
    // connection we already replaced are logged and ignored.
    const client = sshClient
    const isStaleConnection = () => sshClient !== client

    client.on('ready', () => {
      if (isStaleConnection()) {
        log('Ignoring ready from a replaced SSH connection')
        return
      }
      log('SSH connection ready, establishing port forward')

      const requestedPort = Number(opts.tunnelLocalPort) || DEFAULT_REMOTE_SERVER_SETTINGS.tunnelLocalPort
      const remotePort = Number(opts.tunnelRemotePort) || DEFAULT_REMOTE_SERVER_SETTINGS.tunnelRemotePort

      // Same builder the tests drive: it keeps a registry of live sockets so
      // Disconnect can force the port free instead of waiting on keep-alives, and
      // it drops requests that arrive after teardown rather than dereferencing a
      // dead SSH client inside the server callback (that throw killed the app).
      const createForwarder = () => createForwardingServer(() => {
        if (!sshClient || sshClient !== client || typeof sshClient.forwardOut !== 'function') return null
        const remoteHost = '127.0.0.1' // Always forward to localhost on remote
        return (srcAddr, srcPort, destAddr, destPort, cb) => {
          sshClient.forwardOut(srcAddr, srcPort, remoteHost, destPort, cb)
        }
      }, remotePort)

      bindForwarder(createForwarder, requestedPort).then((bound) => {
        if (!bound.server) {
          isConnecting = false
          const detail = bound.error?.message || describeBusyPorts(bound.attempts)
          logError('No local port available for the tunnel:', detail)
          cleanup()
          resolve({ success: false, error: detail })
          return
        }

        tunnelServer = bound.server
        // Bind errors are handled by bindForwarder; anything from here on is a
        // per-connection error and must not be read as "port in use".
        tunnelServer.on('error', (err) => logError('Tunnel connection error:', err.message))

        // The renderer follows the port we report (see localComfyConnection
        // .refreshComfyConnectionMode), so record the one we actually bound.
        currentSettings = { ...(currentSettings || {}), ...opts, tunnelRequestedPort: requestedPort, tunnelLocalPort: bound.port }
        tunnelOptions = opts
        wantTunnel = true
        reconnectAttempts = 0
        reconnectDelayMs = RECONNECT_BASE_MS
        isConnecting = false

        const switched = bound.port !== requestedPort
        log(`Tunnel active: localhost:${bound.port} -> ${opts.sshHost}:${remotePort}${switched ? ` (moved from ${requestedPort})` : ''}`)
        resolve({ success: true, localPort: bound.port, switchedPort: switched })
      })
    })

    client.on('error', (err) => {
      if (isStaleConnection()) {
        logError('Ignoring error from a replaced SSH connection:', err.message)
        resolve({ success: false, error: 'That SSH connection was replaced by a newer one' })
        return
      }
      isConnecting = false
      logError('SSH client error:', err.message)
      logError('SSH error code:', err.code)
      logError('SSH errno:', err.errno)
      let errorMsg = `SSH connection failed: ${err.message}`
      if (err.message.includes('ECONNREFUSED')) {
        errorMsg = `Cannot connect to SSH server at ${opts.sshHost}:${opts.sshPort} - connection refused`
      } else if (err.message.includes('ENOTFOUND')) {
        errorMsg = `SSH host not found: ${opts.sshHost}`
      } else if (err.message.includes('key')) {
        errorMsg = `SSH key authentication failed: ${err.message}`
      } else if (err.code === 'ENOTFOUND') {
        errorMsg = `DNS lookup failed for: ${opts.sshHost}`
      } else if (err.code === 'ETIMEDOUT') {
        errorMsg = `Connection timed out to: ${opts.sshHost}:${opts.sshPort}`
      } else if (err.code === 'ECONNREFUSED') {
        errorMsg = `Connection refused by: ${opts.sshHost}:${opts.sshPort}`
      }
      logError('Final error message:', errorMsg)
      cleanup()
      resolve({ success: false, error: errorMsg })
    })

    client.on('close', () => {
      if (isStaleConnection()) {
        log('A connection we already replaced closed - the current tunnel is untouched')
        return
      }
      log('SSH connection closed')
      // A socket that closed before it ever became ready (server hangup, refused
      // auth) used to leave Connect staring at the 30s timeout with nothing on
      // screen. Say so now instead.
      if (isConnecting) {
        clearTimeout(connectionTimeout)
        cleanup()
        resolve({ success: false, error: `SSH connection to ${opts.sshHost}:${opts.sshPort} closed before it was ready` })
        return
      }
      // A Wi-Fi drop or a restarted container closes the socket under us. That is
      // the case autossh exists for: bring the forwarder back on its own instead
      // of leaving the app pointed at a dead port until someone notices.
      const shouldReconnect = wantTunnel && tunnelOptions
      cleanup()
      if (shouldReconnect) scheduleReconnect()
    })

    // Connection timeout
    const connectionTimeout = setTimeout(() => {
      logError('SSH connection timed out after 30 seconds')
      sshClient.end()
      isConnecting = false
      resolve({ success: false, error: `Connection timed out to ${opts.sshHost}:${opts.sshPort}` })
    }, 30000)
    
    // Clear timeout when connection succeeds
    sshClient.once('ready', () => {
      clearTimeout(connectionTimeout)
    })
    
    sshClient.connect({
      host: opts.sshHost,
      port: opts.sshPort,
      username: opts.sshUsername,
      privateKey: privateKey,
      readyTimeout: 30000,
      // ServerAliveInterval/CountMax equivalent: probe every 15s and give up
      // after 3 missed answers. Without this a half-open link (Wi-Fi drop,
      // container restart) stays "Connected via SSH tunnel" forever.
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
    })
  })
}

/**
 * Cleanup tunnel resources
 */
function cleanup() {
  if (tunnelServer) {
    // Destroy what is still connected first: server.close() waits for keep-alive
    // sockets, so a half-finished generation used to keep the port hostage after
    // Disconnect and make the next Connect look like "port in use".
    closeForwardingServer(tunnelServer)
    tunnelServer = null
  }
  if (sshClient) {
    try {
      sshClient.end()
    } catch {}
    // end() is a polite close; a frozen tunnel never answers it. destroy() drops
    // the socket now so nothing is left half-open holding the forwarder.
    try {
      if (typeof sshClient.destroy === 'function') sshClient.destroy()
    } catch {}
    sshClient = null
  }
  isConnecting = false
}

/**
 * Re-establish a tunnel that dropped on its own. Backs off 3s/6s/12s... and stops
 * after a few tries so a wrong key or a wiped server does not hammer SSH forever;
 * pressing Connect (or restarting the app) starts it over.
 */
function scheduleReconnect() {
  if (reconnectTimer || !wantTunnel || !tunnelOptions) return
  if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
    logError('Tunnel stayed down after', reconnectAttempts, 'retries - Connect again when the network is back')
    return
  }
  reconnectAttempts += 1
  const delay = reconnectDelayMs
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS)
  log(`Tunnel dropped, retry ${reconnectAttempts} in ${Math.round(delay / 1000)}s`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!wantTunnel || isConnecting || isTunnelActive()) return
    establishTunnel(tunnelOptions).then((result) => {
      if (result?.success) {
        reconnectDelayMs = RECONNECT_BASE_MS
        reconnectAttempts = 0
        log(`Tunnel back up on localhost:${result.localPort}`)
      } else {
        scheduleReconnect()
      }
    })
  }, delay)
}

/**
 * Close SSH tunnel
 */
function closeTunnel() {
  const releasedPort = currentSettings?.tunnelLocalPort || null
  log('Closing tunnel', releasedPort ? `(released localhost:${releasedPort})` : '')
  wantTunnel = false
  tunnelOptions = null
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0
  reconnectDelayMs = RECONNECT_BASE_MS
  cleanup()
  return { success: true, releasedPort }
}

/**
 * Check if tunnel is currently active
 */
function isTunnelActive() {
  return sshClient !== null && tunnelServer !== null
}

/**
 * Get tunnel status
 */
function getTunnelStatus() {
  const active = isTunnelActive()
  return {
    active,
    connecting: isConnecting,
    settings: currentSettings,
    // The port the forwarder actually bound. It differs from the configured one
    // when something else already had 8188, and the UI must show the real number.
    localPort: active ? (currentSettings?.tunnelLocalPort ?? null) : null,
    requestedPort: currentSettings?.tunnelLocalPort
      ? (currentSettings?.tunnelRequestedPort ?? currentSettings.tunnelLocalPort)
      : null,
  }
}

/**
 * Execute command on remote server via SSH
 * @param {string} command - Command to execute
 * @returns {Promise<{success: boolean, stdout?: string, stderr?: string, error?: string}>}
 */
function execRemoteCommand(command) {
  return new Promise((resolve) => {
    if (!sshClient || sshClient._connectSocket === undefined) {
      resolve({ success: false, error: 'Not connected to SSH server' })
      return
    }

    sshClient.exec(command, (err, stream) => {
      if (err) {
        resolve({ success: false, error: err.message })
        return
      }

      let stdout = ''
      let stderr = ''

      stream.on('close', (code) => {
        resolve({
          success: code === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code,
        })
      })

      stream.on('data', (data) => {
        stdout += data.toString()
      })

      stream.stderr.on('data', (data) => {
        stderr += data.toString()
      })
    })
  })
}

/**
 * Check if remote ComfyUI is reachable through tunnel
 */
async function checkRemoteComfyUI(port = 8188, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)

    socket.on('connect', () => {
      finish({ ok: true, message: 'ComfyUI is reachable' })
    })

    socket.on('timeout', () => {
      finish({ ok: false, message: 'Connection timed out' })
    })

    socket.on('error', (err) => {
      finish({ ok: false, message: err.message })
    })

    socket.connect(port, '127.0.0.1')
  })
}

/**
 * List installed models on remote server
 */
async function listRemoteModels(modelRoot) {
  if (!modelRoot) {
    return { success: false, error: 'Model root path not configured' }
  }

  const result = await execRemoteCommand(`find "${modelRoot}" -type d -maxdepth 2 -name "*.safetensors" -o -name "*.ckpt" -o -name "*.pth" 2>/dev/null | head -50`)
  
  if (!result.success) {
    return { success: false, error: result.stderr || result.error }
  }

  const models = result.stdout.split('\n').filter(m => m.trim())
  return { success: true, models, count: models.length }
}

/**
 * List installed custom nodes on remote server
 */
async function listRemoteNodes(nodesRoot) {
  if (!nodesRoot) {
    return { success: false, error: 'Nodes root path not configured' }
  }

  const result = await execRemoteCommand(`ls -la "${nodesRoot}" 2>/dev/null`)
  
  if (!result.success) {
    return { success: false, error: result.stderr || result.error }
  }

  const dirs = result.stdout.split('\n')
    .filter(line => line.startsWith('d'))
    .map(line => line.split(/\s+/).pop())
    .filter(name => name && name !== '.' && name !== '..')

  return { success: true, nodes: dirs, count: dirs.length }
}

/**
 * Check if a specific model exists on remote
 */
async function checkRemoteModel(modelRoot, modelName) {
  if (!modelRoot) {
    return { success: false, error: 'Model root path not configured' }
  }

  const result = await execRemoteCommand(`find "${modelRoot}" -name "${modelName}" -type f 2>/dev/null | head -1`)
  const exists = result.success && result.stdout.trim().length > 0

  return {
    success: true,
    exists,
    path: exists ? result.stdout.trim() : null,
  }
}

/**
 * Install a custom node via git clone on remote
 */
async function installRemoteNode(nodesRoot, gitUrl, nodeName = null) {
  if (!nodesRoot) {
    return { success: false, error: 'Nodes root path not configured' }
  }

  const targetDir = nodeName || gitUrl.split('/').pop().replace('.git', '')
  const targetPath = `${nodesRoot}/${targetDir}`

  // Check if already installed
  const checkResult = await execRemoteCommand(`test -d "${targetPath}" && echo "exists" || echo "not_found"`)
  if (checkResult.stdout.trim() === 'exists') {
    return { success: false, error: `Node already installed at ${targetPath}` }
  }

  // Clone the repository
  const cloneResult = await execRemoteCommand(`cd "${nodesRoot}" && git clone "${gitUrl}"`)
  
  if (!cloneResult.success) {
    return { success: false, error: `Git clone failed: ${cloneResult.stderr}` }
  }

  // Check for requirements.txt and install
  const reqCheck = await execRemoteCommand(`test -f "${targetPath}/requirements.txt" && echo "needs_install" || echo "no_reqs"`)
  if (reqCheck.stdout.trim() === 'needs_install') {
    const pipResult = await execRemoteCommand(`cd "${targetPath}" && pip install -r requirements.txt`)
    if (!pipResult.success) {
      return { success: true, warning: `Installed but pip requirements failed: ${pipResult.stderr}`, path: targetPath }
    }
  }

  return { success: true, path: targetPath }
}

/**
 * Get remote ComfyUI version/info
 */
async function getRemoteComfyInfo() {
  // Try to get git info if it's a git repo
  const gitResult = await execRemoteCommand('cd ~/.comfyui 2>/dev/null || cd ~/ComfyUI 2>/dev/null || echo "not_found"')
  
  if (gitResult.stdout.trim() === 'not_found') {
    return { success: false, error: 'Could not find ComfyUI directory' }
  }

  const branchResult = await execRemoteCommand('git branch --show-current 2>/dev/null || echo "unknown"')
  const commitResult = await execRemoteCommand('git rev-parse HEAD 2>/dev/null || echo "unknown"')

  return {
    success: true,
    branch: branchResult.stdout.trim(),
    commit: commitResult.stdout.trim(),
  }
}

module.exports = {
  DEFAULT_REMOTE_SERVER_SETTINGS,
  REMOTE_SERVER_SETTING_KEY,
  establishTunnel,
  closeTunnel,
  isTunnelActive,
  getTunnelStatus,
  execRemoteCommand,
  checkRemoteComfyUI,
  listRemoteModels,
  listRemoteNodes,
  checkRemoteModel,
  installRemoteNode,
  getRemoteComfyInfo,
  getRemoteServerSettings,
  saveRemoteServerSettings,
  // exposed for tests: the port-fallback behaviour is the whole point of the fix
  probeLocalComfyPort,
  bindForwarder,
  describeBusyPorts,
  createForwardingServer,
  closeForwardingServer,
}
;/* BELROG_DEDUP_WRAPPER_v2 - why: two establishTunnel calls for the same port used to
   race, the loser hit EADDRINUSE, and the old server handler then dereferenced a null
   conn.forwardOut in a tight crash loop that took ComfyUI forwarding (and Qwen image
   gen) down. v1 cached the promise per port forever, so a failure - including that
   "port is already in use" - was replayed on every later Connect. Fix: share only the
   in-flight attempt, drop the cache as soon as it settles, patch the exported symbol so
   main.js actually gets the wrapper, and swallow the null-conn forwardOut throw. */
(function(){
  try {
    if (typeof establishTunnel === "undefined") return;
    const _orig = establishTunnel;
    const _active = (globalThis.__belrogTunnels = globalThis.__belrogTunnels || {});
    const wrapped = function(opts){
      opts = opts || {};
      const lp = opts.tunnelLocalPort || opts.localPort || 8188;
      if (_active[lp]) return _active[lp];
      const p = _orig.apply(this, arguments);
      _active[lp] = p;
      const forget = () => { if (_active[lp] === p) delete _active[lp]; };
      Promise.resolve(p).then(forget, forget);
      return p;
    };
    globalThis.establishTunnel = wrapped;
    if (typeof module !== "undefined" && module.exports) module.exports.establishTunnel = wrapped;
    if (typeof closeTunnel === "function" && typeof module !== "undefined" && module.exports) {
      const _close = closeTunnel;
      const closed = function(){ globalThis.__belrogTunnels = {}; return _close.apply(this, arguments); };
      module.exports.closeTunnel = closed;
    }
    if (typeof process !== "undefined" && process.on) {
      process.on("uncaughtException", (e)=>{
        if (e && /forwardOut/.test(String((e&&e.message)||e)+String((e&&e.stack)||""))) {
          console.warn("[sshTunnel] suppressed null-conn forwardOut crash");
          return;
        }
        // Anything else must stay visible; rethrowing from inside this handler
        // turns a recoverable error into a hard abort.
        console.error("[sshTunnel] uncaught:", (e && (e.stack || e.message)) || e);
      });
    }
  } catch(e){ console.warn("[sshTunnel] wrapper install failed: "+e.message); }
})();
