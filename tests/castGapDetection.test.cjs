/**
 * Cast / Director-Script gap detection (0.4.4 → 0.5.x regression suite)
 *
 * Why this file exists: the 0.5.0 upstream-base swap of GenerateWorkspace.jsx
 * deleted the gap-detection wiring, and nothing looked broken. A component mounted
 * without `assetLibraryGapDetection` just skips its panel — no error, no console
 * warning, no failed build. The "Detected from your Director Script / Add to Cast"
 * panel was dead in a shipped build for exactly that reason.
 *
 * Three layers are covered, because the bug could hide in any of them:
 *  (A) BEHAVIOUR — the real modules (script parser → gap detector → stub builder →
 *      Cast store → localStorage) turn a Director Script into Cast entries.
 *  (B) DECISIONS — the seam the workspace calls: which script counts as active,
 *      when there is no panel at all, and when a stub must not be auto-created.
 *  (C) WIRING — the compiled props object of the music-video element, proving the
 *      detection and the Add-to-Cast action actually reach the panel.
 *
 * The gap maths itself has its own suite: src/services/scriptGapDetection.test.mjs.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { buildSync, transformSync } = require('esbuild')

const SRC = path.join(__dirname, '..', 'src')

// ── (A) the real modules, loaded the way the bundle loads them ───────────────
// src/**.js is ESM with no build step at test time, so esbuild bundles each entry
// and every bundle shares ONE vm context with a fake localStorage — the store and
// the persistence service then look at the same stored library, like the renderer.
const storage = new Map()
const context = {
  console,
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  require: (name) => require(name),
  process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
}
vm.createContext(context)

function load(entry) {
  const result = buildSync({
    entryPoints: [path.join(SRC, entry)],
    bundle: true, write: false, format: 'cjs', platform: 'node',
    external: ['react'], logLevel: 'silent',
  })
  const mod = { exports: {} }
  context.module = mod
  context.exports = mod.exports
  vm.runInContext(result.outputFiles[0].text, context, { filename: entry })
  return mod.exports
}

const wiring = load('services/castGapDetectionWiring.js')
const yoloPlanning = load('utils/yoloPlanning.js')
const assetLibraryStore = load('stores/assetLibraryStore.js')

const SCRIPT = [
  'CHARACTER: Vera Kade | chr_vera_kade | lead singer, cropped charcoal jacket, silver microphone',
  'LOCATION: Pine Ridge | location_pine_ridge | dense pine forest at blue hour, fog on the ground',
  'PROP: Cassette Deck | prop_cassette_deck | worn cassette deck with a green-glowing label',
  '',
  'SCENE 1',
  'SHOT 1: wide of the pine forest, the cassette deck on a stump',
  '  Artist: Vera Kade',
  '  Keyframe: Vera Kade walks through the fog holding the cassette deck',
  '  Video: slow push in through the trees',
  'SHOT 2: close on the cassette deck spinning',
  '  Keyframe: macro of the cassette deck, green light pulsing',
  '  Video: rack focus to the fog behind',
].join('\n')

const ALT_SCRIPT = [
  'CHARACTER: Vera Kade | chr_vera_kade | lead singer in the charcoal jacket, rooftop light',
  'LOCATION: Night Rooftop | location_night_rooftop | wet rooftop, city neon behind the railing',
  '',
  'SCENE 1',
  'SHOT 1: the singer on the rooftop',
  '  Artist: Vera Kade',
  '  Keyframe: the singer leans on the railing under the neon',
].join('\n')

const CAST = [{ slug: 'chr_vera_kade', label: 'Vera Kade', assetId: 'asset-vega' }]

/** Everything the workspace would pass when the master pass is showing. */
function workspace({ plan, library = castLibrary(), altScripts = [], activeScriptId = '', cast = CAST } = {}) {
  return {
    isEnabled: true,
    script: SCRIPT,
    altScripts,
    activeScriptId,
    plan,
    warnings: [],
    cast,
    library,
  }
}

function plan() {
  const built = yoloPlanning.buildYoloPlanFromScript(SCRIPT, { shotsPerScene: 2, anglesPerShot: 1 })
  return Array.isArray(built) && built.length > 0
    ? built
    : [{ shots: [{ keyframePromptRaw: 'wide of the pine forest' }, { keyframePromptRaw: 'macro of the cassette deck' }] }]
}

function castLibrary() {
  return assetLibraryStore.useAssetLibraryStore.getState().library
}

function entries(library = castLibrary()) {
  return Array.from(assetLibraryStore.allLibraryEntries(library))
}

function fresh(overrides = {}) {
  assetLibraryStore.useAssetLibraryStore.getState().reset()
  return { plan: plan(), ...overrides }
}

test('a Director Script that declares its cast, props and locations surfaces every reference-less one as a gap', () => {
  const state = fresh({ cast: [] })
  const detection = wiring.buildCastGapDetection(workspace(state))
  assert.ok(detection, 'the music flow with a plan must produce a detection object')
  const errors = Array.from(detection.legendIssues).filter((issue) => issue.severity === 'error')
  assert.equal(errors.length, 0, `fixture legend must be contract-clean: ${JSON.stringify(errors.map((i) => i.message))}`)
  assert.deepEqual(Array.from(detection.characters).map((g) => g.slug), ['chr_vera_kade'])
  assert.deepEqual(Array.from(detection.props).map((g) => g.slug), ['prop_cassette_deck'])
  assert.deepEqual(Array.from(detection.locations).map((g) => g.slug), ['location_pine_ridge'])
  // Verbatim wording: Cast must never paraphrase what the creator wrote.
  assert.equal(detection.locations[0].description, 'dense pine forest at blue hour, fog on the ground')
  assert.equal(detection.locations[0].matched, 'new', 'Cast has never seen it')
  assert.ok(Array.from(detection.gaps).every((gap) => gap.legend), 'a declared legend makes every auto-stub a declared asset')
})

test('"Add to Cast" creates Cast entries with the script wording, remembers the shots, and survives a reload', () => {
  const state = fresh({ cast: [] })
  const detection = wiring.buildCastGapDetection(workspace(state))
  const stubs = wiring.buildCastStubs({ detection, library: castLibrary(), scenes: state.plan })
  assert.equal(Array.from(stubs).length, 3, 'one stub per declared, reference-less asset')

  const result = assetLibraryStore.useAssetLibraryStore.getState().addMany(stubs)
  assert.equal(result.added, 3)
  assert.equal(result.total, 3)

  const location = entries().find((entry) => entry.slug === 'location_pine_ridge')
  assert.ok(location, 'the location landed in Cast')
  assert.equal(location.kind, 'location')
  assert.equal(location.description, 'dense pine forest at blue hour, fog on the ground')
  assert.ok(Array.isArray(location.provenance?.shots), 'Cast remembers which shots it came from')

  // Cast is global: it has to come back on the next launch.
  const reloaded = assetLibraryStore.useAssetLibraryStore.getState().reload()
  assert.equal(entries(reloaded).length, 3, 'Cast came back from storage')
  assert.ok(storage.has('belrog-asset-library-v1'), 'stored under the Belrog Cast key')
})

test('clicking "Add to Cast" again adds nothing and never pastes a description twice', () => {
  const state = fresh({ cast: [] })
  const first = wiring.buildCastStubs({
    detection: wiring.buildCastGapDetection(workspace(state)), library: castLibrary(), scenes: state.plan,
  })
  assetLibraryStore.useAssetLibraryStore.getState().addMany(first)

  const second = wiring.buildCastStubs({
    detection: wiring.buildCastGapDetection(workspace(state)), library: castLibrary(), scenes: state.plan,
  })
  const { added } = assetLibraryStore.useAssetLibraryStore.getState().addMany(second)
  assert.equal(added, 0, 'idempotent — the button cannot double-add')
  assert.equal(entries().length, 3)
  const character = entries().find((entry) => entry.kind === 'character')
  assert.equal(character.description.split('lead singer').length - 1, 1, 'the description was not appended twice')
})

test('a Cast entry that already has a picture is not offered again', () => {
  const state = fresh()
  const detection = wiring.buildCastGapDetection(workspace(state))
  assert.ok(Array.from(detection.characters).every((g) => g.slug !== 'chr_vera_kade'),
    'Vera is resolved cast with a reference image — not a gap')
  const stubs = wiring.buildCastStubs({ detection, library: castLibrary(), scenes: state.plan })
  assert.deepEqual(Array.from(stubs).map((s) => s.slug).sort(), ['location_pine_ridge', 'prop_cassette_deck'])
})

test('a Cast entry that gains a picture stops appearing on later passes', () => {
  const state = fresh({ cast: [] })
  const before = wiring.buildCastGapDetection(workspace(state))
  assert.ok(Array.from(before.characters).some((g) => g.slug === 'chr_vera_kade'), 'unresolved Artist names are gaps')
  const stubs = wiring.buildCastStubs({ detection: before, library: castLibrary(), scenes: state.plan })
  assetLibraryStore.useAssetLibraryStore.getState().addMany(stubs)
  const character = entries().find((entry) => entry.kind === 'character')
  assetLibraryStore.useAssetLibraryStore.getState().setAssetId(character.id, 'asset-vega')

  const after = wiring.buildCastGapDetection(workspace(state))
  assert.deepEqual(Array.from(after.characters).map((g) => g.slug), [], 'a character with a picture is not a gap')
})

// ── (B) the decisions the workspace makes every render ──────────────────────
test('there is no Cast panel outside the music flow or before a plan exists', () => {
  assert.equal(wiring.buildCastGapDetection({ ...workspace(fresh()), isEnabled: false }), null,
    'the ad and short-film flows have no Cast step')
  assert.equal(wiring.buildCastGapDetection({ ...workspace(fresh()), plan: [] }), null,
    'nothing is planned yet — nothing to detect')
  assert.equal(wiring.buildCastGapDetection({ ...workspace(fresh()), plan: undefined }), null)
})

test('detection follows the pass the creator is actually looking at', () => {
  // Vera is in the video's cast but Cast has no reference image for her yet.
  const state = fresh({
    cast: [{ slug: 'chr_vera_kade', label: 'Vera Kade' }],
    altScripts: [{ id: 'alt-1', script: ALT_SCRIPT }],
    activeScriptId: 'alt-1',
  })

  // Master: she is already in this video's cast, so she is not a gap; the master
  // script's own locations are.
  const master = wiring.buildCastGapDetection(workspace({ ...state, activeScriptId: '' }))
  assert.deepEqual(Array.from(master.locations).map((g) => g.slug), ['location_pine_ridge'])
  assert.deepEqual(Array.from(master.characters).map((g) => g.slug), [],
    'a character already in this video cast is not reported as a gap')

  // Alt pass: its own script declares the assets that pass needs, and being in the
  // master cast does not mean this pass has a picture for them.
  const alt = wiring.buildCastGapDetection(workspace(state))
  assert.deepEqual(Array.from(alt.locations).map((g) => g.slug), ['location_night_rooftop'],
    'the alt pass declares its own location, not the master one')
  assert.deepEqual(Array.from(alt.characters).map((g) => g.slug), ['chr_vera_kade'],
    'an alt pass reports what that pass still needs a reference for')
})

test('auto-stub never invents Cast entries from guesses the script did not declare', () => {
  const state = fresh({ cast: [] })
  // The planner could not match "Artist: DJ Marlow" to a cast member. That is a
  // real gap for the button, but it is a GUESS — the script never declared him.
  const warnings = [{ shotIndex: 1, kind: 'unresolved-artist-override', raw: 'DJ Marlow', message: 'no match' }]
  const detection = wiring.buildCastGapDetection({ ...workspace(state), warnings })
  assert.ok(detection.legend.length > 0, 'the fixture declares a legend, so guesses must stay suggestions')

  const guessSlugs = (stubs) => Array.from(stubs).map((stub) => stub.slug)
  const auto = wiring.buildCastStubs({ detection, library: castLibrary(), scenes: state.plan, declaredOnly: true })
  const button = wiring.buildCastStubs({ detection, library: castLibrary(), scenes: state.plan })

  assert.ok(guessSlugs(button).some((slug) => slug.includes('marlow')),
    'the Add-to-Cast button offers everything the detector found')
  assert.ok(!guessSlugs(auto).some((slug) => slug.includes('marlow')),
    'the automatic pass must not create Cast entries from an unresolved name')
  assert.deepEqual(guessSlugs(auto).sort(), guessSlugs(button).filter((s) => !s.includes('marlow')).sort(),
    'everything auto-created is legend-declared')
  assert.ok(guessSlugs(auto).every((slug) => /^(chr_|location_|prop_)/.test(slug)),
    `auto-stub created an undeclared Cast entry: ${JSON.stringify(guessSlugs(auto))}`)
})

test('auto-stub still works for a script that declares no legend at all', () => {
  const state = fresh()
  const plain = 'SCENE 1\nSHOT 1: a lighthouse on a cliff\n  Keyframe: waves break under the lighthouse\n'
  const detection = wiring.buildCastGapDetection({
    ...workspace(state), script: plain, altScripts: [], activeScriptId: '', cast: [],
  })
  assert.equal(detection.legend.length, 0, 'no legend block in this script')
  const stubs = wiring.buildCastStubs({ detection, library: castLibrary(), scenes: state.plan, declaredOnly: true })
  const all = wiring.buildCastStubs({ detection, library: castLibrary(), scenes: state.plan })
  assert.deepEqual(Array.from(stubs).map((s) => s.slug).sort(), Array.from(all).map((s) => s.slug).sort(),
    'with nothing declared, the auto-stub path must not silently drop everything')
})

// ── (C) the wiring the merge deleted ────────────────────────────────────────
const WORKSPACE = path.join(SRC, 'components', 'GenerateWorkspace.jsx')

/**
 * The props literal of one JSX element, read out of the COMPILED component.
 * `prop={x}` compiles to `prop: x` inside createElement's second argument, so this
 * proves the prop reaches the component; brace-matching mistakes surface as an
 * esbuild syntax error rather than a silent pass. A plain text search would also
 * "pass" when the attribute sits in a comment or on a different component.
 */
function jsxProps(file, componentName) {
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'jsx', format: 'cjs' }).code
  const alias = new RegExp(`React\\.createElement\\(\\s*import_${componentName}(?:\\.default)?\\s*,\\s*\\{`)
  const match = alias.exec(code)
  if (!match) throw new Error(`${componentName} is not rendered with createElement in ${path.basename(file)} — check how it is mounted`)
  const open = match.index + match[0].length - 1
  let depth = 0
  let end = -1
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1
    else if (code[i] === '}') { depth -= 1; if (depth === 0) { end = i; break } }
  }
  assert.ok(end > 0, `unbalanced props object for ${componentName}`)
  const body = code.slice(open + 1, end)
  const keys = []
  let nested = 0
  let token = ''
  const flush = () => {
    const name = token.match(/^\s*(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*:?/)?.[1]
    if (name && token.trim().match(/^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*(:|,|$)/)) keys.push(name)
    token = ''
  }
  for (const char of body) {
    if (char === '{' || char === '(' || char === '[') nested += 1
    else if (char === '}' || char === ')' || char === ']') nested -= 1
    if (char === ',' && nested === 0) flush()
    else token += char
  }
  flush()
  return keys
}

test('the music-video panel is still handed the detection and the Add-to-Cast action', () => {
  const props = jsxProps(WORKSPACE, 'MusicVideoEasyMode')
  for (const required of ['assetLibraryGapDetection', 'onAddGapsToCast', 'yoloMusicAltScripts', 'yoloMusicResolvedCast']) {
    assert.ok(props.includes(required),
      `${required} is not passed to MusicVideoEasyMode — the panel renders dead, with no error and no warning`)
  }
})

const CAST_PANEL = path.join(SRC, 'components', 'panels', 'CastPanel.jsx')

test('the Cast panel queues "Generate all" through the capped preview, not its own loop', () => {
  const code = transformSync(fs.readFileSync(CAST_PANEL, 'utf8'), { loader: 'jsx', format: 'cjs' }).code
  assert.match(code, /buildRegenerateAllPreview\)?\(/,
    'CastPanel must use the tested preview builder — a hand-rolled loop has no queue cap')
  // The cap's VALUE is read from the source, not the compiled output: esbuild
  // rewrites literals, so 100000 comes out of the compiler as `1e5` and a naive
  // digit match reads it as 1. (Found by mutation — the test passed a broken file.)
  const panelSource = fs.readFileSync(CAST_PANEL, 'utf8')
  const capMatch = panelSource.match(/REGENERATE_ALL_CAP\s*=\s*([0-9][0-9_e]*(?:e[+-]?[0-9]+)?)/i)
  assert.ok(capMatch, 'the cap must be a named constant in the panel')
  const cap = Number(capMatch[1].replace(/_/g, ''))
  assert.ok(Number.isFinite(cap) && cap > 0 && cap <= 200,
    `the queue cap is ${cap} — one click must not flood the ComfyUI queue`)
  assert.match(code, /cap: REGENERATE_ALL_CAP/, 'the preview call must actually pass the cap')
  assert.doesNotMatch(code, /entries\.filter\(\(e\) => !e\.assetId/,
    'the old inline filter is back: it queues every entry at once, flooding the ComfyUI queue')
  // 0.5.0 note: buildRegenerateAllPreview had no production caller at all after
  // the upstream swap, so its cap and skipped-reasons were dead code.
  assert.match(code, /requestAssetLibraryReference\)?\(/, 'queued jobs must reach the Generate tab bridge')
})

test('the workspace calls the seam instead of a local copy of the logic', () => {
  const source = fs.readFileSync(WORKSPACE, 'utf8')
  assert.match(source, /from '\.\.\/services\/castGapDetectionWiring'/,
    'the gap rules live in the seam module; importing them is what keeps them tested')
  assert.match(source, /buildCastGapDetection\(\{/, 'the detection memo must actually run')
  assert.equal((source.match(/buildCastStubs\(\{/g) || []).length, 2,
    'both the auto-stub effect and the Add-to-Cast button must go through the seam')
  assert.match(source, /addCastEntries\(/, 'stubs are written through the Cast store, never a local copy')
  // The one contract the seam tests cannot reach: the effect that runs on every
  // plan rebuild must be the DECLARED-ONLY caller. Nothing in the render path is
  // executed by a test, so this stays a source check on purpose.
  assert.equal((source.match(/declaredOnly: true,/g) || []).length, 1,
    'exactly one caller (the auto-stub effect) must restrict to script-declared assets')
})
