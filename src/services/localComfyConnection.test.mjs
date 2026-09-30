import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * Connection-resolver tests for the remote-ComfyUI mode lock.
 * These pin the invariant from plan B.5.1: the mode + tunnel state —
 * never a stale localStorage port — decides which port the ComfyUI
 * connection targets. Run with:
 *   node --experimental-default-type=module --test ./src/services/localComfyConnection.test.js
 */

function installWindow({ remoteSettings = null, tunnelStatus = null } = {}) {
  globalThis.window = {
    electronAPI: {
      getSetting: async () => undefined,
      setSetting: async () => true,
      getRemoteServerSettings: async () => remoteSettings,
      getTunnelStatus: async () => tunnelStatus,
    },
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

// Each test installs its own window mock + mode state, so reset the
// module's process-global hydration/mode state before hydrating.
let conn
test.before(async () => {
  conn = await import('./localComfyConnection.js')
})
test.beforeEach(() => {
  conn.__resetLocalComfyConnectionForTests()
  delete globalThis.localStorage
})

test('local mode (remote disabled): default port, mode=local, not reconnecting', async () => {
  installWindow({ remoteSettings: { enabled: false }, tunnelStatus: { active: false } })
  const conn = await import('./localComfyConnection.js')
  await conn.hydrateLocalComfyConnection()
  const config = conn.getLocalComfyConnectionSync()
  assert.equal(config.httpBase, 'http://127.0.0.1:8188')
  assert.equal(config.wsBase, 'ws://127.0.0.1:8188')
  assert.equal(config.mode, 'local')
  assert.equal(config.reconnecting, false)
  assert.equal(conn.getLocalComfyHttpBaseSync(), 'http://127.0.0.1:8188')
  assert.equal(conn.getLocalComfyWsBaseSync(), 'ws://127.0.0.1:8188')
})

test('remote mode + tunnel up: tunnel port wins, mode=remote', async () => {
  installWindow({
    remoteSettings: { enabled: true, tunnelLocalPort: 8199, tunnelRemotePort: 8188 },
    tunnelStatus: { active: true, settings: { tunnelLocalPort: 8199 } },
  })
  const conn = await import('./localComfyConnection.js')
  await conn.hydrateLocalComfyConnection()
  const config = conn.getLocalComfyConnectionSync()
  assert.equal(config.port, 8199)
  assert.equal(config.httpBase, 'http://127.0.0.1:8199')
  assert.equal(config.wsBase, 'ws://127.0.0.1:8199')
  assert.equal(config.mode, 'remote')
  assert.equal(config.reconnecting, false)
})

test('stale localStorage port never overrides the tunnel port', async () => {
  // Simulate a cached local port from a previous local-mode session.
  globalThis.localStorage = {
    store: { 'comfystudio-comfy-connection': JSON.stringify({ port: 8187 }) },
    getItem(k) { return this.store[k] ?? null },
    setItem(k, v) { this.store[k] = v },
  }
  installWindow({
    remoteSettings: { enabled: true, tunnelLocalPort: 8210 },
    tunnelStatus: { active: true, settings: { tunnelLocalPort: 8210 } },
  })
  const conn = await import('./localComfyConnection.js')
  await conn.hydrateLocalComfyConnection()
  const config = conn.getLocalComfyConnectionSync()
  assert.equal(config.port, 8210, 'tunnel port must win over the cached 8187')
  assert.equal(config.mode, 'remote')
  assert.equal(config.reconnecting, false)
  delete globalThis.localStorage
})

test('remote mode + tunnel down: last-good port kept, reconnecting=true', async () => {
  installWindow({
    remoteSettings: { enabled: true, tunnelLocalPort: 8199 },
    tunnelStatus: { active: false, settings: { tunnelLocalPort: 8199 } },
  })
  const conn = await import('./localComfyConnection.js')
  await conn.hydrateLocalComfyConnection()
  const config = conn.getLocalComfyConnectionSync()
  assert.equal(config.mode, 'remote')
  assert.equal(config.reconnecting, true)
  // Not probing a port to guess: falls back to the cached/default port.
  assert.equal(config.port, 8188)
})

test('refreshComfyConnectionMode tracks tunnel coming up (port switches to tunnel port)', async () => {
  installWindow({
    remoteSettings: { enabled: true, tunnelLocalPort: 8199 },
    tunnelStatus: { active: false },
  })
  const conn = await import('./localComfyConnection.js')
  await conn.hydrateLocalComfyConnection()
  assert.equal(conn.getLocalComfyConnectionSync().reconnecting, true)

  // Tunnel comes up (main-process auto-reconnect).
  globalThis.window.electronAPI.getTunnelStatus = async () => ({
    active: true,
    settings: { tunnelLocalPort: 8199 },
  })
  const after = await conn.refreshComfyConnectionMode()
  assert.equal(after.port, 8199)
  assert.equal(after.mode, 'remote')
  assert.equal(after.reconnecting, false)
  assert.equal(conn.getLocalComfyHttpBaseSync(), 'http://127.0.0.1:8199')
})

test('refreshComfyConnectionMode never throws when IPC is missing (browser/dev context)', async () => {
  delete globalThis.window
  const conn = await import('./localComfyConnection.js')
  const config = await conn.refreshComfyConnectionMode()
  assert.equal(typeof config.httpBase, 'string')
  assert.ok(config.httpBase.startsWith('http://127.0.0.1:'))
})

test('saveLocalComfyConnectionPort keeps local behavior byte-identical (loopback only)', async () => {
  installWindow({ remoteSettings: { enabled: false } })
  const conn = await import('./localComfyConnection.js')
  await conn.hydrateLocalComfyConnection()

  const ok = await conn.saveLocalComfyConnectionPort('8999')
  assert.equal(ok.success, true)
  assert.equal(ok.config.httpBase, 'http://127.0.0.1:8999')

  const rejected = await conn.saveLocalComfyConnectionPort('http://10.0.0.5:8188')
  assert.equal(rejected.success, false)
  assert.match(rejected.error, /localhost\/127\.0\.0\.1 only/)
})