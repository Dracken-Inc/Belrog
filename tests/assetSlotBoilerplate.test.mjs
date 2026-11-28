// Regression: shot-5 asset-slot boilerplate (R4).
// Director-script directive prose ("exact supplied appearance… ACTION-FROZEN…
// no bodies, faces…") must never become an asset description, a Cast stub
// note, or keyframe/storyboard prompt content — it reads to an image model as
// "paint a storyboard/collage" and produced mirrored panels + invented people.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAssetLegendLines,
  parseInlineAssetDirectives,
  stripAssetNoteBoilerplate,
  stripShotDirectiveProse,
  findMalformedAssetDirectives,
  buildYoloPlanFromScript,
} from '../src/utils/yoloPlanning.js'
import {
  detectScriptGaps,
  buildStubUpserts,
  buildReferencePrompt,
} from '../src/services/scriptGapDetection.js'

const DIRECTIVE_SENTENCE
  = 'CHARACTER: roses only; exact supplied appearance, wardrobe and body state: roses; continuity state: unchanged from previous shot; do not invent identity details.'
const FREEZE_SENTENCE
  = 'ACTION-FROZEN: one exact still pose; frozen at the instant before motion, no motion blur.'

test('stripAssetNoteBoilerplate keeps real prose and drops directives', () => {
  const mixed = `young woman, dark curly hair, black leather jacket. ${DIRECTIVE_SENTENCE}`
  const stripped = stripAssetNoteBoilerplate(mixed)
  assert.ok(stripped.includes('dark curly hair'), 'real appearance survives')
  assert.ok(!/exact supplied appearance/i.test(stripped), 'directive sentence removed')
  assert.equal(stripAssetNoteBoilerplate(`${DIRECTIVE_SENTENCE} ${FREEZE_SENTENCE}`), '',
    'pure-directive text strips to empty')
})

test('legend CHARACTER line stores only appearance prose', () => {
  const legend = parseAssetLegendLines(
    `CHARACTER: Roses | roses | ${DIRECTIVE_SENTENCE}\n`
    + 'LOCATION: Empty Room | location_empty_room | bare plaster walls, single window. '
    + 'no bodies, faces, silhouettes or human-shaped forms anywhere in frame.\n'
  )
  const cast = legend.find((e) => e.kind === 'character')
  assert.equal(cast.description, '', 'pure boilerplate cast note becomes empty')
  const loc = legend.find((e) => e.slug === 'location_empty_room')
  assert.ok(loc.description.includes('bare plaster walls'), 'real location prose kept')
  assert.ok(!/no bodies, faces/i.test(loc.description), 'negative directive removed')
})

test('inline CHARACTER directive with only boilerplate is malformed, not an asset note', () => {
  const script = `Keyframe prompt: LOCATION: (location_empty_room) bare walls. CHARACTER: roses: ${DIRECTIVE_SENTENCE}`
  const inline = parseInlineAssetDirectives(script)
  const cast = inline.find((e) => e.kind === 'character')
  assert.ok(!cast || !cast.description || !/exact supplied appearance/i.test(cast.description),
    'inline cast description never carries directive prose')
  const malformed = findMalformedAssetDirectives(script)
  assert.ok(malformed.some((m) => m.kind === 'character' && m.slug === 'roses'),
    'boilerplate-only inline cast directive is surfaced as malformed')
})

test('stubs never carry directive-only descriptions; reference prompt skips them', () => {
  const scenes = [{ shots: [
    { index: 1, keyframePromptRaw: `LOCATION: bare plaster walls, single window. ${FREEZE_SENTENCE}`, motionPromptRaw: '', durationSeconds: 4 },
    { index: 2, keyframePromptRaw: `CHARACTER: ${DIRECTIVE_SENTENCE}`, motionPromptRaw: '', durationSeconds: 4 },
  ] }]
  const detection = detectScriptGaps({
    scenes, warnings: [
      { kind: 'unresolved-artist-override', raw: 'Roses', shotIndex: 2 },
    ], cast: [], library: { characters: [], props: [], locations: [] }, assets: [],
  })
  const stubs = buildStubUpserts({ detection, library: { characters: [], props: [], locations: [] }, scenes })
  for (const stub of stubs) {
    assert.ok(!/exact supplied appearance|ACTION-FROZEN|no motion blur|do not invent/i.test(stub.description),
      `stub ${stub.slug} note is directive-free: ${stub.description}`)
    assert.ok(stub.description.trim().length > 0, 'surviving stubs have drawable notes')
  }
  assert.equal(buildReferencePrompt({ kind: 'character', name: 'Roses', slug: 'roses',
    description: `${DIRECTIVE_SENTENCE} ${FREEZE_SENTENCE}` }), null,
  'boilerplate-only reference entry is skipped, not rendered')
})

test('storyboard prompts from buildYoloPlanFromScript are directive-free', () => {
  const SCRIPT = [
    'CHARACTER: Roses | roses | young woman, dark curly hair, black leather jacket',
    'LOCATION: Empty Room | location_empty_room | bare plaster walls, single window, soft overcast daylight',
    '',
    'Coverage 1: Main scripted sequence',
    'Coverage type: main_sequence',
    '',
    'Shot 1: Boots and static',
    'Shot type: b_roll',
    `Keyframe prompt: LOCATION: (location_empty_room). ${FREEZE_SENTENCE} ${DIRECTIVE_SENTENCE}`,
    'Motion prompt: handheld push-in.',
    'Length: 4.0',
  ].join('\n')
  const scenes = buildYoloPlanFromScript(SCRIPT, { takesPerAngle: 1, targetDurationSeconds: 4 })
  const variant = scenes.flatMap((s) => s.shots || []).map((shot) => ({ ...shot }))
  const storyboard = JSON.stringify(variant)
  assert.ok(!/ACTION-FROZEN|exact supplied appearance|no motion blur/i.test(storyboard),
    'no compiler directives leak into the plan shots')
})

test('stripShotDirectiveProse keeps labels for slug expansion', () => {
  const text = `LOCATION: (location_empty_room) at dusk. ${FREEZE_SENTENCE} A woman in a red coat stands under the window.`
  const stripped = stripShotDirectiveProse(text)
  assert.ok(stripped.includes('LOCATION: (location_empty_room)'), 'label+token kept for expansion')
  assert.ok(stripped.includes('red coat'), 'visible action kept')
  assert.ok(!/ACTION-FROZEN/i.test(stripped), 'freeze directive removed')
})
