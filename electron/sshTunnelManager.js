/**
 * SSH Tunnel Manager for Belrog
 * Establishes SSH port forwarding to enable remote ComfyUI access
 * as if it were running on localhost:8188
 */

const { Client } = require('ssh2')
const net = require('net')
const os = require('os')

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

    sshClient.on('ready', () => {
      log('SSH connection ready, establishing port forward')
      
      // Create port forwarding server on localhost
      tunnelServer = net.createServer((localSocket) => {
        const remoteHost = '127.0.0.1' // Always forward to localhost on remote
        const remotePort = opts.tunnelRemotePort

        sshClient.forwardOut(
          localSocket.remoteAddress,
          localSocket.remotePort,
          remoteHost,
          remotePort,
          (err, stream) => {
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
          }
        )
      })

      tunnelServer.on('error', (err) => {
        logError('Tunnel server error:', err.message)
        if (err.code === 'EADDRINUSE') {
          resolve({ success: false, error: `Port ${opts.tunnelLocalPort} is already in use. Close other ComfyUI instances.` })
          cleanup()
          return
        }
      })

      tunnelServer.listen(opts.tunnelLocalPort, '127.0.0.1', () => {
        isConnecting = false
        log(`Tunnel active: localhost:${opts.tunnelLocalPort} -> ${opts.sshHost}:${opts.tunnelRemotePort}`)
        resolve({ success: true })
      })
    })

    sshClient.on('error', (err) => {
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

    sshClient.on('close', () => {
      log('SSH connection closed')
      cleanup()
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
      keepaliveInterval: 30000,
    })
  })
}

/**
 * Cleanup tunnel resources
 */
function cleanup() {
  if (tunnelServer) {
    try {
      tunnelServer.close()
    } catch {}
    tunnelServer = null
  }
  if (sshClient) {
    try {
      sshClient.end()
    } catch {}
    sshClient = null
  }
  isConnecting = false
}

/**
 * Close SSH tunnel
 */
function closeTunnel() {
  log('Closing tunnel')
  cleanup()
  return { success: true }
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
  return {
    active: isTunnelActive(),
    connecting: isConnecting,
    settings: currentSettings,
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
}
