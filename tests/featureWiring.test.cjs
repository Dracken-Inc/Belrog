const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { auditRepo, CRITICAL_FEATURES } = require('../scripts/feature-wiring-audit.cjs')

const root = path.resolve(__dirname, '..')
const result = auditRepo(root)

// The 0.4.1 merge proved that a feature can be deleted by a container file that
// "took the other side" while every unit test stays green. These tests are the
// tripwire: they fail on the day the wiring breaks, not three releases later.

test('every critical feature is mounted in its container', () => {
  assert.deepEqual(result.missingMounts, [], `unmounted features:\n${result.missingMounts
    .map((m) => `  ${m.name} -> ${m.file}: ${m.reason}`)
    .join('\n')}`)
})

test('no production module is unreachable except the documented allowlist', () => {
  assert.deepEqual(result.unreachable, [], `unreachable modules:\n${result.unreachable
    .map((u) => `  ${u.file}${u.tested ? ' (imported only by its own test)' : ''}`)
    .join('\n')}`)
})

test('the audit itself cannot be silently emptied', () => {
  // Someone "fixes" a red gate by deleting its entries. The features that the merge
  // lost are the floor; dropping below it fails here with an explanation.
  assert.ok(CRITICAL_FEATURES.length >= 10, 'critical feature list shrank below the post-merge floor')
  for (const feature of CRITICAL_FEATURES) {
    assert.ok(feature.name && feature.file && feature.mount instanceof RegExp && feature.why, `malformed entry: ${JSON.stringify(feature)}`)
    assert.ok(feature.mount.source, `entry ${feature.name} has an unusable mount pattern`)
  }
})

test('an unmounted feature is reported as unmounted, not missing', () => {
  const view = auditRepo(root)
  const seeded = view.missingMounts.find((m) => m.name === 'clip speed gesture')
  if (seeded) assert.match(seeded.reason, /mount point is gone/)
  else assert.ok(true, 'clip speed gesture is currently mounted; nothing to check')
})

// Features that live INSIDE a container file leave no import-graph trace, so the
// unreachability audit cannot see them. When upstream replaces App.jsx wholesale they
// vanish while every other gate stays green. These read the containers themselves.
const fs = require('node:fs')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const inFileFeatures = [
  {
    name: 'Director Script (LTX planner) tab',
    file: 'src/App.jsx',
    must: ['belrog-director-script', 'director-script-request-brief', "mainTab === 'director-script'"],
    why: 'the tab, its iframe and its brief handshake are all in-file; a container swap deletes them',
  },
  {
    name: 'Director Script tab button',
    file: 'src/components/TitleBar.jsx',
    must: ["id: 'director-script'"],
    why: 'the tab renders but is unreachable without its title-bar entry',
  },
  {
    name: 'Remote ComfyUI over SSH',
    file: 'electron/main.js',
    must: ["require('./sshTunnelManager')", "'belrog:connect'", "'belrog:disconnect'", "'belrog:getTunnelStatus'"],
    why: 'the tunnel is the only path to a ComfyUI on another machine',
  },
  {
    name: 'Remote server settings section',
    file: 'src/components/SettingsModal.jsx',
    must: ["case 'remote-server'", "'belrog:saveRemoteServerSettings'"],
    why: 'the tunnel has no host or key fields without this section',
  },
]

for (const feature of inFileFeatures) {
  test(`in-file feature survives container edits: ${feature.name}`, () => {
    const text = read(feature.file)
    const missing = feature.must.filter((needle) => !text.includes(needle))
    assert.deepEqual(missing, [], `${feature.file} lost ${feature.name}: ${feature.why}\nmissing: ${missing.join(', ')}`)
  })
}
