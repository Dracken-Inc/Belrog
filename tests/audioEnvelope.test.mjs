import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { analyzeEnvelopeFFmpeg } from '../src/services/audioAnalysis.js'

const testDir = resolve('tests', '.tmp-envelope')

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpegStatic = require('ffmpeg-static')
    const ffmpegPath = ffmpegStatic.default?.path || ffmpegStatic.path
    if (!ffmpegPath) return reject(new Error('ffmpeg not available'))
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d })
    proc.on('close', code => {
      if (code !== 0) reject(new Error(stderr || `ffmpeg exited ${code}`))
      else resolve()
    })
    proc.on('error', reject)
  })
}

/**
 * Build a WAV with a sine tone at `freq` Hz, `durationSec` seconds,
 * with optional amplitude envelope (piecewise linear over time).
 * Returns the file path.
 */
async function buildWav(path, { durationSec, freq = 440, envelope = [{ t: 0, a: 1 }] }) {
  // envelope: [{ t: timeInSec, a: amplitude 0..1 }] — linear interpolated
  const sampleRate = 44100
  const samples = Math.round(durationSec * sampleRate)
  const buffer = Buffer.alloc(44 + samples * 2)
  let pos = 0

  // RIFF header
  buffer.write('RIFF', pos); pos += 4
  buffer.writeUInt32LE(36 + samples * 2, pos); pos += 4
  buffer.write('WAVE', pos); pos += 4
  buffer.write('fmt ', pos); pos += 4
  buffer.writeUInt32LE(16, pos); pos += 4
  buffer.writeUInt16LE(1, pos); pos += 2   // PCM
  buffer.writeUInt16LE(1, pos); pos += 2   // mono
  buffer.writeUInt32LE(sampleRate, pos); pos += 4
  buffer.writeUInt32LE(sampleRate * 2, pos); pos += 4
  buffer.writeUInt16LE(2, pos); pos += 2   // block align
  buffer.writeUInt16LE(16, pos); pos += 2  // bits per sample
  buffer.write('data', pos); pos += 4
  buffer.writeUInt32LE(samples * 2, pos); pos += 4

  // Generate samples
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate
    // Interpolate envelope
    let amp = envelope[0].a
    for (let e = 1; e < envelope.length; e++) {
      if (t <= envelope[e].t) {
        const t0 = envelope[e - 1].t
        const t1 = envelope[e].t
        const a0 = envelope[e - 1].a
        const a1 = envelope[e].a
        amp = a0 + (a1 - a0) * (t - t0) / (t1 - t0)
        break
      }
      amp = envelope[e].a
    }
    const sample = Math.sin(2 * Math.PI * freq * t) * amp
    const s16 = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)))
    buffer.writeInt16LE(s16, pos)
    pos += 2
  }

  writeFileSync(path, buffer)
  return path
}

describe('analyzeEnvelopeFFmpeg', () => {
  before(() => {
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })
  })

  after(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  it('detects loudness boundaries within 1s for 60s test signal with rises at 10s and 30s', async () => {
    const file1 = resolve(testDir, 'test1_60s.wav')
    // 60s: quiet (0.01) until 10s, loud (1.0) 10-30s, quiet 30-60s
    await buildWav(file1, {
      durationSec: 60,
      freq: 440,
      envelope: [
        { t: 0, a: 0.01 },
        { t: 9.9, a: 0.01 },
        { t: 10.1, a: 1.0 },
        { t: 29.9, a: 1.0 },
        { t: 30.1, a: 0.01 },
        { t: 60, a: 0.01 },
      ],
    })

    const result = await analyzeEnvelopeFFmpeg({ absolutePath: file1 })

    assert.ok(result.durationSec > 59 && result.durationSec < 61, `duration ~60s, got ${result.durationSec}`)
    assert.ok(result.sampleRate === 8000, `sampleRate 8000, got ${result.sampleRate}`)
    assert.ok(Array.isArray(result.loudnessCurve) && result.loudnessCurve.length > 0, 'loudnessCurve present')
    assert.ok(Array.isArray(result.onsets) && result.onsets.length >= 2, `onsets >=2, got ${result.onsets.length}: ${result.onsets}`)
    assert.ok(Array.isArray(result.sections) && result.sections.length >= 2, `sections >=2, got ${result.sections.length}`)

    // Boundaries should be within 1s of 10s and 30s
    const boundaries = result.sections.map(s => s.startSec).filter(s => s > 0)
    const expectedBoundaries = [10, 30]
    for (const exp of expectedBoundaries) {
      const found = boundaries.some(b => Math.abs(b - exp) <= 1)
      assert.ok(found, `Expected boundary near ${exp}s in ${boundaries}`)
    }
  })

  it('detects loudness boundaries within 1s for 45s test signal with rises at 5s and 25s', async () => {
    const file2 = resolve(testDir, 'test2_45s.wav')
    // 45s: quiet until 5s, loud 5-25s, quiet 25-45s
    await buildWav(file2, {
      durationSec: 45,
      freq: 440,
      envelope: [
        { t: 0, a: 0.01 },
        { t: 4.9, a: 0.01 },
        { t: 5.1, a: 1.0 },
        { t: 24.9, a: 1.0 },
        { t: 25.1, a: 0.01 },
        { t: 45, a: 0.01 },
      ],
    })

    const result = await analyzeEnvelopeFFmpeg({ absolutePath: file2 })

    assert.ok(result.durationSec > 44 && result.durationSec < 46, `duration ~45s, got ${result.durationSec}`)
    assert.ok(Array.isArray(result.onsets) && result.onsets.length >= 2, `onsets >=2, got ${result.onsets.length}: ${result.onsets}`)

    const boundaries = result.sections.map(s => s.startSec).filter(s => s > 0)
    const expectedBoundaries = [5, 25]
    for (const exp of expectedBoundaries) {
      const found = boundaries.some(b => Math.abs(b - exp) <= 1)
      assert.ok(found, `Expected boundary near ${exp}s in ${boundaries}`)
    }
  })

  it('returns different results for different input files', async () => {
    const file1 = resolve(testDir, 'diff1.wav')
    const file2 = resolve(testDir, 'diff2.wav')
    // File 1: rise at 2s, fall at 6s
    await buildWav(file1, { durationSec: 10, freq: 440, envelope: [
      { t: 0, a: 0.01 }, { t: 1.9, a: 0.01 }, { t: 2.1, a: 1.0 },
      { t: 5.9, a: 1.0 }, { t: 6.1, a: 0.01 }, { t: 10, a: 0.01 }
    ] })
    // File 2: rise at 4s, fall at 8s
    await buildWav(file2, { durationSec: 10, freq: 440, envelope: [
      { t: 0, a: 0.01 }, { t: 3.9, a: 0.01 }, { t: 4.1, a: 1.0 },
      { t: 7.9, a: 1.0 }, { t: 8.1, a: 0.01 }, { t: 10, a: 0.01 }
    ] })

    const r1 = await analyzeEnvelopeFFmpeg({ absolutePath: file1 })
    const r2 = await analyzeEnvelopeFFmpeg({ absolutePath: file2 })

    // Different envelope timing should produce different onsets/sections
    assert.notStrictEqual(JSON.stringify(r1.onsets), JSON.stringify(r2.onsets), 'onsets should differ for different signals')
    assert.notStrictEqual(JSON.stringify(r1.sections), JSON.stringify(r2.sections), 'sections should differ for different signals')
  })

  it('caches results per file+mtime', async () => {
    const file = resolve(testDir, 'cache_test.wav')
    await buildWav(file, { durationSec: 5, freq: 440, envelope: [{ t: 0, a: 1 }] })

    const r1 = await analyzeEnvelopeFFmpeg({ absolutePath: file })
    const r2 = await analyzeEnvelopeFFmpeg({ absolutePath: file })

    assert.strictEqual(r1, r2, 'same object returned from cache')
  })

  it('throws if file does not exist', async () => {
    await assert.rejects(
      analyzeEnvelopeFFmpeg({ absolutePath: resolve(testDir, 'nonexistent.wav') }),
      /not found|ENOENT/i
    )
  })

  it('does not use AudioContext (no window global)', async () => {
    // This test verifies that the module can be imported and used
    // in a pure Node environment without window or AudioContext.
    // If Web Audio code paths were reachable, they would throw
    // "Web Audio API is not available."
    const file = resolve(testDir, 'no_window.wav')
    await buildWav(file, { durationSec: 3, freq: 440, envelope: [{ t: 0, a: 1 }] })

    const result = await analyzeEnvelopeFFmpeg({ absolutePath: file })
    assert.ok(result.durationSec > 0, 'analysis completed without Web Audio')
  })
})