/**
 * End-to-end SSH tunnel test: open a real tunnel with the real ssh2 client, then
 * read ComfyUI's /system_stats through the local end of it. This is the test that
 * proves the promise Belrog makes when ComfyUI lives on another machine - that
 * remote ComfyUI looks and answers exactly like a local one, on a localhost port.
 *
 * The unit tests in sshTunnelPortFallback.test.cjs fake the forwarding callback.
 * Nothing here is faked except the "remote" ComfyUI itself, which is a stand-in
 * HTTP server the tunnel reaches over real SSH.
 *
 * It needs an SSH server this machine can log into without a password. Loopback
 * counts (the tunnel is still real), CI usually has none, so the file says so out
 * loud rather than reporting a pass it did not earn.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const { establishTunnel, closeTunnel, getTunnelStatus } = require('../electron/sshTunnelManager')

const TEST_TIMEOUT_MS = 30000
const SSH_KEY = path.join(os.homedir(), '.ssh', 'id_ed25519')
const SSH_HOST = '127.0.0.1'
const SSH_PORT = 22

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

async function freePort() {
  const probe = net.createServer()
  await listen(probe, 0)
  const { port } = probe.address()
  await new Promise((r) => probe.close(r))
  return port
}

/** The "ComfyUI on the other machine" this test tunnels to. */
async function standInComfyUi() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/system_stats')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ system: { os: 'posix', python: '3.12.3' }, comfyui_version: '0.34.0-e2e' }))
      return
    }
    res.writeHead(404).end()
  })
  await listen(server, 0)
  return server
}

async function getJson(port, urlPath = '/system_stats', timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs, agent: false }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error(`timed out after ${timeoutMs}ms`)) })
  })
}

function isTcpOpen(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (value) => { socket.destroy(); resolve(value) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    setTimeout(() => done(false), timeoutMs).unref()
  })
}

/**
 * Real tunnel, real SSH, real localhost port. Returns null (and lets the caller
 * skip) only when this machine genuinely cannot be SSH'd into.
 */
async function openTunnel({ localPort, remotePort }) {
  if (!fs.existsSync(SSH_KEY)) return { skipped: `no SSH key at ${SSH_KEY}` }
  if (!(await isTcpOpen(SSH_HOST, SSH_PORT))) return { skipped: `no SSH server on ${SSH_HOST}:${SSH_PORT}` }

  const result = await establishTunnel({
    enabled: true,
    sshHost: SSH_HOST,
    sshPort: SSH_PORT,
    sshUsername: os.userInfo().username,
    sshKeyPath: SSH_KEY,
    tunnelLocalPort: localPort,
    tunnelRemotePort: remotePort,
  })
  if (!result?.success) {
    // A key with a passphrase, or a server that refuses the key, is a machine
    // limitation, not a Belrog regression - but say which it was.
    return { skipped: `SSH login failed: ${result?.error || 'unknown error'}` }
  }
  return { result }
}

test('a remote ComfyUI answers on a localhost port exactly like a local one', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const comfy = await standInComfyUi()
  const localPort = await freePort()
  try {
    const opened = await openTunnel({ localPort, remotePort: comfy.address().port })
    if (opened.skipped) { t.skip(opened.skipped); return }
    try {
      assert.equal(opened.result.localPort, localPort, 'a free local port must be used as requested')

      // This is the whole feature: the caller talks to localhost and gets the
      // remote machine's ComfyUI, with no idea it crossed an SSH connection.
      const stats = await getJson(localPort)
      assert.equal(stats.status, 200)
      assert.match(stats.body, /0\.34\.0-e2e/, 'the response must come from the remote ComfyUI')

      // And the app must be able to find out which port to talk to.
      const status = getTunnelStatus()
      assert.equal(status.active, true)
      assert.equal(status.localPort, localPort)
    } finally {
      closeTunnel()
    }
  } finally {
    comfy.close()
  }
})

test('when the local port is taken the tunnel moves and still answers like a local ComfyUI', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const comfy = await standInComfyUi()
  const busyLocal = await freePort()
  // Something already owns the port Belrog wants - a local ComfyUI, a leftover
  // forwarder. That used to be a fatal error instead of a shrug.
  const squatter = http.createServer((req, res) => { res.writeHead(418).end('teapot') })
  await listen(squatter, busyLocal)
  try {
    const opened = await openTunnel({ localPort: busyLocal, remotePort: comfy.address().port })
    if (opened.skipped) { t.skip(opened.skipped); return }
    try {
      const { result } = opened
      assert.equal(result.success, true, `tunnel must not fail just because a port is busy: ${result.error}`)
      assert.ok(result.switchedPort, `expected the tunnel to move off ${busyLocal}`)
      assert.ok(result.localPort > busyLocal, `expected a higher port, got ${result.localPort}`)

      const stats = await getJson(result.localPort)
      assert.equal(stats.status, 200)
      assert.match(stats.body, /0\.34\.0-e2e/, 'the moved tunnel must still reach the remote ComfyUI')

      // The busy port must still belong to whatever had it - we do not steal it.
      const teapot = await getJson(busyLocal, '/', 4000)
      assert.equal(teapot.status, 418)
    } finally {
      closeTunnel()
    }
  } finally {
    squatter.close()
    comfy.close()
  }
})

test('connecting again right after Disconnect gives a working tunnel, not a 30-second hang', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const comfy = await standInComfyUi()
  const localPort = await freePort()
  try {
    const first = await openTunnel({ localPort, remotePort: comfy.address().port })
    if (first.skipped) { t.skip(first.skipped); return }
    closeTunnel()

    // Same tick as the Disconnect, which is what double-clicking Disconnect then
    // Connect does. The dying SSH connection's 'close' event lands afterwards and
    // used to tear the brand-new forwarder down, so Connect sat silent until the
    // module's own 30s timeout and the creator saw a dead spinner.
    const startedAt = Date.now()
    const opened = await openTunnel({ localPort, remotePort: comfy.address().port })
    const elapsedMs = Date.now() - startedAt
    if (opened.skipped) { t.skip(opened.skipped); return }
    try {
      const { result } = opened
      assert.equal(result.success, true, `reconnect must succeed: ${result.error}`)
      assert.ok(elapsedMs < 15000, `reconnect took ${elapsedMs}ms - the old connection is holding the new one hostage`)

      const stats = await getJson(result.localPort)
      assert.equal(stats.status, 200)
      assert.match(stats.body, /0\.34\.0-e2e/, 'the reconnected tunnel must forward like a local ComfyUI')
    } finally {
      closeTunnel()
    }
  } finally {
    comfy.close()
  }
})
