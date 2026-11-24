import test from 'node:test'
import assert from 'node:assert/strict'
import { copyText, isFocusClipboardError } from './clipboard.mjs'

const okNav = { clipboard: { writeText: async () => {} } }
const focusDeniedNav = { clipboard: { writeText: async () => { throw new Error('Document is not focused.') } } }

test('the main process gets the text, not the web API', async () => {
  const written = []
  const navCalls = { count: 0 }
  const nav = { clipboard: { writeText: async () => { navCalls.count += 1 } } }
  const api = { writeClipboardText: async (text) => { written.push(text); return { ok: true } } }

  const result = await copyText('BELROG DIRECTOR SCRIPT', { api, nav })

  assert.deepEqual(written, ['BELROG DIRECTOR SCRIPT'])
  assert.equal(navCalls.count, 0, 'the focus-sensitive path must not run when the main process is available')
  assert.equal(result.ok, true)
  assert.equal(result.via, 'main')
})

test('falls back to the web API in a plain browser', async () => {
  const written = []
  const result = await copyText('hello', { api: undefined, nav: { clipboard: { writeText: async (t) => { written.push(t) } } } })
  assert.deepEqual(written, ['hello'])
  assert.equal(result.via, 'web')
})

test('a focus rejection is reported, not thrown, and is recognisable', async () => {
  const api = { writeClipboardText: async () => { throw new Error('no such channel') } }
  const result = await copyText('hello', { api, nav: focusDeniedNav })

  assert.equal(result.ok, false, 'a failed copy must come back as a result, not an unhandled rejection')
  assert.match(result.error, /not focused/i)
  assert.equal(isFocusClipboardError(result.error), true)
})

test('the main-process write is what lands when both paths work', async () => {
  const inMain = []
  const inWeb = []
  const api = { writeClipboardText: async (t) => { inMain.push(t); return { ok: true, length: t.length } } }
  const nav = { clipboard: { writeText: async (t) => { inWeb.push(t) } } }

  await copyText('only one of these should run', { api, nav })

  assert.equal(inMain.length, 1)
  assert.equal(inWeb.length, 0)
})

test('nothing to copy is an honest failure', async () => {
  const result = await copyText('', { api: { writeClipboardText: async () => ({ ok: true }) }, nav: okNav })
  assert.equal(result.ok, false)
  assert.match(result.error, /Nothing to copy/)
})

test('an empty clipboard result from main falls back instead of claiming success', async () => {
  const result = await copyText('text', {
    api: { writeClipboardText: async () => ({ ok: false, error: 'refused' }) },
    nav: okNav,
  })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'web')
})
