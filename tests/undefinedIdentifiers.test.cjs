/*
 * Guards scripts/check-undefined-identifiers.cjs.
 *
 * The incident this exists for: commit 045b8b6 ("take GPU sharing out of Belrog end to end")
 * deleted a region of electron/main.js that happened to also contain the declarations of
 * `savedWorkflowLibrary`, `workflowAssetInputs`, `generationMemoryCleanup` and `comfyRouterIpc`.
 * Later lines still call all four. `node --check` passed because nothing is a syntax error,
 * the release build went green because nothing imports them at module load, and every Windows
 * user got an app whose process ran, threw ReferenceError inside getGenerationRuns, never
 * caught it and never showed its window. Only running the app caught it - so the cheap half of
 * the catch happens here instead.
 *
 * Both directions are tested on purpose. A checker that only ever fails proves nothing, and a
 * checker with false positives gets switched off within a week, so the "valid syntax must
 * pass" case is what keeps this trusted.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const CHECKER = path.join(ROOT, 'scripts', 'check-undefined-identifiers.cjs')

function run(...args) {
  return spawnSync(process.execPath, [CHECKER, ...args], { cwd: ROOT, encoding: 'utf8' })
}

function fixture(dir, name, source) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, source)
  return file
}

test('electron/ declares every name it calls', () => {
  const res = run(path.join(ROOT, 'electron'))
  // The failure text names the file and line, so keep it in the assertion message.
  assert.equal(res.status, 0, `checker said:\n${res.stdout}${res.stderr}`)
})

test('a declaration deleted from a file that still calls it is reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belrog-uid-broken-'))
  try {
    // Same shape as the real mistake: the factory call sat in the deleted block, and the use
    // sites are elsewhere in the file, including inside a function that only runs at startup.
    fixture(dir, 'broken.cjs', `'use strict'
const { app } = require('electron')
const { createSavedWorkflowLibrary } = require('./savedWorkflowLibrary.cjs')
function getGenerationRuns() {
  return savedWorkflowLibrary.list()
}
app.on('ready', async () => {
  await savedWorkflowLibrary.prepare({ id: 'x' })
})
`)
    const res = run(path.join(dir, 'broken.cjs'))
    assert.equal(res.status, 1, 'a call to a name this file never defined must fail the check')
    assert.match(res.stderr, /savedWorkflowLibrary/)
    assert.match(res.stderr, /broken\.cjs:5/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the same file with the declaration present passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belrog-uid-clean-'))
  try {
    fixture(dir, 'clean.cjs', `'use strict'
const { app } = require('electron')
const { createSavedWorkflowLibrary } = require('./savedWorkflowLibrary.cjs')
const savedWorkflowLibrary = createSavedWorkflowLibrary({ getUserData: () => '/tmp' })
function getGenerationRuns() {
  return savedWorkflowLibrary.list()
}
app.on('ready', async () => {
  await savedWorkflowLibrary.prepare({ id: 'x' })
})
`)
    const res = run(path.join(dir, 'clean.cjs'))
    assert.equal(res.status, 0, `valid code must not be reported:\n${res.stdout}${res.stderr}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the syntax the checker must not mistake for a missing name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belrog-uid-syntax-'))
  try {
    // Each line below is a real shape from this repo that a naive scanner reports as an
    // undefined name. If one of these starts failing, the scanner regressed - do not delete
    // the case to get green.
    fixture(dir, 'shapes.cjs', `'use strict'
const fs = require('node:fs')
const electron = require('electron')
const path = require('node:path')

// Nested template literals: a flag-based scanner pairs the wrong backticks and blanks the
// rest of the file, which makes every later name look missing.
const label = \`a\${\`b\${path.sep}c\`}d\`

// Factory parameter list containing a default with parens.
function registerThing({ ipcMain, getMainWindow, getAssets = async () => [], store }) {
  return { ipcMain, getMainWindow, getAssets, store }
}

// Regex literals: /\${...}/ and /x|y/ must not report $ or x.
const BRACED = /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g
const kind = 'run_nvidia'.replace(/run_(nvidia|cpu)|run.*gpu/i, 'gpu')

// Object and class methods, one per line - the second method in a body has no { or , before it.
const obj = Object.assign({ name: 'x' }, {
  first() { return fs.existsSync(this.name) },
  second() { return path.basename(this.name) },
})
class Registry {
  constructor() { this.items = new Map() }
  add(item) { this.items.set(item.id, item) }
  get(id) { return this.items.get(id) }
}

// Destructured requires, renamed imports, catch binding, arrow with a bare parameter.
const { readSettingsRaw, writeSettingsRaw: writeSettings } = require('./settings.cjs')
const ids = [1, 2].map(item => item * 2)
const multi = [1, 2].reduce((total, item) => total + item, 0)
try { electron.app.whenReady() } catch (err) { console.warn(err) }
let count = 0, total = 0

// Method call chains and optional chaining roots: the root is the declared object.
const n = fs?.promises?.stat(label).then(() => obj.first())
for (const [key, value] of obj.items ?? new Map()) { count += value ?? 0 }
async function later() {
  const { dynamic } = await import('./other.cjs')
  return dynamic(writeSettings, readSettingsRaw, ids, multi, total, registerThing, Registry, err)
}
`)
    fixture(dir, 'unused-ok.cjs', `const a = 1\nconsole.log(a)\n`)
    const res = run(path.join(dir, 'shapes.cjs'), path.join(dir, 'unused-ok.cjs'))
    assert.equal(res.status, 0, `valid syntax must not be reported:\n${res.stdout}${res.stderr}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an undefined name in one file is reported with its path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belrog-uid-path-'))
  try {
    const file = fixture(dir, 'one.cjs', `const defined = () => 1\nmissingThing.go()\n`)
    const res = run(file)
    assert.equal(res.status, 1)
    assert.match(res.stderr, /missingThing/)
    assert.match(res.stderr, /one\.cjs:2/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
