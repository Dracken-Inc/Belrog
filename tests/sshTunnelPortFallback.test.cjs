/**
 * The remote-server tunnel used to hard-fail with "Port 8188 is already in use.
 * Close other ComfyUI instances." whenever something else on the machine already
 * answered on 8188 - a second Belrog tab, a leftover forwarder, or a local
 * ComfyUI/docker instance, which is normal on a creator's box. These tests drive
 * the real bind/forward code paths, not string checks.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const http = require('node:http')
const { Duplex } = require('node:stream')

const tunnel = require('../electron/sshTunnelManager')

// Without this a stuck await hangs the whole file forever (and CI with it);
// a ceiling turns a hang into a named failure you can act on.
const TEST_TIMEOUT_MS = 15000
const _test = test
const testNamed = (name, fn) => _test(name, { timeout: TEST_TIMEOUT_MS }, fn)

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/** A port nobody is using, so the tests do not depend on what the dev box runs. */
async function freePort() {
  const probe = net.createServer()
  await listen(probe, 0)
  const { port } = probe.address()
  await closeAll(probe)
  return port
}

/**
 * Tear a fixture down the way a real process exiting would: drop its live
 * connections, then release the port. server.close() alone waits for sockets it
 * still thinks are open (net.Server defaults to allowHalfOpen), which is the same
 * hostage problem the tunnel forwarder had - but here it would just make the
 * test hang on teardown instead of testing anything.
 */
function closeAll(...servers) {
  return Promise.all(servers.filter(Boolean).map((s) => new Promise((resolve) => {
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections()
    s.close(resolve)
  })))
}

/** Something that answers /system_stats exactly like ComfyUI does. */
async function squatComfyUi(port) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ system: { os: 'linux', ram_total: 1 }, comfyui_version: '0.34.0' }))
  })
  await listen(server, port)
  return server
}

testNamed('probeLocalComfyPort tells a ComfyUI apart from an unrelated listener', async () => {
  const comfy = await squatComfyUi(0)
  const port = comfy.address().port
  assert.deepEqual(await tunnel.probeLocalComfyPort(port), { open: true, comfy: true })

  const plain = await listen(net.createServer((socket) => socket.destroy()), 0)
  const plainPort = plain.address().port
  const probe = await tunnel.probeLocalComfyPort(plainPort)
  assert.equal(probe.open, true)
  assert.equal(probe.comfy, false)

  assert.equal((await tunnel.probeLocalComfyPort(1)).open, false)
  await closeAll(comfy, plain)
})

testNamed('a ComfyUI already on the requested port moves the tunnel to the next free one', async () => {
  const base = await freePort()
  const squatter = await squatComfyUi(base)
  let bound = null
  try {
    bound = await tunnel.bindForwarder(() => net.createServer(), base, { maxTries: 4 })
    assert.ok(bound.server, 'bindForwarder must not give up while a port is free')
    assert.ok(bound.port > base, `expected the tunnel to move off ${base}, got ${bound.port}`)
    assert.equal(bound.attempts.find((a) => a.port === base)?.comfy, true)
  } finally {
    await closeAll(bound?.server, squatter)
  }
})

testNamed('a free port is used as-is, so the usual case still lands on the expected port', async () => {
  const base = await freePort()
  const bound = await tunnel.bindForwarder(() => net.createServer(), base, { maxTries: 4 })
  try {
    assert.equal(bound.port, base)
    assert.deepEqual(bound.attempts, [])
  } finally {
    await closeAll(bound.server)
  }
})

testNamed('when nothing can be bound the user is told what holds the port', async () => {
  const base = await freePort()
  const squatter = await squatComfyUi(base)
  let bound = null
  try {
    bound = await tunnel.bindForwarder(() => net.createServer(), base, { maxTries: 1 })
    assert.equal(bound.server, null)
    const message = tunnel.describeBusyPorts(bound.attempts)
    assert.match(message, new RegExp(String(base)))
    assert.match(message, /ComfyUI/i)
    assert.doesNotMatch(message, /Close other ComfyUI instances/i)
  } finally {
    await closeAll(bound?.server, squatter)
  }
})

testNamed('the forwarder pipes a request through to the remote port', async () => {
  const calls = []
  const server = tunnel.createForwardingServer(() => (srcHost, srcPort, host, port, cb) => {
    calls.push({ srcHost, srcPort, host, port })
    const echo = new Duplex({ read() {}, write(chunk, _enc, cb2) { this.push(chunk); cb2() } })
    cb(null, echo)
  }, 8188)
  await listen(server, 0)
  const port = server.address().port
  let socket = null
  try {
    const reply = await new Promise((resolve, reject) => {
      socket = net.connect(port, '127.0.0.1', () => socket.write('ping'))
      socket.once('data', resolve)
      socket.once('error', reject)
    })
    assert.equal(reply.toString(), 'ping')
    assert.deepEqual(calls, [{ srcHost: '127.0.0.1', srcPort: calls[0].srcPort, host: '127.0.0.1', port: 8188 }])
  } finally {
    tunnel.closeForwardingServer(server)
    socket?.destroy()
  }
})

testNamed('force-closing the forwarder drops a client that is still connected', async () => {
  // What "Disconnect" has to mean: the forwarder is gone, not "gone once the
  // browser tab behaves". A keep-alive socket (an open ComfyUI tab, a hung
  // generation request) used to sit in the server's connection list, so the
  // server never finished closing and the old forwarder lingered behind the new
  // one. Measured on Linux, plain server.close() leaves this socket open forever.
  const server = tunnel.createForwardingServer(() => (h, hp, rh, rp, cb) => {
    const echo = new Duplex({ read() {}, write(c, _e, cb2) { this.push(c); cb2() } })
    cb(null, echo)
  }, 8188)
  await listen(server, 0)
  const port = server.address().port
  const stuck = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => { socket.write('ping'); resolve(socket) })
    socket.once('error', reject)
  })
  try {
    assert.equal(stuck.destroyed, false, 'the client is meant to be connected and staying connected')
    assert.equal(stuck.readyState, 'open')

    // Nothing here closes the client side on purpose: if it ends, it can only be
    // because closeForwardingServer dropped it. Bounded so a regression fails with
    // a name instead of hanging the file (which looks like a broken runner).
    const outcome = await new Promise((resolve) => {
      const started = Date.now()
      const timer = setTimeout(() => resolve({ dropped: false, closed: false }), 3000)
      let dropped = false
      stuck.once('close', () => { dropped = true })
      server.once('close', () => {
        clearTimeout(timer)
        resolve({ dropped, closed: true, ms: Date.now() - started })
      })
      tunnel.closeForwardingServer(server)
    })
    assert.ok(outcome.closed, 'the forwarder must finish closing instead of waiting on a live socket')

    // The destroy only reaches the client a few turns of the event loop later, so
    // wait for it rather than reading the socket in the same tick as 'close'.
    const dropped = await new Promise((resolve) => {
      if (stuck.destroyed || stuck.readyState === 'closed') { resolve(true); return }
      const timer = setTimeout(() => resolve(false), 2000)
      stuck.once('close', () => { clearTimeout(timer); resolve(true) })
    })
    assert.ok(dropped, 'the still-connected client must be dropped by Disconnect, not left open')
    assert.equal(stuck.readyState, 'closed')

    // A fresh forwarder must be able to take the port right now. (Secondary: on
    // Linux a listener can take a port held only by an old established socket, so
    // this alone would not catch the bug - the two assertions above do.)
    const again = tunnel.createForwardingServer(() => null, 8188)
    await listen(again, port)
    assert.equal(again.address().port, port)
    await closeAll(again)
  } finally {
    stuck.destroy()
    await closeAll(server)
  }
})

testNamed('a request that arrives after the tunnel closed drops the socket instead of crashing', async () => {
  const server = tunnel.createForwardingServer(() => null, 8188)
  await listen(server, 0)
  try {
    await new Promise((resolve) => {
      const socket = net.connect(server.address().port, '127.0.0.1')
      socket.once('error', resolve)
      socket.once('close', resolve)
      socket.once('end', resolve)
    })
  } finally {
    tunnel.closeForwardingServer(server)
  }
})

testNamed('the connect handler does not replay an old failure or a dead tunnel', async () => {
  // A sequential retry must really retry: v1 of the dedup wrapper cached the
  // promise per port forever, so "port is already in use" stuck to every later
  // Connect even after the port was free.
  const logged = []
  const realLog = console.log
  // log() prints console.log('[sshTunnelManager]', timestamp, message), so the
  // marker is never argument 0 - scanning only a[0] counted nothing and "passed".
  const grab = (...args) => {
    if (args.some((a) => String(a).includes('establishTunnel called'))) logged.push(args.join(' '))
  }
  console.log = grab
  try {
    await tunnel.establishTunnel({ sshHost: '', sshUsername: '', sshKeyPath: '' })
    const second = await tunnel.establishTunnel({ sshHost: '', sshUsername: '', sshKeyPath: '' })
    assert.equal(logged.length, 2, 'a second Connect attempt must run again, not return a cached result')
    assert.equal(second.success, false)

    // Concurrent attempts share one real attempt.
    logged.length = 0
    await Promise.all([
      tunnel.establishTunnel({ sshHost: '', sshUsername: '', sshKeyPath: '' }),
      tunnel.establishTunnel({ sshHost: '', sshUsername: '', sshKeyPath: '' }),
    ])
    assert.equal(logged.length, 1, 'two simultaneous Connect clicks must open one tunnel')
  } finally {
    console.log = realLog
  }
})
