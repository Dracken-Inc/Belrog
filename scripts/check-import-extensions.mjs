#!/usr/bin/env node
/**
 * Source scan: modules the Node test suite imports directly must use explicit
 * import extensions, so `node --test tests/*.test.mjs` imports them without a
 * loader shim.
 *
 * Why this list and not all of src/services: extensionless relative imports
 * are the repo-wide style (vite resolves them, bare Node does not), and
 * converting 200 files is far outside the 0.6.4 fix round. What IS in scope is
 * what the tests touch. comfyui.js sat untestable for a whole cycle because one
 * extensionless import made `import('./src/services/comfyui.js')` throw under
 * Node, so the fps laws could only be half-tested. Lock what we rely on; let
 * the list grow as more of the app becomes testable.
 *
 * Deliberately excluded: mcpActions.js / mcpSnapshot.js. They import renderer
 * stores at module top level, which is already banned for main-process code by
 * tests/timelineFpsInheritance.test.mjs; making them Node-importable is that
 * store-coupling fix, not an extension fix, and is not in this release.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const FILES = [
  'src/services/comfyui.js',
  'src/services/comfyPartnerAuth.js',
  'src/services/localComfyConnection.js',
  'src/services/shotRenderer.js',
  'src/services/musicVideoRender.js',
  'src/services/musicVideoPipeline.js',
  'src/services/audioAnalysis.js',
  'src/services/actionProse.mjs',
  'src/services/modelCatalog.js',
  'src/services/promptCompiler.js',
  'src/services/shotPlanValidator.js',
  'src/services/sunoIntake.js',
  'src/config/musicVideoShotConfig.js',
  'src/utils/comfyCredits.js',
]

const RE = /(?:^|[\s(])from\s+['"](\.[^'"]*?)['"]/g
const offenders = []
const missing = []

for (const rel of FILES) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) { missing.push(rel); continue }
  const text = readFileSync(abs, 'utf8')
  text.split('\n').forEach((line, i) => {
    const t = line.trimStart()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    let m
    RE.lastIndex = 0
    while ((m = RE.exec(line))) {
      const spec = m[1]
      if (/\.(js|mjs|cjs|json)$/.test(spec)) continue
      offenders.push(`${rel}:${i + 1}: ${spec}`)
    }
  })
}

if (missing.length) {
  console.error('FAIL: the import-extension guard lists files that no longer exist (update FILES or delete the moved module from the list):')
  for (const m of missing) console.error('  ' + m)
  process.exitCode = 1
}
if (offenders.length) {
  console.error('FAIL: extensionless relative imports in the Node-testable chain (vite hides these; `node --test` cannot import the module):')
  for (const o of offenders) console.error('  ' + o)
  process.exitCode = 1
}
if (!offenders.length && !missing.length) {
  console.log(`ok: ${FILES.length} modules the tests import use explicit extensions`)
}
