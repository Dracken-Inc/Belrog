/**
 * Tests for belrog-0.6.4 fixes: D1, D2, D3
 * - D1: No arithmetic interpolation in prompts, per-section shot budget computed
 * - D2: Real onsets passed to compilePlot/compileShots, downsampled to 32 spanning track
 * - D3: Section-chunked generation with advisory timing (clamp, don't throw for timing)
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { computeShotBudget, tileShotsBySection } from '../src/services/sunoIntake.js'
import { downsampleBeats, parseCSVResponse } from '../src/services/actionProse.mjs'

describe('D1: computeShotBudget', () => {
  it('clamps to [2, 8] and rounds duration/4', () => {
    // < 8s -> 2 (minimum)
    assert.strictEqual(computeShotBudget(3), 2)
    assert.strictEqual(computeShotBudget(7.9), 2)
    // 8s -> 2, 12s -> 3, 16s -> 4, 20s -> 5, 24s -> 6, 28s -> 7, 32s -> 8
    assert.strictEqual(computeShotBudget(8), 2)
    assert.strictEqual(computeShotBudget(12), 3)
    assert.strictEqual(computeShotBudget(16), 4)
    assert.strictEqual(computeShotBudget(20), 5)
    assert.strictEqual(computeShotBudget(24), 6)
    assert.strictEqual(computeShotBudget(28), 7)
    assert.strictEqual(computeShotBudget(32), 8)
    // > 32s -> 8 (maximum)
    assert.strictEqual(computeShotBudget(40), 8)
    assert.strictEqual(computeShotBudget(100), 8)
  })
})

describe('D1: tileShotsBySection matches computeShotBudget', () => {
  it('produces exactly budget shots per section', () => {
    const sections = [
      { id: 's1', kind: 'verse', startSec: 0, endSec: 16 },   // budget 4
      { id: 's2', kind: 'chorus', startSec: 16, endSec: 32 }, // budget 4
    ]
    const blocks = [
      { startSec: 2, endSec: 4, lines: ['line 1'] },
      { startSec: 18, endSec: 20, lines: ['line 2'] },
    ]
    const shots = tileShotsBySection(blocks, sections)
    assert.strictEqual(shots.length, 8)
    const s1shots = shots.filter(s => s.sectionId === 's1')
    const s2shots = shots.filter(s => s.sectionId === 's2')
    assert.strictEqual(s1shots.length, 4)
    assert.strictEqual(s2shots.length, 4)
    // Coverage check
    assert.ok(Math.abs(s1shots[0].startSec - 0) < 0.01)
    assert.ok(Math.abs(s1shots[3].endSec - 16) < 0.01)
    assert.ok(Math.abs(s2shots[0].startSec - 16) < 0.01)
    assert.ok(Math.abs(s2shots[3].endSec - 32) < 0.01)
  })
})

describe('D2: downsampleBeats', () => {
  it('returns 32 evenly spaced samples spanning first to last onset', () => {
    const onsets = Array.from({ length: 100 }, (_, i) => i * 0.5) // 0, 0.5, 1.0, ... 49.5
    const sampled = downsampleBeats(onsets, 32)
    assert.strictEqual(sampled.length, 32)
    assert.ok(Math.abs(sampled[0] - 0) < 0.01)
    assert.ok(Math.abs(sampled[31] - 49.5) < 0.01)
    // Check that samples span the full range and are monotonically increasing
    for (let i = 1; i < sampled.length; i++) {
      assert.ok(sampled[i] > sampled[i-1], `Samples not increasing: ${sampled[i-1]} >= ${sampled[i]}`)
    }
  })

  it('returns all onsets when fewer than count', () => {
    const onsets = [1, 2, 3, 4, 5]
    const sampled = downsampleBeats(onsets, 32)
    assert.deepStrictEqual(sampled, [1, 2, 3, 4, 5])
  })

  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(downsampleBeats([], 32), [])
    assert.deepStrictEqual(downsampleBeats(null, 32), [])
  })
})

describe('D3: parseCSVResponse advisory timing (clamp, no throw)', () => {
  const sections = [
    { id: 's1', kind: 'verse', startSec: 0, endSec: 10 },
    { id: 's2', kind: 'chorus', startSec: 10, endSec: 20 },
  ]
  const castSlugs = ['singer']
  const plot = {
    cast: [{ slug: 'singer', description: 'lead vocalist' }],
    locations: [{ slug: 'stage', description: 'concert stage' }],
  }

  // Tiled shots PER SECTION (as passed by compileShots)
  const s1TiledShots = [
    { startSec: 0, endSec: 5, lyric: ['line 1'], sectionId: 's1' },
    { startSec: 5, endSec: 10, lyric: ['line 2'], sectionId: 's1' },
  ]
  const s2TiledShots = [
    { startSec: 10, endSec: 15, lyric: ['line 3'], sectionId: 's2' },
    { startSec: 15, endSec: 20, lyric: ['line 4'], sectionId: 's2' },
  ]

  it('clamps model timing that disagrees with tiled slot beyond 0.5s', () => {
    const csv = `Shot_ID,Section_ID,Start_Sec,End_Sec,Shot_Type,Size,Camera_Move,Energy,Performance_Mode,Cast,Props,Lyric,Lip_Sync,Action,Location_Override,Film,Lighting
s1_0,s1,1.0,6.0,performance,medium,push-in,building,lip-sync,singer,,line 1,true,action text,,,
s1_1,s1,5.0,10.0,performance,wide,locked,calm,wide-performance,singer,,line 2,false,action text,,,`

    // First shot has model timing 1.0-6.0 vs tiled 0-5 (diff > 0.5) -> should clamp to 0-5
    const shots = parseCSVResponse(csv, { sections: [sections[0]], castSlugs, plot, tiledShots: s1TiledShots, durationSec: 10 })
    assert.strictEqual(shots[0].startSec, 0)
    assert.strictEqual(shots[0].endSec, 5)
    assert.strictEqual(shots[1].startSec, 5)
    assert.strictEqual(shots[1].endSec, 10)
  })

  it('does not throw for timing disagreement, only warns', () => {
    const csv = `Shot_ID,Section_ID,Start_Sec,End_Sec,Shot_Type,Size,Camera_Move,Energy,Performance_Mode,Cast,Props,Lyric,Lip_Sync,Action,Location_Override,Film,Lighting
s1_0,s1,2.0,7.0,performance,medium,push-in,building,lip-sync,singer,,line 1,true,action text,,,
s1_1,s1,7.0,10.0,performance,wide,locked,calm,wide-performance,singer,,line 2,false,action text,,,`

    // Should not throw, just clamp and warn (console.warn called)
    const shots = parseCSVResponse(csv, { sections: [sections[0]], castSlugs, plot, tiledShots: s1TiledShots, durationSec: 10 })
    assert.strictEqual(shots.length, 2)
  })

  it('throws for unknown Section_ID (structural error)', () => {
    const csv = `Shot_ID,Section_ID,Start_Sec,End_Sec,Shot_Type,Size,Camera_Move,Energy,Performance_Mode,Cast,Props,Lyric,Lip_Sync,Action,Location_Override,Film,Lighting
s1_0,s1,0,5,performance,medium,push-in,building,lip-sync,singer,,line 1,true,action text,,,
x0,unknown_section,10,15,performance,close-up,orbit,intense,lip-sync,singer,,line 3,true,action text,,,`

    assert.throws(() => parseCSVResponse(csv, { sections: [sections[0]], castSlugs, plot, tiledShots: s1TiledShots }), /Section_ID not found/)
  })

  it('throws for unknown cast slug (structural error)', () => {
    const csv = `Shot_ID,Section_ID,Start_Sec,End_Sec,Shot_Type,Size,Camera_Move,Energy,Performance_Mode,Cast,Props,Lyric,Lip_Sync,Action,Location_Override,Film,Lighting
s1_0,s1,0,5,performance,medium,push-in,building,lip-sync,unknown_singer,,line 1,true,action text,,,
s1_1,s1,5,10,performance,wide,locked,calm,wide-performance,singer,,line 2,false,action text,,,`

    assert.throws(() => parseCSVResponse(csv, { sections: [sections[0]], castSlugs, plot, tiledShots: s1TiledShots }), /Unknown cast slug/)
  })

  it('rejects invalid Camera_Move (dutch-tilt removed from enum)', () => {
    const csv = `Shot_ID,Section_ID,Start_Sec,End_Sec,Shot_Type,Size,Camera_Move,Energy,Performance_Mode,Cast,Props,Lyric,Lip_Sync,Action,Location_Override,Film,Lighting
s1_0,s1,0,5,performance,medium,dutch-tilt,building,lip-sync,singer,,line 1,true,action text,,,
s1_1,s1,5,10,performance,wide,locked,calm,wide-performance,singer,,line 2,false,action text,,,`

    assert.throws(() => parseCSVResponse(csv, { sections: [sections[0]], castSlugs, plot, tiledShots: s1TiledShots }), /Invalid Camera_Move/)
  })
})

describe('D3: Section-chunked generation produces correct shot count', () => {
  // Mock compileShots behavior with a synthetic 283s structure
  it('synthetic 283s structure yields shot count matching budgets', () => {
    // Simulate sections for a 283s track (typical song structure)
    const sections = [
      { id: 's1', kind: 'intro', startSec: 0, endSec: 15 },
      { id: 's2', kind: 'verse', startSec: 15, endSec: 45 },
      { id: 's3', kind: 'chorus', startSec: 45, endSec: 75 },
      { id: 's4', kind: 'verse', startSec: 75, endSec: 105 },
      { id: 's5', kind: 'chorus', startSec: 105, endSec: 135 },
      { id: 's6', kind: 'bridge', startSec: 135, endSec: 165 },
      { id: 's7', kind: 'chorus', startSec: 165, endSec: 195 },
      { id: 's8', kind: 'outro', startSec: 195, endSec: 210 },
      { id: 's9', kind: 'coda', startSec: 210, endSec: 283 },
    ]

    const totalBudget = sections.reduce((sum, s) => sum + computeShotBudget(s.endSec - s.startSec), 0)
    // Budgets: 15->4, 30->8, 30->8, 30->8, 30->8, 30->8, 30->8, 15->4, 73->8 = 64
    assert.strictEqual(totalBudget, 64)

    // Verify each section budget
    const budgets = sections.map(s => computeShotBudget(s.endSec - s.startSec))
    assert.deepStrictEqual(budgets, [4, 8, 8, 8, 8, 8, 8, 4, 8])
  })
})

describe('D1: No arithmetic interpolation in prompts', () => {
  it('SHOTS_SYSTEM_PROMPT does not contain ${3-5} or similar', async () => {
    const actionProse = await import('../src/services/actionProse.mjs')
    // The prompt is not directly exported, but we can verify the file content
    const fs = await import('fs')
    const content = fs.readFileSync('./src/services/actionProse.mjs', 'utf-8')
    // Should not contain any arithmetic in template literals
    assert.ok(!content.includes('${3-5}'), 'Found arithmetic interpolation ${3-5}')
    assert.ok(!content.includes('${ 3-5 }'), 'Found arithmetic interpolation with spaces')
    // Should contain the placeholder
    assert.ok(content.includes('{{SHOT_BUDGET}}'), 'Missing SHOT_BUDGET placeholder')
    // Should contain downsampleBeats export
    assert.ok(content.includes('export function downsampleBeats'), 'Missing downsampleBeats export')
    // Should contain computeShotBudget export
    assert.ok(content.includes('export function computeShotBudget'), 'Missing computeShotBudget export')
  })
})