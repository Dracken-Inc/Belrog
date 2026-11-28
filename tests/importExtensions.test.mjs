#!/usr/bin/env node
/**
 * Import-extension guard (see scripts/check-import-extensions.mjs for the why).
 * Kept as a .test.mjs so `node --test tests/*.test.mjs` runs it with the rest
 * of the suite instead of relying on someone remembering a separate script.
 */
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the modules the tests import are loadable by bare Node', () => {
  let out = ''
  let failed = false
  try {
    out = execFileSync(process.execPath, ['scripts/check-import-extensions.mjs'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    failed = true
    out = String(e.stdout || '') + String(e.stderr || '')
  }
  assert.ok(!failed, out.trim())
})
