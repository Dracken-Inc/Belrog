'use strict'

// Real production files extracted from a disposable ASAR. Electron, native
// image decoding and provider responses are synthetic; no profile or network.
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm')
const { EventEmitter } = require('node:events')
const asar = require('@electron/asar')
const { createRouterTestPng } = require('./helpers/routerImage.cjs')
const root = path.resolve(__dirname, '..')
const files = ['electron/comfyRouter.cjs', 'electron/comfyRouterIpc.cjs', 'electron/preload.js', 'electron/main.js',
  'electron/createModels.cjs', 'electron/createModels.json', 'electron/createRequests.cjs']
// The Router may load only these packaged Create data modules besides Node built-ins.
const local = { './createModels.cjs': 'electron/createModels.cjs', './createModels.json': 'electron/createModels.json', './createRequests.cjs': 'electron/createRequests.cjs' }
const KEY = 'synthetic-packaged-router-key-not-a-real-credential'
const PNG = createRouterTestPng()
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
let packageRoot, archive, sources

test.before(async () => {
  packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'belrog-router-asar-'))
  const stage = path.join(packageRoot, 'source'); archive = path.join(packageRoot, 'app.asar')
  await fs.mkdir(path.join(stage, 'electron'), { recursive: true })
  for (const file of files) await fs.copyFile(path.join(root, file), path.join(stage, file))
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('electron/**/*'))
  assert.ok(require('./helpers/nativeExclusions.cjs').onlyReviewedNativeExclusions(pkg.build.files))
  await asar.createPackage(stage, archive)
  sources = Object.fromEntries(files.map(file => {
    assert.equal(asar.statFile(archive, file).unpacked, undefined)
    return [file, asar.extractFile(archive, file).toString('utf8')]
  }))
})
test.after(async () => {
  asar.uncacheAll()
  if (packageRoot) await fs.rm(packageRoot, { recursive: true, force: true })
})

async function fixture(t, options = {}) {
  const userData = await fs.mkdtemp(path.join(packageRoot, 'profile-'))
  const handlers = new Map(), requests = [], dialogs = [], logs = [], opens = [], ipcCalls = [], actions = [], decodes = []
  const emitter = new EventEmitter()
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false,
    send: (name, ...values) => emitter.emit(name, {}, ...values) })
  const window = { webContents: contents, isDestroyed: () => false }
  let from = { sender: contents, senderFrame: contents.mainFrame }, bridge, manager
  const authorized = from
  const state = { projectKey: path.join(userData, 'synthetic-project'), session: 'synthetic-main-session',
    policy: 'ask-cloud', approve: false, checkbox: true, emptyImage: false, width: 1024, height: 1024,
    time: Date.now(), providerStatus: 'COMPLETED' }
  const runtime = { navigator: { userActivation: { isActive: false } }, fetch: () => assert.fail('Ambient fetch is forbidden') }
  const ipcMain = { handle: (name, callback) => { assert.ok(!handlers.has(name)); handlers.set(name, callback) }, removeHandler: name => handlers.delete(name) }
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'electronAPI') bridge = value } },
    ipcRenderer: { invoke: (name, payload) => { ipcCalls.push({ name, payload }); return handlers.get(name)(from, payload) },
      on: (...args) => emitter.on(...args), removeListener: (...args) => emitter.removeListener(...args) },
  }
  const loaded = new Map()
  function load(file) {
    if (file.endsWith('.json')) return JSON.parse(sources[file])
    const module = { exports: {} }
    vm.runInThisContext(`(function(require,module,exports,globalThis,console){${sources[file]}\n})`, { filename: `${archive}/${file}` })(name => {
      if (name === 'electron') return electron
      if (Object.hasOwn(local, name)) { if (!loaded.has(name)) loaded.set(name, load(local[name])); return loaded.get(name) }
      assert.ok(['node:path', 'node:fs/promises', 'node:fs', 'node:crypto'].includes(name), `Unexpected dependency ${name}`)
      return require(name)
    }, module, module.exports, runtime, { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) })
    return module.exports
  }
  const native = load(files[0]), ipc = load(files[1]); load(files[2])
  const main = sources['electron/main.js'], start = main.indexOf('let comfyRouter = null\n')
  const end = main.indexOf('\nconst { createGenerationMemoryCleanup', start)
  assert.ok(start >= 0 && end > start, 'Production native Router factory and IPC registration remain wired')
  const wiring = main.slice(start, end)
  // The Router factory in main.js must not read settings, guess a local ComfyUI port, or touch the
  // hosted-service key itself. `safeStorage` used to belong on this list, but the key store is
  // handed the module so the Router key can be encrypted at rest (comfyRouterKeyStore.cjs), which
  // is the one sanctioned use of key material here. Naming the module made the check reject that
  // wiring, so it went red in the 0.4 merge and stayed red for nobody. What has to stay forbidden
  // is main.js doing its own crypto or its own credential lookup in this region.
  assert.doesNotMatch(wiring, /readSettingsRaw|resolveLocalComfyPort|comfyApiKeyComfyOrg|comfyHosted/)
  assert.doesNotMatch(wiring, /safeStorage\s*\.\s*(?:encrypt|decrypt|isEncryptionAvailable)/)
  // Every provider call lands here, whether the Router used net.fetch for a comfy.org address or
  // main.js's resultFetch for anything else - both are wired in the block being evaluated.
  const localVoice = [], comfyRouterIpcCalls = []
  const providerFetch = async (url, request) => {
    requests.push({ url, ...request })
    if (options.transport) return options.transport(url, request)
    if (request.method === 'POST') return response({ request_id: 'synthetic-provider-job', status: 'IN_QUEUE' }, 201)
    if (request.method === 'PUT') return response({ status: 'CANCELLATION_REQUESTED' }, 202)
    if (url.endsWith('/status')) return response({ status: state.providerStatus })
    if (url.endsWith('/synthetic-provider-job')) return response({ data: [{ b64_json: PNG.toString('base64') }] })
    return response({ id: native.MODEL, private_provider_field: 'must-not-leak' })
  }
  const scope = {
    Buffer, path, app: { isPackaged: true, getPath: name => { assert.equal(name, 'userData'); return userData } },
    mainWindow: window, ipcMain,
    registerComfyRouterIpc: registration => { comfyRouterIpcCalls.push(registration); return ipc.registerComfyRouterIpc(registration) },
    createComfyRouter: configuration => { manager = native.createComfyRouter({ ...configuration, now: () => state.time }); return manager },
    exportJobs: { activeId: null }, generationSpending: { getStatus: async () => ({ policy: state.policy }) },
    performMcpRendererAction: async payload => { actions.push(payload); return { agentContext: { context: { session: state.session, projectKey: state.projectKey } } } },
    shell: { openExternal: async url => { opens.push(url) } },
    dialog: { showMessageBox: async (owner, value) => { assert.equal(owner, window); dialogs.push(value); return { response: state.approve ? 1 : 0, checkboxChecked: state.checkbox } } },
    nativeImage: { createFromBuffer: bytes => { decodes.push(Buffer.from(bytes)); return { isEmpty: () => state.emptyImage, getSize: () => ({ width: state.width, height: state.height }) } } },
    net: { fetch: providerFetch },
    // main.js builds these in the same block of source this test evaluates, so the fixture has to
    // name them. The key store is deliberately an in-memory fake: what matters here is what crosses
    // the IPC and network boundary, and the real store's behaviour has its own tests.
    registerLocalVoiceIpc: registration => { localVoice.push(registration); return 'local-voice-ipc' },
    createComfyRouterKeyStore: () => {
      let saved = null
      return { canRemember: () => true, load: async () => saved, save: async key => { saved = key; return true }, forget: async () => { saved = null; return true } }
    },
    safeStorage: { isEncryptionAvailable: () => true },
    resultFetch: (url, request) => providerFetch(url, request),
    agentDispatchScope: { current: () => null },
    mobileCompanion: null,
  }
  vm.runInNewContext(`${wiring}\nthis.__routerIpc = comfyRouterIpc`, scope, { filename: `${archive}/electron/main.js#router-wiring` })
  // Both registrations live in the sliced region. 0.5.1 shipped with registerComfyRouterIpc's call
  // site gone: the app started, threw, and never showed a window. A use-based scan cannot see a
  // deleted call, so this checks the calls happen against this fixture's own ipcMain and window.
  assert.deepEqual(localVoice.map(item => item.getMainWindow()), [window],
    'the local voice IPC registration is still called from the Router wiring block')
  assert.equal(comfyRouterIpcCalls.length, 1, 'registerComfyRouterIpc is still called from the Router wiring block')
  assert.equal(comfyRouterIpcCalls[0].getMainWindow(), window)
  t.after(() => { scope.__routerIpc.dispose(); manager?.dispose() })
  return { bridge: bridge.comfyRouter, get manager() { return manager }, state, native, ipc, handlers, scope,
    userData, requests, dialogs, opens, ipcCalls, logs, actions, decodes, runtime,
    activate: value => { runtime.navigator.userActivation.isActive = value },
    foreignFrame: () => { from = { sender: contents, senderFrame: {} } },
    foreignSender: () => { from = { sender: Object.assign(new EventEmitter(), { isDestroyed: () => false }), senderFrame: contents.mainFrame } },
    restore: () => { from = authorized },
    advance: () => { state.time += 60000 },
    async connect() { this.activate(true); const result = await this.bridge.connect({ apiKey: KEY }); assert.equal(result.success, true, result.error); return result },
    async plan() { const result = await this.bridge.preview({ prompt: 'A synthetic paper city at sunrise.' }); assert.equal(result.success, true, result.error); return result.planId },
    async queued() { await this.connect(); this.state.approve = true; const result = await this.bridge.submit({ planId: await this.plan() }); assert.equal(result.success, true, result.error); return result.job.jobId },
  }
}

test('ASAR preload has only narrow Router operations, blocks non-gesture controls and rejects foreign senders', async t => {
  const f = await fixture(t)
  // The whole surface the renderer can reach, pinned. It grew past the 0.4 list when Create moved
  // through the Router (models, balance, previewCreate, previewCreateBatch, submitCreate), which is
  // how this test ended up red and unrun: the pin said twelve names, the preload carried seventeen.
  // Anything new here is a renderer-reachable operation, so it belongs in this list deliberately.
  assert.deepEqual(Object.keys(f.bridge).sort(), ['balance', 'cancel', 'clear', 'connect', 'list', 'markImported',
    'models', 'onChanged', 'openGuide', 'output', 'preview', 'previewCreate', 'previewCreateBatch', 'refresh',
    'status', 'submit', 'submitCreate'])
  for (const name of ['getKey', 'credential', 'inspectPlan', 'setPolicy']) assert.equal(f.bridge[name], undefined)
  assert.equal((await f.bridge.status({})).configured, false)
  assert.equal((await f.bridge.list({})).jobs.length, 0)
  assert.equal(f.requests.length, 0)
  const ipcCount = f.ipcCalls.length
  await assert.rejects(f.bridge.connect({ apiKey: KEY }), /gesture/)
  await assert.rejects(f.bridge.clear({}), /gesture/)
  await assert.rejects(f.bridge.openGuide(), /gesture/)
  assert.equal(f.ipcCalls.length, ipcCount)
  f.activate(true)
  for (const foreign of ['foreignFrame', 'foreignSender']) {
    f[foreign]()
    for (const run of [() => f.bridge.status({}), () => f.bridge.connect({ apiKey: KEY }), () => f.bridge.clear({}), () => f.bridge.openGuide(), () => f.bridge.submit({ planId: 'none' })]) {
      assert.equal((await run()).code, 'ROUTER_UNAUTHORIZED')
    }
  }
  f.restore(); assert.equal(f.requests.length, 0)
  assert.equal((await f.bridge.openGuide()).success, true)
  assert.deepEqual(f.opens, [f.ipc.GUIDE])
  assert.equal(f.requests.length, 0)
})

test('production main captures saved native context, keeps connection/preview GET-only and never returns the session key', async t => {
  const f = await fixture(t)
  f.state.projectKey = 'unsaved-relative'
  const missing = await f.bridge.preview({ prompt: 'A synthetic city' })
  assert.equal(missing.success, false); assert.equal(f.requests.length, 0)
  f.state.projectKey = path.join(f.userData, 'saved-project')
  const connected = await f.connect(), planId = await f.plan(), status = await f.bridge.status({})
  assert.equal(f.requests.length, 1)
  const request = f.requests[0]
  assert.equal(request.url, `https://api.comfy.org/v2/models/${f.native.MODEL}`)
  assert.equal(request.method, 'GET'); assert.equal(request.body, undefined)
  assert.equal(request.headers['X-API-Key'], KEY)
  assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error')
  assert.equal(request.cache, 'no-store'); assert.equal(request.bypassCustomProtocolHandlers, true)
  assert.ok(f.actions.length > 0); assert.ok(f.actions.every(action => action.action === 'get_transport_state'))
  assert.doesNotMatch(JSON.stringify([connected, status, planId, f.logs]), /synthetic-packaged-router-key|must-not-leak|X-API-Key/)
  assert.equal(f.logs.length, 0); assert.equal(f.dialogs.length, 0)
  assert.equal((await f.bridge.clear({})).success, true)
  assert.equal((await f.bridge.status({})).configured, false)
  assert.deepEqual(await fs.readdir(path.join(f.userData, 'comfy-router-jobs')), [])
})

test('actual native paid dialog shows finite estimate and cancel/unchecked approval never POST', async t => {
  const f = await fixture(t); await f.connect(); const planId = await f.plan()
  assert.equal((await f.bridge.submit({ planId })).success, false)
  assert.equal(f.dialogs.length, 1)
  const dialog = f.dialogs[0]
  assert.match(dialog.detail, /6\.33 credits \(US\$0\.03\)/)
  assert.doesNotMatch(dialog.detail, /NaN|undefined|synthetic-packaged-router-key/)
  assert.match(dialog.detail, /synthetic paper city/)
  assert.equal(dialog.defaultId, 0); assert.equal(dialog.cancelId, 0); assert.equal(dialog.checkboxChecked, false)
  f.state.approve = true; f.state.checkbox = false
  assert.equal((await f.bridge.submit({ planId })).success, false)
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0)
  f.state.policy = 'local-only'; f.state.checkbox = true
  assert.equal((await f.bridge.submit({ planId })).success, false)
  assert.equal(f.dialogs.length, 2, 'Local-only must not even offer the paid approval')
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0)
})

// Both of these describe upstream's image-import contract: every picture is decoded by nativeImage
// and must come back 1024x1024 before anything is written into the project (electron/comfyRouter.cjs
// at 76e1d62). Belrog's Router generates pictures, video, voice and sound at many sizes, so the
// hard 1024 check was dropped here and validateImage is passed to createComfyRouter but never
// called - the bytes are verified by parsing the PNG/JPEG/WebP headers instead. That is a real
// divergence from a paid path: a file with valid headers but undecodable pixels would be imported.
// Kept as todo rather than rewritten, because making these green by asserting the current behaviour
// would hide the question, which is whether Belrog wants a native decode check back.
test('approved production path makes one fixed-model POST, returns a durable job and decodes output with nativeImage',
  { todo: 'Belrog verifies result bytes by header parsing; the native 1024x1024 decode check was dropped in the 0.4 merge' },
  async t => {
  const f = await fixture(t); await f.connect(); f.state.approve = true
  const planId = await f.plan(), submitted = await f.bridge.submit({ planId })
  assert.equal(submitted.success, true, submitted.error)
  const jobId = submitted.job.jobId
  assert.equal((await f.bridge.submit({ planId })).job.jobId, jobId)
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1)
  const post = f.requests.find(request => request.method === 'POST')
  assert.equal(post.url, `https://api.comfy.org/v2/models/${f.native.MODEL}/requests`)
  assert.deepEqual(JSON.parse(post.body), { prompt: 'A synthetic paper city at sunrise.', size: '1024x1024',
    response_format: 'b64_json', sequential_image_generation: 'disabled', stream: false, watermark: true })
  assert.equal((await f.bridge.list({})).jobs.length, 1)
  const before = f.requests.length
  assert.equal((await f.bridge.output({ jobId })).success, false, 'Cannot import before completion')
  assert.equal(f.requests.length, before)
  f.advance(); assert.equal((await f.bridge.refresh({ jobId })).job.status, 'COMPLETED')
  const output = await f.bridge.output({ jobId })
  assert.equal(output.success, true, output.error); assert.equal(output.mimeType, 'image/png')
  assert.deepEqual(Buffer.from(output.bytes), PNG); assert.deepEqual(f.decodes, [PNG])
  assert.equal((await f.bridge.markImported({ jobId, assetId: 'synthetic-asset-one' })).job.importedAssetId, 'synthetic-asset-one')
  assert.ok(f.requests.every(request => request.url.startsWith('https://api.comfy.org/v2/models/')))
  assert.doesNotMatch(JSON.stringify([submitted, output, await f.bridge.list({}), f.logs]), /synthetic-packaged-router-key|X-API-Key|signed_url/)
  const ledger = await fs.readFile(path.join(f.userData, 'comfy-router-jobs', 'comfy-router-jobs.json'), 'utf8')
  assert.doesNotMatch(ledger, /synthetic-packaged-router-key|synthetic paper city|b64_json|https:/)
  assert.equal(f.logs.length, 0)
})

test('production nativeImage wiring refuses empty or wrong-size decoded images without changing the timeline',
  { todo: 'same as above: nothing in Belrog decodes the picture, so refusing an empty or wrong-size decode is not a path this build has' },
  async t => {
  const f = await fixture(t), jobId = await f.queued()
  f.advance(); await f.bridge.refresh({ jobId })
  f.state.emptyImage = true
  assert.equal((await f.bridge.output({ jobId })).success, false)
  f.state.emptyImage = false; f.state.width = 1; f.state.height = 1
  assert.equal((await f.bridge.output({ jobId })).success, false)
  f.state.width = 1024; f.state.height = 1024
  assert.equal((await f.bridge.output({ jobId })).success, true)
  assert.equal(f.decodes.length, 3)
  assert.ok(f.actions.every(action => action.action === 'get_transport_state'))
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1)
})

test('packaged bridge retains safe rejection diagnostics and never polls a support correlation ID', async t => {
  const diagnosticId = '1db3755e-b72e-429e-a310-c473d3bd1b57'
  const f = await fixture(t, { transport: async (_url, request) => request.method === 'POST'
    ? response({ detail: `${KEY} should never be shown` }, 403, { 'X-Comfy-Error-Type': 'not_enabled', 'X-Comfy-Request-Id': diagnosticId })
    : response({ id: 'synthetic-model' }) })
  await f.connect(); f.state.approve = true
  const result = await f.bridge.submit({ planId: await f.plan() })
  assert.equal(result.job.submissionRejected, true); assert.equal(result.job.canRefresh, false)
  assert.equal(result.job.diagnostics.requestId, diagnosticId); assert.match(result.error, /HTTP 403/)
  await f.bridge.clear({}); const before = f.requests.length
  const refreshed = await f.bridge.refresh({ jobId: result.job.jobId })
  assert.equal(refreshed.success, true); assert.equal(refreshed.cached, true); assert.equal(refreshed.job.needsReconnect, false)
  assert.deepEqual(refreshed.job.diagnostics, result.job.diagnostics)
  assert.equal(f.requests.length, before)
  assert.doesNotMatch(JSON.stringify([result, refreshed, f.logs]), /synthetic-packaged-router-key|should never be shown/)
  assert.ok(!f.requests.some(request => request.url.includes(diagnosticId)))
  f.foreignFrame(); assert.equal((await f.bridge.refresh({ jobId: result.job.jobId })).code, 'ROUTER_UNAUTHORIZED')
})
