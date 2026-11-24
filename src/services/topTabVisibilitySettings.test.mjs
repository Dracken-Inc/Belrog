// GPU sharing was removed from Belrog (it was Velorn's online service). These
// tests keep it removed: nobody may offer the tab again, and a machine that
// stored "gpu-sharing" in hiddenTopTabs before the removal must heal itself
// instead of keeping a phantom entry that hides nothing.
import test from 'node:test'
import assert from 'node:assert/strict'

const store = new Map()
globalThis.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: key => store.delete(key),
}

class FakeWindow extends EventTarget {
  constructor(electronAPI) { super(); this.electronAPI = electronAPI; this.saved = [] }
  dispatchEvent(event) { return super.dispatchEvent(event) }
}

function freshWindow(electronAPI) {
  store.clear()
  globalThis.window = new FakeWindow(electronAPI)
}

const { HIDEABLE_TOP_TABS, getHiddenTopTabs, hydrateHiddenTopTabs, setTopTabShown } =
  await import('./topTabVisibilitySettings.mjs')

test('the hidden-tab settings offer no GPU sharing option', () => {
  assert.deepEqual(HIDEABLE_TOP_TABS.map(tab => tab.id), ['create', 'sound', 'stock', 'comfyui'])
  assert.ok(!HIDEABLE_TOP_TABS.some(tab => /gpu|network|shar/i.test(tab.id + tab.label)))
})

test('a stored "gpu-sharing" id heals itself and the rest of the choice survives', () => {
  store.set('velorn-hidden-top-tabs', JSON.stringify(['gpu-sharing', 'sound']))
  assert.deepEqual(getHiddenTopTabs(), ['sound'])
  freshWindow({ getSetting: async () => ['gpu-sharing', 'stock'], setSetting: async () => {} })
  assert.deepEqual(getHiddenTopTabs(), [])
})

test('hydrating from saved preferences drops the removed tab before it reaches the tab bar', async () => {
  const saved = []
  freshWindow({ getSetting: async () => ['gpu-sharing', 'comfyui'], setSetting: (k, v) => saved.push([k, v]) })
  assert.deepEqual(await hydrateHiddenTopTabs(), ['comfyui'])
  assert.deepEqual(JSON.parse(store.get('velorn-hidden-top-tabs')), ['comfyui'])
  assert.deepEqual(saved, [])
})

test('hiding or showing a removed tab cannot be written to preferences', async () => {
  freshWindow({ getSetting: async () => null, setSetting: async () => {} })
  assert.deepEqual(await setTopTabShown('gpu-sharing', false), [])
  assert.equal(store.has('velorn-hidden-top-tabs'), false)
})

test('hiding a real tab still works and tells the tab bar', async () => {
  const saved = []
  freshWindow({ getSetting: async () => null, setSetting: async (key, value) => saved.push([key, value]) })
  const seen = []
  globalThis.window.addEventListener('velorn-hidden-top-tabs-changed', e => seen.push(e.detail.hidden))
  assert.deepEqual(await setTopTabShown('sound', false), ['sound'])
  assert.deepEqual(await setTopTabShown('sound', true), [])
  assert.deepEqual(seen, [['sound'], []])
  assert.deepEqual(saved, [['hiddenTopTabs', ['sound']], ['hiddenTopTabs', []]])
  assert.deepEqual(getHiddenTopTabs(), [])
})
