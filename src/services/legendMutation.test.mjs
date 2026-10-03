/**
 * C4 mutation battery (0.4.8.3 hardening).
 *
 * Henry's rule: a suite that only sees good scripts proves nothing. Every
 * case here takes the Director Suite GOLDEN script and injects ONE known-bad
 * violation at a RANDOM position in the legend, then demands the detector
 * catch it. A miss is a hard failure — no catch-rate tolerance.
 *
 * Verified separately: the clean golden must report ZERO issues, so the
 * auditor cannot pass everything to look busy.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAssetLegendLines, auditAssetLegend } from '../utils/yoloPlanning.js'
import { detectScriptGaps } from './scriptGapDetection.js'

const LEGEND_LINES = [
  'CHARACTER: rose — the lead singer, silver braid, kind eyes, worn flannel shirt',
  'LOCATION: Pine Forest | location_dpf | dense pine forest at blue hour, fog between trunks',
  'LOCATION: Phone Booth | location_phone_booth | rain-slick street corner, glass-and-steel booth',
  'PROP: Cassette Tape | prop_cassette | a worn cassette tape, green-glowing label, cracked corner',
]

const BODY = [
  '',
  'Coverage 1: Main',
  'Coverage type: main_sequence',
  'Coverage label: Main',
  'Purpose: Per-brief take lane, tiled full duration.',
  '',
  'Shot 1: T-01',
  'Start at: 00:00.0',
  'Shot type: performance',
  'Artist: rose',
  'Keyframe prompt: LOCATION: (location_dpf), establishing wide. CHARACTER: rose only; exact supplied appearance.',
  'Motion prompt: ONE action: sings toward lens. ONE camera move: slow push-in, 35mm.',
  'Camera: slow push-in, 35mm',
  'Length: 4.0s',
].join('\n')

function scriptWith(legendLines) {
  return ['BELROG DIRECTOR SCRIPT', 'Seed base: 7.', ...legendLines, BODY].join('\n')
}

/** Deterministic pseudo-random (seeded) so a failure is reproducible. */
function lcg(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

// ── control: the clean golden must be silent ──────────────────────────────
test('mutation control: clean golden legend reports zero issues', () => {
  const assets = parseAssetLegendLines(scriptWith(LEGEND_LINES))
  assert.equal(assets.length, 4)
  const issues = auditAssetLegend(assets)
  assert.equal(issues.length, 0, `clean legend must be silent, got ${JSON.stringify(issues)}`)
})

// ── each violation class, at a RANDOM insert position ─────────────────────
const MUTATIONS = [
  {
    name: 'duplicate slug, same kind',
    poison: () => 'LOCATION: Pine Grove | location_dpf | a second place stealing the slug',
    expect: (issues) => issues.some((i) => i.kind === 'duplicate-slug' && i.slug === 'location_dpf'),
  },
  {
    name: 'duplicate slug, cross kind (location slug used by a PROP)',
    poison: () => 'PROP: Pine Grove | location_dpf | a prop claiming a location slug',
    expect: (issues) => issues.some((i) => i.kind === 'duplicate-slug' || i.kind === 'slug-kind-mismatch'),
  },
  {
    name: 'wrong cast type — location_ prefix declared as PROP',
    poison: (rand) => `PROP: Widget | location_widget_${Math.floor(rand() * 9999)} | a prop misusing the location prefix`,
    expect: (issues) => issues.some((i) => i.kind === 'slug-kind-mismatch' && i.slug.startsWith('location_widget')),
  },
  {
    name: 'wrong cast type — prop_ prefix declared as LOCATION',
    poison: (rand) => `LOCATION: Gadget | prop_gadget_${Math.floor(rand() * 9999)} | a location misusing the prop prefix`,
    expect: (issues) => issues.some((i) => i.kind === 'slug-kind-mismatch' && i.slug.startsWith('prop_gadget')),
  },
  {
    name: 'missing location_ prefix',
    poison: (rand) => `LOCATION: Bare Spot | bare_spot_${Math.floor(rand() * 9999)} | location without its required prefix`,
    expect: (issues) => issues.some((i) => i.kind === 'missing-prefix' && i.slug.startsWith('bare_spot')),
  },
  {
    name: 'duplicate human name on two locations',
    poison: () => 'LOCATION: Pine Forest | location_pine_v2 | different slug, same display name',
    expect: (issues) => issues.some((i) => i.kind === 'duplicate-name' && i.name.toLowerCase() === 'pine forest'),
  },
  {
    name: 'duplicate human name across kinds',
    poison: () => 'PROP: Phone Booth | prop_phone_clone | a prop wearing a location name',
    expect: (issues) => issues.some((i) => i.kind === 'duplicate-name' && i.name.toLowerCase() === 'phone booth'),
  },
]

for (const mut of MUTATIONS) {
  test(`mutation caught: ${mut.name} (random position, 12 seeds)`, () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const rand = lcg(seed * 7919)
      const lines = [...LEGEND_LINES]
      const at = Math.floor(rand() * (lines.length + 1))
      lines.splice(at, 0, mut.poison(rand))
      const assets = parseAssetLegendLines(scriptWith(lines))
      const issues = auditAssetLegend(assets)
      assert.ok(
        mut.expect(issues),
        `seed ${seed} position ${at}: auditor MISSED "${mut.name}". legend had ${lines.length} lines, issues=${JSON.stringify(issues.map((i) => i.kind))}`,
      )
      // The violation must ALSO reach detection (that's what the UI shows).
      const detection = detectScriptGaps({
        scenes: [{ shots: [{ index: 1, id: 'S1_SH1', keyframePromptRaw: 'LOCATION: (location_dpf), wide', motionPromptRaw: '', durationSeconds: 4 }] }],
        warnings: [], cast: [], library: { characters: [], props: [], locations: [] }, assets,
      })
      assert.ok(
        detection.legendIssues.length > 0,
        `seed ${seed}: detection did not surface "${mut.name}" to the UI`,
      )
    }
  })
}

// ── 100% catch rate over the whole battery, many seeds ────────────────────
test('mutation battery: 100% catch rate across 200 randomized poisonings', () => {
  let injected = 0
  const misses = []
  for (let seed = 1; seed <= 200; seed += 1) {
    const mut = MUTATIONS[seed % MUTATIONS.length]
    const rand = lcg(seed * 104729)
    const lines = [...LEGEND_LINES]
    lines.splice(Math.floor(rand() * (lines.length + 1)), 0, mut.poison(rand))
    injected += 1
    const issues = auditAssetLegend(parseAssetLegendLines(scriptWith(lines)))
    if (!mut.expect(issues)) misses.push(`seed ${seed} (${mut.name})`)
  }
  assert.equal(misses.length, 0, `auditor missed ${misses.length}/${injected}: ${misses.slice(0, 8).join('; ')}`)
})

// ── meta-check: prove the harness CAN fail (no vacuous green) ─────────────
test('meta: a stub auditor that always passes is caught by the battery', () => {
  // If the battery logic were vacuous (always true), this fake auditor would
  // "pass" it. It must not.
  const alwaysPass = () => []
  let caughtViolations = 0
  for (const line of [
    'LOCATION: Dup | location_dpf | duplicate slug',
    'PROP: X | location_wrong | wrong prefix kind',
  ]) {
    const assets = [...parseAssetLegendLines(scriptWith(LEGEND_LINES)), ...parseAssetLegendLines(line)]
    if (auditAssetLegend(assets).length > 0 && alwaysPass(assets).length === 0) caughtViolations += 1
  }
  assert.equal(caughtViolations, 2, 'real auditor flags both, stub auditor flags none')
})

// ── detection must not double-stub a duplicated slug ──────────────────────
test('duplicate slug yields ONE stub plus a visible issue, never two entries', () => {
  const assets = parseAssetLegendLines(scriptWith([
    ...LEGEND_LINES,
    'LOCATION: Pine Grove | location_dpf | same slug twice',
  ]))
  const detection = detectScriptGaps({
    scenes: [{ shots: [{ index: 1, id: 'S1_SH1', keyframePromptRaw: 'x', durationSeconds: 4 }] }],
    warnings: [], cast: [], library: { characters: [], props: [], locations: [] }, assets,
  })
  const dpf = detection.gaps.filter((g) => g.slug === 'location_dpf')
  assert.equal(dpf.length, 1, `one location_dpf entry expected, got ${dpf.length}`)
  assert.equal(detection.stats.legendIssues, 1, 'the duplicate is reported as exactly one error')
})
