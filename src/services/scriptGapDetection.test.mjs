/**
 * C4 acceptance tests: director-script gap detection + asset library store.
 * Node-clean (no DOM). Run: `node --test src/services/scriptGapDetection.test.mjs`
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  detectScriptGaps,
  buildStubUpserts,
  buildRegenerateAllPreview,
} from './scriptGapDetection.js'
import {
  upsertLibraryEntry,
  makeEntityId,
  setEntryAssetId,
  importLibraryJson,
  findLibraryEntry,
  updateEntryIdentity,
} from './assetLibraryStore.js'
import {
  parseStructuredDirectorScript,
  parseAssetLegendLines,
  parseInlineAssetDirectives,
  flattenYoloPlanVariants,
} from '../utils/yoloPlanning.js'

const EMPTY_LIB = { characters: [], props: [], locations: [] }

/** Build a minimal parsed-plan scene (the shape buildMusicVideoPlanFromScript emits). */
function scene(shots) {
  return { id: 'S1', index: 1, rawText: '', contextText: '', summary: '', shots }
}
function shot(index, { text = '', artist = '' } = {}) {
  return {
    index,
    id: `S1_SH${index}`,
    keyframePromptRaw: text,
    motionPromptRaw: text,
    videoBeat: text,
    imageBeat: text,
    artistRaw: artist,
    coverageLabel: '',
    shotType: '',
    notes: '',
    label: '',
  }
}

// ---------------------------------------------------------------------------
// Golden script — pins the parser contract (A.5.6: format drift caught in CI).
// This is Belrog's OWN director-script spec (perchance.org/belrog output):
// `Scene`/`Shot` headings + `Artist:`/`Keyframe prompt:`/`Motion prompt:` fields.
// If the hosted generator's output format changes, these counts drift and fail.
// ---------------------------------------------------------------------------
const GOLDEN_SCRIPT = `
Scene 1 - Neon Alley
Shot 1
Artist: rose
Keyframe prompt: Rose steps through the rain-slicked alley, the "Rusty Garage" sign flickering behind her.
Motion prompt: Slow push-in, neon reflections sliding down the wet asphalt.
Length: 4
Shot 2
Artist: rose
Keyframe prompt: Close-up on Rose's face as the "Rusty Garage" door groans open behind her.
Motion prompt: Shallow rack focus from her eyes to the garage.
Length: 3
Scene 2 - The Rusty Garage
Shot 3
Artist: jake
Keyframe prompt: Jake leans on the workbench inside the "Rusty Garage", the "Old Motor" poster peeling on the wall.
Motion prompt: Handheld, subtle sway.
Length: 4
Shot 4
Artist: rose, jake
Keyframe prompt: Rose and Jake face each other across the workbench in the "Rusty Garage".
Motion prompt: Slow dolly around the two of them.
Length: 5
`

test('golden script: parser produces a stable scene/shot/field structure (format pin)', () => {
  const parsed = parseStructuredDirectorScript(GOLDEN_SCRIPT, {
    takesPerAngle: 1,
    targetDurationSeconds: 30,
  })
  assert.ok(Array.isArray(parsed), 'expected an array of scenes')
  assert.equal(parsed.length, 2, 'expected 2 scenes')
  const shotCount = parsed.reduce((n, s) => n + s.shots.length, 0)
  assert.equal(shotCount, 4, 'expected 4 shots total')
  // Field extraction survives (the exact fields the gap detector + brief rely on).
  const s1sh1 = parsed[0].shots[0]
  assert.equal(s1sh1.artistRaw, 'rose', 'Artist: field must round-trip verbatim')
  assert.match(s1sh1.keyframePromptRaw, /Rusty Garage/, 'keyframe text must survive')
  const s2sh4 = parsed[1].shots[1]
  assert.match(s2sh4.artistRaw, /rose,\s*jake/, 'duet Artist: list must round-trip')
})

test('character gaps: unresolved Artist + lyric-tag warnings become one stub each', () => {
  const warnings = [
    { kind: 'unresolved-artist-override', raw: 'mia', shotIndex: 0, message: 'x' },
    { kind: 'unresolved-artist-override', raw: 'mia', shotIndex: 2, message: 'x' },
    { kind: 'unresolved-lyric-tag', raw: 'theo', shotIndex: 1, message: 'x' },
    // Resolved names / collective keywords are NOT gaps.
    { kind: 'unresolved-artist-override', raw: '*', shotIndex: 3, message: 'x' },
  ]
  const cast = [{ slug: 'rose', label: 'Rose', assetId: 'a1' }]
  const scenes = [
    scene([shot(1, {}), shot(2, {}), shot(3, {}), shot(4, {})]),
  ]
  const detection = detectScriptGaps({ scenes, warnings, cast, library: EMPTY_LIB })
  const names = detection.characters.map((c) => c.slug).sort()
  assert.deepEqual(names, ['mia', 'theo'], 'only unresolved names are gaps')
  const mia = detection.characters.find((c) => c.slug === 'mia')
  assert.deepEqual(mia.shots.sort(), [0, 2], 'shot refs accumulate across shots')
  assert.equal(mia.matched, 'new', 'unknown name is a new gap')
})

test('character gaps: a name already in the cast is not a gap', () => {
  const warnings = [{ kind: 'unresolved-artist-override', raw: 'rose', shotIndex: 0, message: 'x' }]
  const cast = [{ slug: 'rose', label: 'Rose', assetId: 'a1' }]
  const detection = detectScriptGaps({ scenes: [scene([shot(1, {})])], warnings, cast, library: EMPTY_LIB })
  assert.equal(detection.characters.length, 0, 'cast-resolved names are excluded')
})

test('character gaps: a library character without a reference is an "exact" gap; with a reference it is no gap', () => {
  const warnings = [{ kind: 'unresolved-artist-override', raw: 'nova', shotIndex: 0, message: 'x' }]
  const cast = [{ slug: 'rose', label: 'Rose', assetId: 'a1' }]
  const scenes = [scene([shot(1, {})])]

  // No reference yet → gap (exact, known to library).
  const libNoRef = { characters: [{ id: 'chr_x', slug: 'nova', name: 'Nova', assetId: null }], props: [], locations: [] }
  const d1 = detectScriptGaps({ scenes, warnings, cast, library: libNoRef })
  assert.equal(d1.characters.length, 1)
  assert.equal(d1.characters[0].matched, 'exact')

  // Has a reference → not a gap.
  const libWithRef = { characters: [{ id: 'chr_x', slug: 'nova', name: 'Nova', assetId: 'img1' }], props: [], locations: [] }
  const d2 = detectScriptGaps({ scenes, warnings, cast, library: libWithRef })
  assert.equal(d2.characters.length, 1, 'detectScriptGaps still reports the mention...')
  // ...but buildStubUpserts must skip it (reference exists = no work to do).
  const stubs = buildStubUpserts({ detection: d2, library: libWithRef })
  assert.equal(stubs.length, 0, 'stub upserts skip entries that already have a reference')
})

test('prop/location gap: a quoted phrase used across >=2 shots is a fuzzy gap', () => {
  const text = 'The "Midnight Pier" glows under the fog, the "Midnight Pier" railing wet with salt.'
  const scenes = [
    scene([shot(1, { text }), shot(2, { text: 'Rain hammers the "Midnight Pier" planks.' })]),
  ]
  const detection = detectScriptGaps({ scenes, warnings: [], cast: [], library: EMPTY_LIB })
  const pier = detection.gaps.find((g) => g.slug === 'midnight-pier')
  assert.ok(pier, 'repeated quoted phrase must become a gap')
  assert.ok(pier.kind === 'location' || pier.kind === 'prop', 'classified as a place or thing')
  assert.equal(pier.matched, 'fuzzy', 'unknown phrase is a fuzzy proposal')
  assert.equal(pier.shots.length, 2, 'frequency filter: appears in two shots')
  assert.match(pier.description, /Midnight Pier/, 'description is the director\'s verbatim words')
})

test('prop/location gap: a single-shot phrase is filtered out (unless known to the library)', () => {
  const scenes = [
    scene([
      shot(1, { text: 'She holds the "Velvet Crown" tight.' }),
      shot(2, { text: 'Wide shot of the empty room, no crown in sight.' }),
    ]),
  ]
  const detection = detectScriptGaps({ scenes, warnings: [], cast: [], library: EMPTY_LIB })
  const crown = detection.gaps.find((g) => g.slug === 'velvet-crown')
  assert.equal(crown, undefined, 'one-shot unknown phrase is dropped (Henry\'s multi-shot filter)')
})

test('word-boundary: a stopword head or section marker is never a gap', () => {
  const scenes = [
    scene([
      shot(1, { text: 'The "Chorus" builds as "the rain" falls on "the pier" and "the rain" again.' }),
      shot(2, { text: 'Again "the rain" over the empty "the pier".' }),
    ]),
  ]
  const detection = detectScriptGaps({ scenes, warnings: [], cast: [], library: EMPTY_LIB })
  assert.equal(detection.gaps.find((g) => g.slug === 'chorus'), undefined, 'section markers excluded')
  assert.equal(detection.gaps.find((g) => g.slug === 'the-rain'), undefined, 'stopword head excluded')
  assert.equal(detection.gaps.find((g) => g.slug === 'the-pier'), undefined, 'stopword head excluded')
})

// ---------------------------------------------------------------------------
// Library store
// ---------------------------------------------------------------------------
test('library: upsert creates with stable id, then is idempotent (keeps id, merges)', () => {
  let lib = EMPTY_LIB
  const first = upsertLibraryEntry(lib, {
    kind: 'character', name: 'Nova', slug: 'nova',
    description: 'A rogue with a silver dagger.',
    provenance: { source: 'director-script', shots: [1, 2] },
  })
  assert.equal(first.created, true)
  assert.match(first.entry.id, /^chr_/, 'character id is chr_ prefixed')
  const firstId = first.entry.id
  lib = first.library

  const second = upsertLibraryEntry(lib, {
    kind: 'character', name: 'nova', slug: 'nova',
    description: 'She fights at dawn.',
    provenance: { source: 'director-script', shots: [3] },
  })
  assert.equal(second.created, false, 're-upsert on same slug does not create a second entry')
  assert.equal(second.entry.id, firstId, 'id is immutable across upserts')
  assert.equal(lib.characters.length, 1, 'exactly one nova entry')
  assert.match(second.entry.description, /silver dagger/, 'first description preserved')
  assert.match(second.entry.description, /fights at dawn/, 'new description merged in')
  assert.deepEqual(new Set(second.entry.provenance.shots), new Set([1, 2, 3]), 'shot refs union across upserts')
})

test('library: forceDescription replaces the verbatim seed (explicit refresh)', () => {
  let lib = EMPTY_LIB
  const first = upsertLibraryEntry(lib, { kind: 'prop', name: 'Crown', slug: 'crown', description: 'old seed text' })
  lib = first.library
  const second = upsertLibraryEntry(lib, { kind: 'prop', name: 'Crown', slug: 'crown', description: 'fresh explicit text', forceDescription: true })
  assert.equal(second.entry.description, 'fresh explicit text', 'forceDescription overwrites, does not append')
})

test('library: makeEntityId is unique and prefix-correct', () => {
  const ids = new Set()
  for (let i = 0; i < 500; i += 1) ids.add(makeEntityId('location'))
  assert.equal(ids.size, 500, 'ids are unique across 500 draws')
  assert.ok([...ids].every((id) => /^loc_[0-9a-v]+$/.test(id)), 'location ids are loc_ + Crockford base32')
  assert.ok(makeEntityId('prop').startsWith('prp_'))
  assert.ok(makeEntityId('character').startsWith('chr_'))
})

test('library: setEntryAssetId wires a generated reference (and clears on null)', () => {
  let lib = EMPTY_LIB
  const first = upsertLibraryEntry(lib, { kind: 'location', name: 'Pier', slug: 'pier', description: 'foggy' })
  lib = first.library
  const id = first.entry.id

  const wired = setEntryAssetId(lib, id, 'img99')
  assert.equal(wired.changed, true)
  lib = wired.library
  assert.equal(findLibraryEntry(lib, id).assetId, 'img99')

  // A referenced entry is no longer a Regenerate-All candidate.
  const preview = buildRegenerateAllPreview({ library: lib })
  assert.equal(preview.items.find((item) => item.id === id), undefined, 'referenced entries are skipped')
})

test('regenerate-all: skips description-less stubs, caps the queue, reports remaining', () => {
  let lib = EMPTY_LIB
  for (const [name, desc] of [
    ['A', 'a described stub one'], ['B', 'a described stub two'], ['C', ''], ['D', 'a described stub four'],
  ]) {
    const r = upsertLibraryEntry(lib, { kind: 'prop', name, slug: name.toLowerCase(), description: desc })
    lib = r.library
  }
  const preview = buildRegenerateAllPreview({ library: lib, cap: 2 })
  assert.equal(preview.items.length, 2, 'cap limits the queued items')
  assert.equal(preview.remaining, 1, 'two more are waiting beyond the cap')
  assert.equal(preview.capped, true)
  const skippedNames = preview.skipped.map((s) => s.name).sort()
  assert.deepEqual(skippedNames, ['C'], 'description-less stub is listed as needs-description, not queued')
  assert.match(preview.items[0].prompt, /prop reference sheet/i, 'prompt is built from the verbatim description')
  assert.ok(preview.items.every((item) => item.estimatedSeconds > 0), 'estimate present for the time display')
})

test('library: import is merge-safe — known slugs keep local id, unknown slugs are added', () => {
  let lib = EMPTY_LIB
  const local = upsertLibraryEntry(lib, { kind: 'character', name: 'Rose', slug: 'rose', description: 'local rose' })
  lib = local.library
  const localRoseId = local.entry.id

  const exported = JSON.stringify({
    format: 'belrog-asset-library', version: 1,
    entries: [
      { id: 'chr_IMPORTED', kind: 'character', name: 'Rose', slug: 'rose', label: 'Rose', description: 'imported rose' },
      { id: 'chr_IMPORTED2', kind: 'character', name: 'Jade', slug: 'jade', label: 'Jade', description: 'imported jade' },
    ],
  })
  const result = importLibraryJson(exported, lib)
  assert.equal(result.ok, true)
  lib = result.library
  // Local Rose keeps its id + description (import must not clobber the user's verbatim text).
  const rose = lib.characters.find((c) => c.slug === 'rose')
  assert.equal(rose.id, localRoseId, 'existing slug keeps the local id')
  assert.match(rose.description, /local rose/, 'existing description is preserved on import')
  // Jade is new — imported entries get a FRESH local id (never reusing an
  // imported id, which could collide with a local one), description carried in.
  const jade = lib.characters.find((c) => c.slug === 'jade')
  assert.match(jade.id, /^chr_[0-9a-v]+$/, 'new entry gets a fresh local id')
  assert.match(jade.description, /imported jade/, 'imported description is carried in')
})

test('library: import rejects non-library JSON gracefully', () => {
  const bad = importLibraryJson('{"nope":1}', EMPTY_LIB)
  assert.equal(bad.ok, false)
  assert.match(bad.error, /entries/)
  const notJson = importLibraryJson('definitely not json', EMPTY_LIB)
  assert.equal(notJson.ok, false)
  assert.match(notJson.error, /JSON/i)
})

test('detection: LTX structural labels in shot text never become locations', () => {
  const script = [
    'Scene 1: The Cell',
    'Shot 1: Wide',
    'Camera: 35mm slow push',
    'Artist: n/a',
    'Keyframe: A candle flickers in the damp cell',
    'Motion: slow breath',
    'Shot 2: Close',
    'Camera: 50mm static',
    'Artist: n/a',
    'Keyframe: Hands clasped, DIRECTOR STEER framing under CONTINUITY RULES light',
    'Motion: flicker',
    'Shot 3: Detail',
    'Camera: 85mm static',
    'Artist: n/a',
    'Keyframe: Shot type: b_roll insert, CONTINUITY RULES slate, DIRECTOR STEER margin note',
    'Motion: dust motes',
  ].join('\n')
  const parsed = parseStructuredDirectorScript(script)
  const detection = detectScriptGaps({ scenes: parsed, warnings: [], cast: [], library: EMPTY_LIB })
  const names = [...detection.locations, ...detection.props].map((e) => e.name.toLowerCase()).join('|')
  for (const marker of ['shot type', 'continuity rules', 'director steer', 'b roll', 'b_roll']) {
    assert.ok(!names.includes(marker), `structural label "${marker}" must never be detected as an entity`)
  }
  assert.equal(detection.locations.length + detection.props.length, 0, 'zero entities from a script that only contains structural labels')
})

// ---------------------------------------------------------------------------
// 0.4.5 — asset legend (authoritative asset declarations at the top of the
// LTX director script: "TYPE: slug — description" and "slug : desc , TYPE").
// ---------------------------------------------------------------------------

test('legend: parser reads both line forms before the first scene only', () => {
  const script = [
    'CHARACTER: rose — the lead singer, silver braid, kind eyes',
    'LOCATION: pier : midnight pier with fog and sodium lamps , LOCATION',
    'PROP: old-cassette : worn cassette, green label , PROP',
    'CAST: bruno — the abbot, woolen robe',
    'Shot type: b_roll',
    '',
    'Scene 1: Test',
    'Shot 1: Wide',
    'Artist: rose',
    'Keyframe: Rose stands on the pier',
    'Motion: wind',
    'Shot 2: Close',
    'Artist: bruno',
    'Keyframe: Bruno holds the old-cassette on the pier',
    'Motion: still',
  ].join('\n')

  const assets = parseAssetLegendLines(script)
  assert.equal(assets.length, 4, 'all four legend lines parsed (two forms, CAST alias)')
  const rose = assets.find((a) => a.slug === 'rose')
  assert.equal(rose.kind, 'character')
  assert.match(rose.description, /silver braid/, 'description verbatim from legend')
  const pier = assets.find((a) => a.slug === 'pier')
  assert.equal(pier.kind, 'location')
  assert.ok(!/LOCATION/.test(pier.description), 'trailing ", LOCATION" stripped from description')
  assert.match(pier.description, /sodium lamps/)
  // Legend lines after the first scene are NOT legend (normal script text).
  const script2 = 'Scene 1: T\nShot 1: Wide\nArtist: rose\nKeyframe: x\nMotion: y\nCHARACTER: late — not a legend line'
  assert.equal(parseAssetLegendLines(script2).length, 0, 'post-scene CHARACTER: lines are not legend')
  // Parser return shape stays a bare scenes Array with .assets attached.
  const parsed = parseStructuredDirectorScript(script)
  assert.ok(Array.isArray(parsed), 'parser still returns a scenes array')
  assert.equal(parsed.assets.length, 4, 'parsed.assets carries the legend')
  assert.equal(parsed.length, 1, 'legend lines are not parsed as a scene')
})

test('detection: legend is authoritative — no section-header leakage, verbatim names', () => {
  const script = [
    'CHARACTER: rose — lead singer, silver braid',
    'LOCATION: pier : midnight pier with fog , LOCATION',
    'Shot type: b_roll',
    'CONTINUITY RULES',
    'DIRECTOR STEER',
    '',
    'Scene 1: Test',
    'Shot 1: Wide',
    'Artist: rose',
    'Keyframe: Rose stands on the midnight pier under CONTINUITY RULES lighting',
    'Motion: wind',
    'Shot 2: Close',
    'Artist: rose',
    'Keyframe: Rose\u2019s hands on the midnight pier, DIRECTOR STEER framing',
    'Motion: still',
  ].join('\n')
  const parsed = parseStructuredDirectorScript(script)
  const detection = detectScriptGaps({ scenes: parsed, warnings: [], cast: [], library: EMPTY_LIB, assets: parsed.assets })

  // The three fake "locations" from the earlier bug must not appear.
  const locNames = detection.locations.map((l) => l.name).join('|').toLowerCase()
  assert.ok(!locNames.includes('shot type'), 'no "shot type" leak')
  assert.ok(!locNames.includes('continuity rules'), 'no CONTINUITY RULES leak')
  assert.ok(!locNames.includes('director steer'), 'no DIRECTOR STEER leak')
  const pier = detection.locations.find((l) => l.slug === 'pier')
  assert.ok(pier, 'pier detected via legend')
  assert.equal(pier.legend, true, 'pier flagged as legend-sourced')
  assert.match(pier.description, /fog/, 'legend description is verbatim, name relates to description')
  const stubs = buildStubUpserts({ detection, library: EMPTY_LIB, scenes: parsed })
  const pierStub = stubs.find((s) => s.slug === 'pier')
  assert.match(pierStub.description, /midnight pier/, 'stub seeded from legend description')
  const roseStub = stubs.find((s) => s.slug === 'rose')
  assert.match(roseStub.description, /silver braid/, 'character stub seeded from legend (Generate-all can queue)')
})

test('detection: legend entry suppresses the same-slug heuristic guess', () => {
  // Quoted "lantern" in shot text is a heuristic candidate (quoted-phrase
  // path); the legend declares the same slug — the legend entry must win
  // and the heuristic must not produce a duplicate.
  const script = [
    'PROP: lantern : iron lantern with cracked glass , PROP',
    '',
    'Scene 1: Test',
    'Shot 1: Wide',
    'Artist: n/a',
    'Keyframe: A "lantern" glows on the table while the other "lantern" flickers',
    'Motion: flame',
    'Shot 2: Close',
    'Artist: n/a',
    'Keyframe: The "lantern" cracked glass rattles on the table',
    'Motion: wind',
    'Shot 3: Detail',
    'Artist: n/a',
    'Keyframe: Close-up of the "lantern" glass, green label',
    'Motion: flame flicker',
  ].join('\n')
  const parsed = parseStructuredDirectorScript(script)
  const detection = detectScriptGaps({ scenes: parsed, warnings: [], cast: [], library: EMPTY_LIB, assets: parsed.assets })
  const lanterns = detection.props.filter((p) => p.slug === 'lantern')
  assert.equal(lanterns.length, 1, 'legend + heuristic for same slug collapse to one entry')
  assert.equal(lanterns[0].legend, true, 'the surviving entry is the legend one')
  assert.match(lanterns[0].description, /iron lantern/, 'legend description wins, not the shot-text quote')
  // Without the legend, the heuristic still finds it (fallback retained).
  // The cross-kind de-dup prefers the location reading, so accept either.
  const detectionNoLegend = detectScriptGaps({ scenes: parsed, warnings: [], cast: [], library: EMPTY_LIB, assets: [] })
  assert.ok([...detectionNoLegend.props, ...detectionNoLegend.locations].some((p) => p.slug === 'lantern'), 'heuristic fallback still finds the quoted phrase without a legend')
})

test('library: updateIdentity renames name + slug, collision-safe', () => {
  const lib0 = EMPTY_LIB
  let lib = upsertLibraryEntry(lib0, { kind: 'location', slug: 'pier', name: 'pier', description: 'fog' }).library
  lib = upsertLibraryEntry(lib, { kind: 'location', slug: 'docks', name: 'docks', description: 'salt' }).library

  // Display-name rename is free-form.
  let r = updateEntryIdentity(lib, lib.locations[0].id, { name: 'The Midnight Pier' })
  assert.equal(r.ok, true, 'name rename accepted')
  lib = r.library
  assert.equal(lib.locations.find((e) => e.slug === 'pier').name, 'The Midnight Pier')

  // Free slug rename works.
  r = updateEntryIdentity(lib, lib.locations[1].id, { slug: 'harbor' })
  assert.equal(r.ok, true, 'free slug rename accepted')
  lib = r.library
  assert.ok(lib.locations.some((e) => e.slug === 'harbor'))

  // Collision: docks\u2192pier (taken by the first entry).
  r = updateEntryIdentity(lib, lib.locations.find((e) => e.slug === 'harbor').id, { slug: 'pier' })
  assert.equal(r.ok, false, 'colliding slug rejected')
  assert.equal(r.reason, 'slug-taken')
  // Not-found and empty-slug guards.
  assert.equal(updateEntryIdentity(lib, 'chr_doesnotexist', { name: 'x' }).ok, false)
  assert.equal(updateEntryIdentity(lib, lib.locations[0].id, { slug: '   ' }).ok, false)
})

// ── 0.4.7: inline asset directives (Perchance LTX director-list format) ──

test('parser: inline LOCATION/PROP/CHARACTER directives inside keyframes are extracted', () => {
  const script = [
    'Shot 1: A',
    'Start at: 0:00',
    'Keyframe prompt: LOCATION: neon-phone-booth: rain-slick street, sodium-lamp glow, wet asphalt, establish architecture, spatial relationships, surfaces, atmosphere and environmental depth before any subject. CHARACTER: no person visible; empty environment only.',
    'Length: 3',
    '',
    'Shot 2: B',
    'Start at: 0:03',
    'Keyframe prompt: PROP: old-cassette: worn cassette tape with green-glowing label. CHARACTER: rose: the lead singer, silver braid, kind eyes.',
    'Length: 3',
  ].join('\n')
  const assets = parseInlineAssetDirectives(script)
  const bySlug = new Map(assets.map((a) => [`${a.kind}:${a.slug}`, a]))
  assert.ok(bySlug.has('location:neon-phone-booth'), 'inline location found')
  assert.equal(bySlug.get('location:neon-phone-booth').description, 'rain-slick street, sodium-lamp glow, wet asphalt', 'boilerplate stripped')
  assert.ok(bySlug.has('prop:old-cassette'), 'inline prop found')
  assert.ok(bySlug.has('character:rose'), 'inline character found')
  assert.ok(!assets.some((a) => a.kind === 'character' && /no person/i.test(a.description)), 'negative CHARACTER directive skipped')
})

test('detection: inline directives become authoritative gaps and kill structural fakes', () => {
  const script = [
    'Shot 1: A',
    'Start at: 0:00',
    'Shot type: b_roll',
    'Keyframe prompt: LOCATION: neon-phone-booth: rain-slick street, sodium-lamp glow, wet asphalt. LIGHTING: script; use "Shot type: b_roll" for every shot). - The script timeline MUST cover the full audio duration.',
    'Length: 3',
    '',
    'Shot 2: B',
    'Start at: 0:03',
    'Shot type: b_roll',
    'Keyframe prompt: LOCATION: neon-phone-booth: rain-slick street, sodium-lamp glow, wet asphalt. STYLE: cinematic photoreal keyframe matching the brief\'s STYLE/TAGS.',
    'Length: 3',
  ].join('\n')
  const scenes = parseStructuredDirectorScript(script)
  const assets = parseInlineAssetDirectives(script)
  assert.equal(assets.length, 1, 'deduped to one asset across two shots')
  const detection = detectScriptGaps({ scenes, warnings: [], cast: [], library: { characters: [], props: [], locations: [] }, assets })
  const slugs = detection.gaps.map((g) => g.slug)
  assert.ok(slugs.includes('neon-phone-booth'), 'inline asset is a gap')
  assert.ok(!slugs.some((s) => /shot|type|continuity|steer|timeline|rules/i.test(s)), `no structural fakes, got ${JSON.stringify(slugs)}`)
})
// ── 0.4.8: flatten pass-through for location reference resolution ─────────
test('flatten: variants carry location/reference fields the queue resolver needs', () => {
  const plan = [scene([{
    id: 'S1_SH1',
    index: 1,
    imageBeat: 'LOCATION: neon-phone-booth: rain-slick street, sodium-lamp glow',
    videoBeat: 'ONE action: slow zoom on the neon booth',
    durationSeconds: 4,
    angles: ['Medium shot'],
    takesPerAngle: 1,
    // Plan-level fields the queue reads (0.4.8 location threading).
    keyframePromptRaw: 'LOCATION: neon-phone-booth: rain-slick street',
    motionPromptRaw: 'ONE camera move: 35mm, slow zoom',
    resolvedArtistAssetIds: ['img_a', 'img_b', 'img_c'],
    resolvedLocationAssetId: 'loc_wide_1',
  }])]
  const variants = flattenYoloPlanVariants(plan)
  assert.equal(variants.length, 1)
  const v = variants[0]
  assert.equal(v.resolvedLocationAssetId, 'loc_wide_1', 'planned location id survives flatten')
  assert.match(v.keyframePromptRaw, /LOCATION: neon-phone-booth/, 'raw keyframe text survives flatten')
  assert.match(v.motionPromptRaw, /35mm/, 'raw motion text survives flatten')
  assert.deepEqual(v.resolvedArtistAssetIds, ['img_a', 'img_b'], 'artist ids still capped at 2')
})
