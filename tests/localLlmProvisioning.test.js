/**
 * Local LLM Provisioning Tests
 *
 * Node-only (node:test). Uses a fake HTTP server with Range support —
 * NO real network, NO GGUF downloads, NO calls to vLLM. Covers:
 *   - VRAM filtering
 *   - checksum reject (corrupted file never registered as installed)
 *   - resume correctness (interrupted download -> completed byte-exact)
 *   - buildRequestOptions shape (json_schema, every key required)
 *   - first-run chooseModel decision table
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, writeFile, readFile, unlink, stat, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'

// Point the local models dir at a temp HOME BEFORE importing the module.
const TEST_HOME = join(tmpdir(), 'belrog-llm-test-' + process.pid)
process.env.HOME = TEST_HOME
await mkdir(join(TEST_HOME, 'models', 'llm'), { recursive: true })

const { MODEL_PRESETS, getPresetsForVRAM, getDefaultPreset, chooseModel } =
  await import('../src/services/modelCatalog.js')
const { buildRequestOptions } = await import('../src/services/llamaSidecar.js')
const { downloadLocalModel, computeLocalSha256 } = await import('../electron/remoteModelInstall.js')

// ═══════════════════════════════════════════
// Fake HTTP server with Range support
// ═══════════════════════════════════════════

const GOOD_CONTENT = Buffer.alloc(4096)
for (let i = 0; i < GOOD_CONTENT.length; i++) GOOD_CONTENT[i] = (i * 31 + 7) & 0xff
const GOOD_SHA = createHash('sha256').update(GOOD_CONTENT).digest('hex')

// Content that is the right SIZE but wrong bytes -> checksum must reject it.
const CORRUPT_CONTENT = Buffer.alloc(4096)
for (let i = 0; i < CORRUPT_CONTENT.length; i++) CORRUPT_CONTENT[i] = (i * 17 + 3) & 0xff

let server = null
let baseUrl = ''

function startServer() {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const route = req.url.split('?')[0]
      if (route === '/good.gguf' || route === '/corrupt.gguf') {
        const data = route === '/good.gguf' ? GOOD_CONTENT : CORRUPT_CONTENT
        const range = req.headers.range
        if (range) {
          const m = range.match(/bytes=(\d+)-(\d*)/)
          const start = +m[1]
          const end = m[2] ? +m[2] : data.length - 1
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${data.length}`,
            'Content-Length': end - start + 1,
            'Accept-Ranges': 'bytes',
          })
          res.end(data.slice(start, end + 1))
        } else {
          res.writeHead(200, { 'Content-Length': data.length, 'Accept-Ranges': 'bytes' })
          res.end(data)
        }
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
}

const finalPath = (fn) => join(TEST_HOME, 'models', 'llm', fn)
const partPath = (fn) => finalPath(fn) + '.part'

async function exists(p) {
  try { await stat(p); return true } catch { return false }
}

// ═══════════════════════════════════════════
// VRAM Filtering
// ═══════════════════════════════════════════

describe('VRAM filtering', () => {
  test('three presets with exact spec metadata', () => {
    assert.equal(MODEL_PRESETS.length, 3)
    const m = MODEL_PRESETS.find(p => p.id === 'mistral-7b-instruct-v0.3.Q4_K_M')
    assert.equal(m.sizeBytes, 4372812000)
    assert.equal(m.vramGB, 5.4)
    assert.equal(m.sha256, '1270d22c0fbb3d092fb725d4d96c457b7b687a5f5a715abe1e818da303e562b6')
    assert.equal(m.repo, 'lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF')
    assert.equal(m.filename, 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf')
    const l = MODEL_PRESETS.find(p => p.id === 'meta-llama-3.1-8b-instruct.Q4_K_M')
    assert.equal(l.sizeBytes, 4920739168)
    assert.equal(l.vramGB, 6.0)
    assert.equal(l.sha256, 'f2be3e1a239c12c9f3f01a962b11fb2807f8032fdb63b0a5502ea42ddef55e44')
    assert.equal(l.repo, 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF')
    const n = MODEL_PRESETS.find(p => p.id === 'mistral-nemo-instruct-2407.Q2_K')
    assert.equal(n.sizeBytes, 4791047712)
    assert.equal(n.vramGB, 6.0)
    assert.equal(n.sha256, 'e2631c7397d90d3a5338f25d204e704f4acb65211fa225a0e48257e4c24cfc6e')
    assert.equal(n.repo, 'unsloth/Mistral-Nemo-Instruct-2407-GGUF')
    assert.equal(n.sha256SingleSourced, true, 'Nemo hash must be flagged single-sourced')
  })

  test('8 GB VRAM -> all three fit (envelope 4-6 GB)', () => {
    assert.equal(getPresetsForVRAM(8).length, 3)
  })

  test('7 GB VRAM -> only Mistral-7B fits (5.4 <= 5.95, 6.0 > 5.95)', () => {
    const fit = getPresetsForVRAM(7)
    assert.equal(fit.length, 1)
    assert.equal(fit[0].id, 'mistral-7b-instruct-v0.3.Q4_K_M')
  })

  test('5 GB VRAM -> nothing fits', () => {
    assert.equal(getPresetsForVRAM(5).length, 0)
  })

  test('null VRAM (detection failed) -> offer nothing, do not guess', () => {
    assert.equal(getPresetsForVRAM(null).length, 0)
  })

  test('default pick is Mistral-7B Q4_K_M when it fits', () => {
    assert.equal(getDefaultPreset(8).id, 'mistral-7b-instruct-v0.3.Q4_K_M')
  })

  test('default pick null when nothing fits', () => {
    assert.equal(getDefaultPreset(5), null)
  })
})

// ═══════════════════════════════════════════
// Checksum reject + resume (fake server)
// ═══════════════════════════════════════════

describe('Verified download', () => {
  before(startServer)
  after(async () => { await new Promise(r => server.close(r)); await rm(TEST_HOME, { recursive: true, force: true }) })

  test('a deliberately corrupted file is rejected and NOT registered as installed', async () => {
    const res = await downloadLocalModel({
      url: `${baseUrl}/corrupt.gguf`,
      filename: 'corrupt.gguf',
      expectedSha256: GOOD_SHA, // wrong for the served bytes
      expectedSize: CORRUPT_CONTENT.length,
      onProgress: () => {},
      onStageChange: () => {},
    })
    assert.equal(res.ok, false, 'must report failure')
    assert.match(res.error, /sha256 mismatch/i)
    // Neither the final file nor the temp file may remain -> it can never load.
    assert.equal(await exists(finalPath('corrupt.gguf')), false, 'installed path must not exist')
    assert.equal(await exists(partPath('corrupt.gguf')), false, 'temp path must be cleaned up')
  })

  test('a correct download is verified, registered, and returns its hash', async () => {
    const res = await downloadLocalModel({
      url: `${baseUrl}/good.gguf`,
      filename: 'good.gguf',
      expectedSha256: GOOD_SHA,
      expectedSize: GOOD_CONTENT.length,
      onProgress: () => {},
      onStageChange: () => {},
    })
    assert.equal(res.ok, true)
    assert.equal(res.hash.toLowerCase(), GOOD_SHA)
    assert.equal(res.size, GOOD_CONTENT.length)
    const bytes = await readFile(finalPath('good.gguf'))
    assert.ok(bytes.equals(GOOD_CONTENT), 'installed bytes must match source exactly')
    assert.equal(await exists(partPath('good.gguf')), false, 'temp file renamed away')
  })

  test('interrupted download resumes and produces a byte-exact file', async () => {
    // Simulate an interruption: a half-written .part file already on disk.
    await writeFile(partPath('resume2.gguf'), GOOD_CONTENT.slice(0, 2000))
    let sawResumeAbovePartial = false
    const res = await downloadLocalModel({
      url: `${baseUrl}/good.gguf`,
      filename: 'resume2.gguf',
      expectedSha256: GOOD_SHA,
      expectedSize: GOOD_CONTENT.length,
      onProgress: (done) => { if (done >= 2000) sawResumeAbovePartial = true },
      onStageChange: () => {},
    })
    assert.equal(res.ok, true, `resume must complete: ${res.error}`)
    const bytes = await readFile(finalPath('resume2.gguf'))
    assert.ok(bytes.equals(GOOD_CONTENT), 'resumed file must be byte-exact')
    assert.ok(sawResumeAbovePartial, 'progress must report bytes beyond the pre-seeded partial')
  })

  test('already-installed verified file is treated as cached (no re-download)', async () => {
    // good.gguf was installed & verified in the earlier test.
    const res = await downloadLocalModel({
      url: `${baseUrl}/good.gguf`,
      filename: 'good.gguf',
      expectedSha256: GOOD_SHA,
      expectedSize: GOOD_CONTENT.length,
      onProgress: () => {},
      onStageChange: () => {},
    })
    assert.equal(res.ok, true)
    assert.equal(res.cached, true)
  })
})

// ═══════════════════════════════════════════
// buildRequestOptions shape
// ═══════════════════════════════════════════

describe('buildRequestOptions', () => {
  test('uses json_schema (never json_object) with strict:true', () => {
    const opts = buildRequestOptions({ type: 'object', properties: { a: { type: 'string' } } })
    assert.equal(opts.response_format.type, 'json_schema')
    assert.notEqual(opts.response_format.type, 'json_object')
    assert.equal(opts.response_format.json_schema.strict, true)
    assert.equal(opts.response_format.json_schema.name, 'shot_plan')
  })

  test('every top-level key becomes required, additionalProperties false', () => {
    const opts = buildRequestOptions({
      type: 'object',
      properties: { shots: { type: 'array', items: { type: 'string' } }, title: { type: 'string' } },
    })
    const s = opts.response_format.json_schema.schema
    assert.deepEqual(s.required.sort(), ['shots', 'title'])
    assert.equal(s.additionalProperties, false)
  })

  test('recurses into nested objects (shot items) to require all their keys', () => {
    const opts = buildRequestOptions({
      type: 'object',
      properties: {
        shots: {
          type: 'array',
          items: { type: 'object', properties: { start: { type: 'number' }, prompt: { type: 'string' } } },
        },
      },
    })
    const item = opts.response_format.json_schema.schema.properties.shots.items
    assert.deepEqual(item.required.sort(), ['prompt', 'start'])
    assert.equal(item.additionalProperties, false)
  })
})

// ═══════════════════════════════════════════
// chooseModel decision table
// ═══════════════════════════════════════════

describe('chooseModel decision table', () => {
  const presets = MODEL_PRESETS
  const modelsDir = '/fake/models'

  test('has local GGUF -> use-existing', () => {
    const r = chooseModel({ hasLocalGguf: true, modelsDir, presets, vramGb: 8 })
    assert.equal(r.action, 'use-existing')
  })

  test('no GGUF, VRAM fits all -> pick-model, Mistral preselected', () => {
    const r = chooseModel({ hasLocalGguf: false, modelsDir, presets, vramGb: 8 })
    assert.equal(r.action, 'pick-model')
    assert.equal(r.preset.id, 'mistral-7b-instruct-v0.3.Q4_K_M')
    assert.equal(r.presets.length, 3)
  })

  test('no GGUF, tight VRAM -> only fitting preset offered', () => {
    const r = chooseModel({ hasLocalGguf: false, modelsDir, presets, vramGb: 7 })
    assert.equal(r.action, 'pick-model')
    assert.equal(r.presets.length, 1)
    assert.equal(r.preset.id, 'mistral-7b-instruct-v0.3.Q4_K_M')
  })

  test('no GGUF, VRAM too small for any -> still pick-model with a warning (never dead-end)', () => {
    const r = chooseModel({ hasLocalGguf: false, modelsDir, presets, vramGb: 5 })
    assert.equal(r.action, 'pick-model')
    assert.ok(r.warning, 'must warn VRAM may be insufficient')
    assert.ok(r.presets.length > 0, 'must still show options to fall through to')
  })

  test('VRAM unknown -> pick-model with Mistral preselected, all presets shown', () => {
    const r = chooseModel({ hasLocalGguf: false, modelsDir, presets, vramGb: null })
    assert.equal(r.action, 'pick-model')
    assert.equal(r.preset.id, 'mistral-7b-instruct-v0.3.Q4_K_M')
    assert.equal(r.presets.length, 3)
  })
})