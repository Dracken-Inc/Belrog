#!/usr/bin/env node
/**
 * Runs the unit tests that live next to the source they cover (src/**, electron/**).
 *
 * Why this exists as a script: those files were not named in any npm script, so
 * they ran for nobody — not local `npm test`, not the release workflow. A shell
 * glob would not fix it either: npm runs scripts with sh, and sh does not expand
 * `**` recursively, so a `src` glob with two of them silently means "one
 * directory deep". Enumerating here is the only portable version of this.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.vite', 'coverage'])
const TEST_RE = /\.test\.(mjs|cjs|js)$/

function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(full, out)
    } else if (TEST_RE.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const roots = ['src', 'electron'].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d))
const files = [...new Set(roots.flatMap((root) => collect(root, [])))].sort()

if (files.length === 0) {
  console.error('co-located test runner: found no test files under src/ or electron/. That is not expected — failing loudly.')
  process.exit(1)
}

// Batches keep any single crash from hiding the rest and stay under the argv cap.
const BATCH = 40
let failed = 0
for (let i = 0; i < files.length; i += BATCH) {
  const batch = files.slice(i, i + BATCH)
  console.log(`\n=== co-located tests ${i + 1}-${i + batch.length} of ${files.length} ===`)
  const res = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...batch], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (res.status !== 0) failed = 1
}

console.log(`\nco-located tests: ${files.length} files, exit ${failed}`)
process.exit(failed)
