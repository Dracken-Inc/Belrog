import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * Preload ↔ main channel contract.
 *
 * A channel that preload exposes but main never handles is invisible until a
 * user clicks the button: the promise rejects, the UI says nothing. That is how
 * Copy Brief died once, and the same shape appears any time a feature is grafted
 * onto a different base. So the pairing is checked mechanically instead of by
 * clicking through the app.
 */
const root = path.resolve(import.meta.dirname, '..')
const electronDir = path.join(root, 'electron')
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')

const preloadSources = ['electron/preload.js'].map(read)
// Handlers live in main.js and in the modules it installs (captionWhisper,
// remoteModelInstall, ...), so the whole electron/ tree counts.
const mainSources = readdirSync(electronDir)
    .filter((name) => /\.[mc]?js$/.test(name) && name !== 'preload.js')
  .map((name) => read(path.join('electron', name)))

function literals(sources, pattern) {
  const found = new Set()
  for (const source of sources) {
    for (const match of source.matchAll(pattern)) found.add(match[1])
  }
  return found
}

test('every channel the renderer invokes is handled by the main process', () => {
  const invoked = literals(preloadSources, /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)
  const handled = literals(mainSources, /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)

  assert.ok(invoked.size > 50, `expected the preload bridge to expose many channels, found ${invoked.size}`)
  const orphaned = [...invoked].filter((channel) => !handled.has(channel)).sort()
  assert.deepEqual(orphaned, [], `channels exposed with no handler: ${orphaned.join(', ')}`)
})

test('the clipboard channel is wired on both sides', () => {
  const preload = preloadSources.join('\n')
  const main = mainSources.join('\n')
  assert.match(preload, /writeClipboardText:\s*\(text\)\s*=>\s*ipcRenderer\.invoke\('belrog:writeClipboardText'/)
  assert.match(main, /ipcMain\.handle\('belrog:writeClipboardText'/)
  assert.match(main, /clipboard\.writeText\(text\)/)
})

test('director:run-pipeline is handled in main process', () => {
  const main = mainSources.join('\n')
  assert.match(main, /ipcMain\.handle\('director:run-pipeline'/)
})

test('director:run-pipeline is exposed via preload', () => {
  const preload = preloadSources.join('\n')
  assert.match(preload, /runMusicVideoPipeline:\s*\(options\)\s*=>\s*ipcRenderer\.invoke\('director:run-pipeline'/)
})
