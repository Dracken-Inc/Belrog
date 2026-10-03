/**
 * Director-script gap detection (C4, 0.4.1).
 *
 * Pure, testable, no DOM: given a parsed plan ({ scenes, warnings }) + the
 * current library + the active cast, report which entities the script uses
 * that the library has no reference for yet.
 *
 * Two extraction paths (round-3 addendum §A.3):
 *   1. CHARACTERS — deterministic, rides the existing `Artist:` / `[tag]`
 *      resolution. Every `unresolved-artist-override` / `unresolved-lyric-tag`
 *      warning is one character gap. Word-boundary and slug issues vanish
 *      because the format is token-based.
 *   2. PROPS / LOCATIONS — heuristic pass over shot descriptions (keyframe +
 *      motion prompt text + coverage labels). A candidate must:
 *        - be a quoted phrase ("...") or a multi-word capitalized proper
 *          noun (The Midnight Pier, Rusty's Garage)
 *        - appear in >= 2 distinct shots (Henry's filter: "used across
 *          multiple shots") or be already known to the library
 *          (known-but-unreferenced entities are gaps even in one shot —
 *          idempotency matters more than frequency here)
 *        - not be a character, a section marker ([Chorus]), or a stopword
 *      Results are ALWAYS proposals (matched: 'fuzzy') — the user confirms
 *      in the panel. Nothing auto-creates from the heuristic path alone;
 *      it only pre-fills the stubs.
 *
 * Output shapes feed straight into upsertLibraryEntry:
 *   { kind, name, slug, description (verbatim mentions, deduped), shots: number[],
 *     matched: 'exact' | 'fuzzy' | 'new', evidence: [{ shot, quote }] }
 */

export const GAP_KINDS = Object.freeze({ character: 'character', prop: 'prop', location: 'location' })

/** Structural lyric markers that must never become entity candidates. */
const SECTION_MARKERS = new Set([
  'verse', 'verse 1', 'verse 2', 'verse 3', 'chorus', 'pre-chorus', 'bridge',
  'intro', 'outro', 'hook', 'drop', 'breakdown', 'interlude', 'solo', 'reprise',
  'final chorus', 'build', 'fade out', 'spoken word', 'rap',
  // LTX director-script structural labels — never entities, even when they
  // echo inside keyframe/motion text (0.4.5 hotfix: these leaked as fake
  // locations with nonsense slugs).
  'shot type', 'continuity rules', 'director steer', 'camera', 'keyframe',
  'motion', 'b roll', 'b-roll', 'b_roll',
  // More LTX structural labels (0.4.8.2: "Purpose:" leaked as the fake
  // location "main-purpose" in the Director Suite golden fixture).
  'purpose', 'coverage', 'coverage type', 'coverage label', 'lyric moment',
  'start at', 'length', 'seed base', 'chain',
])

/** Words that look like entities but describe generic things. */
const STOPWORD_HEADS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'some', 'other', 'another',
  'one', 'two', 'three', 'four', 'five', 'night', 'day', 'time', 'place',
  'world', 'room', 'street', 'house', 'city', 'town', 'building', 'door',
  'wall', 'window', 'light', 'shadow', 'sun', 'moon', 'rain', 'fire', 'ice',
  'smoke', 'dust', 'blood', 'tears', 'eyes', 'hands', 'voice', 'heart', 'soul',
  'dream', 'memory', 'silence', 'sound', 'music', 'note', 'beat', 'bar', 'bass',
  'red', 'blue', 'green', 'black', 'white', 'gold', 'silver', 'broken', 'burning',
  'cold', 'dark', 'empty', 'old', 'new', 'last', 'first', 'final', 'big', 'small',
])

const QUOTED_RE = /"([^"]{3,80})"|“([^”]{3,80})”|'([^']{4,80})'/g
const PROP_NOUN_RE = /\b((?:[A-Z][a-zA-Z0-9'’.-]*\s){1,4}[A-Z][a-zA-Z0-9'’.-]*)\b/g

function normalizeKey(name = '') {
  // Underscores are MEANINGFUL in Henry's slug scheme (location_dpf, prop_lantern)
  // and must survive normalization so legend slugs, shot tokens, and library
  // entries byte-match after lowercasing. Only whitespace/other punctuation folds.
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
}

function shotTexts(shot) {
  return [
    shot?.keyframePromptRaw,
    shot?.motionPromptRaw,
    shot?.videoBeat,
    shot?.imageBeat,
    shot?.coverageLabel,
    shot?.shotType,
    shot?.notes,
    shot?.label,
  ].filter(Boolean).map((text) => String(text))
}

function flatShotList(scenes) {
  const flat = []
  let index = 0
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    for (const shot of Array.isArray(scene?.shots) ? scene.shots : []) {
      index += 1
      // Use a running 1-based counter (mirrors flatShotIndex in the plan
      // builders and the parser's warning shotIndex) instead of shot.index:
      // music-plan shots ALL carry index:1, and parser shots restart at 1
      // per scene — both collapse the multi-shot frequency filter and break
      // prop/location detection.
      flat.push({ shot, index })
    }
  }
  return flat
}

function isKnownEntity(library, kind, key) {
  const bucket = kind === 'character'
    ? (library?.characters || [])
    : kind === 'prop'
      ? (library?.props || [])
      : (library?.locations || [])
  return (Array.isArray(bucket) ? bucket : []).some((entry) => (
    normalizeKey(entry?.slug) === key || normalizeKey(entry?.name) === key
  ))
}

function collectCharacterGaps({ warnings, cast, library }) {
  const castSlugs = new Set((Array.isArray(cast) ? cast : [])
    .map((entry) => normalizeKey(entry?.slug || entry?.label)))
  const seen = new Map() // key -> gap
  for (const warning of Array.isArray(warnings) ? warnings : []) {
    if (warning?.kind !== 'unresolved-artist-override' && warning?.kind !== 'unresolved-lyric-tag') continue
    const name = String(warning?.raw || '').trim()
    if (!name || name === '*' || name === 'all' || name === 'artist') continue
    const key = normalizeKey(name)
    if (!key || castSlugs.has(key)) continue
    const shot = Number(warning?.shotIndex)
    const existing = seen.get(key)
    if (existing) {
      if (!existing.shots.includes(shot)) existing.shots.push(shot)
      continue
    }
    const libraryMatch = isKnownEntity(library, 'character', key)
      ? { matched: 'exact' }
      : { matched: 'new' }
    seen.set(key, {
      kind: 'character',
      name: prettyName(name),
      slug: key,
      description: '', // characters are described by their reference image, not by script quotes
      shots: [shot].filter(Number.isFinite),
      evidence: [{ shot, quote: `Artist: ${name}` }],
      ...libraryMatch,
    })
  }
  return [...seen.values()]
}

function prettyName(raw = '') {
  const text = String(raw || '').trim()
  if (!text) return ''
  return text.replace(/(^|\s|-)([a-z])/g, (match, lead, letter) => lead + letter.toUpperCase())
}

/**
 * Prop/location candidate collection: quoted phrases + multi-word proper
 * nouns from shot text. Frequency filter: >= 2 distinct shots, or already
 * known to the library (then even one mention is a gap).
 */
function collectPropLocationGaps({ scenes, library, kind, isLocationHint }) {
  const candidates = new Map() // key -> { name, shots:Set, quotes:Set, known }
  const flat = flatShotList(scenes)
  for (const { shot, index } of flat) {
    const texts = shotTexts(shot)
    const foundHere = new Map() // key -> quote
    for (const text of texts) {
      // source: 'quote' (explicit author callout) or 'noun' (capitalized
      // proper-noun heuristic). They get different stopword treatment below:
      // a quoted "the rain" is generic and dropped, but a capitalized
      // "The Midnight Pier" is a real proper noun and kept.
      const seenStopwordQuoted = new Set() // keys we dropped as stopword-headed quotes
      const pushCandidate = (raw, source) => {
        const cleaned = raw.replace(/^["'\s]+|["'\s.]+$/g, '')
        if (cleaned.length < 3 || cleaned.length > 60) return
        const key = normalizeKey(cleaned)
        if (!key) return
        if (SECTION_MARKERS.has(key) || SECTION_MARKERS.has(cleaned.toLowerCase())) return
        // Structural label with a value glued on: `Shot type: b_roll` normalizes
        // to "shot-type-b-roll", which misses the "shot type" blocklist entry.
        // Check the phrase head before the first colon too.
        const headPhrase = cleaned.toLowerCase().split(':')[0].trim()
        if (headPhrase && SECTION_MARKERS.has(headPhrase)) return
        const words = cleaned.toLowerCase().split(/\s+/)
        const stopwordHead = STOPWORD_HEADS.has(words[0])
        if (stopwordHead && source === 'quote') {
          // A quoted stopword-headed phrase ("the rain") is generic. Remember
          // it so we don't resurrect it unless a proper noun also saw it.
          seenStopwordQuoted.add(key)
          return
        }
        if (words.length === 1 && key.length < 4) return
        if (words.length > 4) return
        // Proper-noun source can rescue a stopword-headed key (the author
        // wrote "The Midnight Pier" capitalized) — drop the block.
        if (source === 'noun' && seenStopwordQuoted.has(key)) seenStopwordQuoted.delete(key)
        if (foundHere.has(key)) return
        foundHere.set(key, cleaned)
      }
      let match
      QUOTED_RE.lastIndex = 0
      while ((match = QUOTED_RE.exec(text)) !== null) {
        pushCandidate((match[1] || match[2] || match[3] || '').trim(), 'quote')
      }
      PROP_NOUN_RE.lastIndex = 0
      while ((match = PROP_NOUN_RE.exec(text)) !== null) {
        pushCandidate(match[1].trim(), 'noun')
      }
    }
    for (const [key, quote] of foundHere.entries()) {
      const entry = candidates.get(key) || {
        name: '',
        slug: key,
        shots: new Set(),
        quotes: new Set(),
        known: isKnownEntity(library, kind, key) || isKnownEntity(library, kind === 'prop' ? 'location' : 'prop', key),
      }
      entry.shots.add(index)
      entry.quotes.add(quote)
      if (quote.length > entry.name.length) entry.name = quote
      candidates.set(key, entry)
    }
  }
  const gaps = []
  for (const [key, entry] of candidates.entries()) {
    // Henry's filter: used across multiple shots — OR already known to the
    // library (a known entity with one mention still needs its reference).
    if (entry.shots.size < 2 && !entry.known) continue
    // Character names that slipped through Artist: resolution are handled by
    // the deterministic path; skip single-word all-caps that look like names
    // (initials, stage names) to keep this pass about props/locations.
    if (entry.name.split(/\s+/).length === 1 && entry.known === false && entry.shots.size < 3) continue
    const matched = entry.known ? 'exact' : 'fuzzy'
    gaps.push({
      kind,
      name: entry.name,
      slug: key,
      description: descriptionFromQuotes([...entry.quotes]),
      shots: [...entry.shots].sort((a, b) => a - b),
      evidence: [...entry.quotes].slice(0, 4).map((quote) => ({ shot: null, quote })),
      matched,
    })
  }
  return gaps.sort((a, b) => b.shots.length - a.shots.length)
}

function descriptionFromQuotes(quotes = []) {
  // Verbatim, deduped — the director's own words are the generation prompt
  // seed. Cap the seed so a 100-shot script doesn't produce a 5KB prompt.
  const seen = new Set()
  const lines = []
  for (const quote of quotes) {
    const key = String(quote || '').trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    lines.push(String(quote).trim())
    if (lines.length >= 6) break
  }
  const joined = lines.join('. ')
  return joined.length > 600 ? `${joined.slice(0, 597)}...` : joined
}

/**
 * Run gap detection over a parsed plan.
 *
 * @param {object} args
 * @param {Array}  args.scenes   parsed plan scenes (buildMusicVideoPlanFromScript)
 * @param {Array}  args.warnings  parser warnings (carries unresolved-artist signals)
 * @param {Array}  args.cast      resolved cast roster [{slug,label,assetId}]
 * @param {object} args.library   { characters, props, locations }
 * @returns {{ gaps: Array, characters: Array, props: Array, locations: Array,
 *            stats: {scenes, shots, characterGaps, propLocationGaps} }}
 */
export function detectScriptGaps({ scenes, warnings, cast, library, assets }) {
  const flat = flatShotList(scenes)
  const characterGaps = collectCharacterGaps({ warnings, cast, library })
  const propGaps = collectPropLocationGaps({ scenes, library, kind: 'prop' })
  const locationGaps = collectPropLocationGaps({ scenes, library, kind: 'location' })
  // Authoritative asset legend (0.4.5): the script may declare its cast/props/
  // locations explicitly at the top (CHARACTER:/LOCATION:/PROP: lines). These
  // override heuristic guesses — verbatim slug + description, and their slugs
  // suppress same-named heuristic candidates.
  const legend = Array.isArray(assets) ? assets
    : (scenes && Array.isArray(scenes.assets) ? scenes.assets : [])
  const legendByKind = { character: [], prop: [], location: [] }
  for (const entry of legend) {
    if (entry?.kind && legendByKind[entry.kind]) legendByKind[entry.kind].push(entry)
  }
  const characterGapsWithLegend = applyLegendToCharacterGaps({ characterGaps, legend: legendByKind.character, cast, library })
  const legendPropGaps = collectLegendGaps({ legend: legendByKind.prop, library, kind: 'prop' })
  const legendLocationGaps = collectLegendGaps({ legend: legendByKind.location, library, kind: 'location' })
  const legendKeys = new Set(legend.flatMap((e) => [e?.slug ? normalizeKey(e.slug) : ''] + (e?.name ? [normalizeKey(e.name)] : [])).filter(Boolean))
  // Slug -> declared kind, for cross-kind promotion in the merge below.
  // Note: slug keys only — an asset's display NAME may collide with a
  // different asset's slug (e.g. a location "greenhouse" and a prop named
  // "Greenhouse Gases"), and only real slug identity counts as declared.
  const legendKindMap = new Map()
  for (const entry of legend) {
    const k = entry?.slug ? normalizeKey(entry.slug) : ''
    if (k && entry?.kind) legendKindMap.set(k, entry.kind)
  }
  function legendKindFor(slug) { return legendKindMap.get(slug) }
  function legendDescriptionFor(slug) {
    const entry = legend.find((e) => normalizeKey(e?.slug || e?.name || '') === slug)
    return String(entry?.description || '').trim()
  }
  function legendDeclaredKind(slug) { return legendKindMap.get(slug) }

  // De-dup across prop/location: the same phrase can't be both — prefer the
  // location reading when coverage text mentions place words, else prop.
  const seenKeys = new Map()
  const merged = []
  for (const gap of [...locationGaps, ...propGaps]) {
    if (legendKeys.has(gap.slug)) continue // author declared it — legend wins
    if (seenKeys.has(gap.slug)) {
      // A heuristic phrase can surface as BOTH a prop and a location
      // ("lantern" in 3+ shots) while the author declared it as exactly one
      // kind. When that declared kind is the one we skipped first, promote
      // the surviving entry — otherwise the legend entry is lost and the
      // wrong kind remains.
      const kindFix = legendKindFor(gap.slug, legendByKind)
      if (kindFix && seenKeys.get(gap.slug) !== kindFix) {
        seenKeys.set(gap.slug, kindFix)
        merged.push({ ...gap, kind: kindFix, description: legendDescriptionFor(gap.slug, legendByKind) || gap.description, legend: true })
      }
      continue
    }
    seenKeys.set(gap.slug, gap.kind)
    merged.push(gap)
  }
  // Add legend entries for this kind, but only if they don't already have
  // an asset reference in the library (same rule as heuristic gaps).
  for (const gap of [...legendLocationGaps, ...legendPropGaps]) {
    if (seenKeys.has(gap.slug)) continue
    // Legend entries are authoritative — they always win over heuristic,
    // even if the library already knows about the entity.
    seenKeys.set(gap.slug, gap.kind)
    merged.push(gap)
  }

  const all = [...characterGapsWithLegend, ...merged]
  return {
    gaps: all,
    characters: characterGapsWithLegend,
    props: merged.filter((gap) => gap.kind === 'prop'),
    locations: merged.filter((gap) => gap.kind === 'location'),
    legend: legend,
    stats: {
      scenes: (Array.isArray(scenes) ? scenes : []).length,
      shots: flat.length,
      characterGaps: characterGapsWithLegend.length,
      propLocationGaps: merged.length,
      legend: legend.length,
    },
  }
}

/**
 * Legend gaps are authoritative: the author declared slug + description, so
 * matched is 'exact' (known) or 'new' (unknown) — never 'fuzzy'. An entry
 * that already has a reference in the library is not a gap (same rule as
 * the heuristic path). Character legend entries also upgrade same-slug
 * heuristic character gaps (unresolved Artist:) with the legend's verbatim
 * description and exact match status.
 */
function collectLegendGaps({ legend, library, kind }) {
  const gaps = []
  for (const entry of Array.isArray(legend) ? legend : []) {
    if (entry?.kind !== kind) continue
    const key = normalizeKey(entry?.slug || entry?.name || '')
    if (!key) continue
    const bucket = kind === 'prop' ? library?.props : library?.locations
    const existing = (Array.isArray(bucket) ? bucket : []).find(
      (e) => normalizeKey(e?.slug || e?.name) === key
    )
    if (existing?.assetId) continue // already has a reference — not a gap
    gaps.push({
      kind,
      name: String(entry?.name || entry?.slug || '').trim(),
      slug: key,
      description: String(entry?.description || '').trim(),
      shots: [],
      evidence: [{ shot: null, quote: `Declared in asset legend (${kind})` }],
      matched: existing ? 'exact' : 'new',
      legend: true,
    })
  }
  return gaps
}

function applyLegendToCharacterGaps({ characterGaps, legend, cast, library }) {
  const upgraded = characterGaps.map((gap) => {
    const match = (Array.isArray(legend) ? legend : []).find(
      (e) => normalizeKey(e?.slug || e?.name || '') === gap.slug
    )
    if (!match) return gap
    return {
      ...gap,
      description: String(match?.description || '').trim() || gap.description,
      matched: 'exact', // author declared this cast member explicitly
      legend: true,
    }
  })
  // Legend cast members NOT surfaced by any unresolved-artist warning (already
  // resolved, or never mentioned in a shot): still gaps if reference-less.
  const seen = new Set(upgraded.map((g) => g.slug))
  for (const entry of Array.isArray(legend) ? legend : []) {
    const key = normalizeKey(entry?.slug || entry?.name || '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    const inCast = (Array.isArray(cast) ? cast : []).some(
      (c) => normalizeKey(c?.slug || c?.label) === key
    )
    if (inCast) continue // resolved cast member — the script routes shots to it
    const existing = (Array.isArray(library?.characters) ? library.characters : [])
      .find((e) => normalizeKey(e?.slug || e?.name) === key)
    if (existing?.assetId) continue // already has a reference — not a gap
    upgraded.push({
      kind: 'character',
      name: String(entry?.name || entry?.slug || '').trim(),
      slug: key,
      description: String(entry?.description || '').trim(),
      shots: [],
      evidence: [{ shot: null, quote: 'Declared in asset legend (character)' }],
      matched: existing ? 'exact' : 'new',
      legend: true,
    })
  }
  return upgraded
}

/**
 * Build the list of stubs to upsert for a detection result. Only entries the
 * library does NOT already have (matched: 'new' or known-but-unreferenced).
 * Matched-'exact' entries with an assetId are skipped entirely (no gap).
 */
export function buildStubUpserts({ detection, library, scenes }) {
  // For character gaps (whose detection description is intentionally empty —
  // characters are described by their reference image, not script quotes),
  // seed the stub description from the first keyframe text the character
  // appears in. Without this, "Generate all" skips every detected character
  // (needs-description) and the auto-stub flow breaks at exactly the step
  // the user needs: parse script → stubs → generate references later.
  const shotKeyframes = []
  if (Array.isArray(scenes)) {
    // Running 1-based counter across all shots in flatten order — the same
    // numbering flatShotList uses for gap.shots, and the same numbering the
    // plan builders / parser carry in warning.shotIndex (flatShotIndex).
    // We do NOT trust shot.index: music-plan shots all carry index:1 and
    // parser shots restart at 1 per scene.
    let running = 0
    for (const scene of scenes) {
      for (const shot of Array.isArray(scene?.shots) ? scene.shots : []) {
        running += 1
        shotKeyframes.push({
          index: running,
          text: String(shot?.keyframePromptRaw || shot?.imageBeat || shot?.referenceImagePrompt || '').trim(),
        })
      }
    }
  }
  const seedDescriptionForCharacter = (gap) => {
    // Strongest signal first: a keyframe that actually MENTIONS the entity's
    // name (identity anchor). Then fall back to the first gap shot's keyframe.
    const key = normalizeKey(gap?.name || '')
    for (const shotIndex of (Array.isArray(gap?.shots) ? gap.shots : [])) {
      const kf = shotKeyframes.find((s) => s.index === shotIndex && s.text && key && s.text.toLowerCase().includes(key))
      if (kf) {
        return kf.text.length > 140 ? kf.text.slice(0, 137).trimEnd() + '…' : kf.text
      }
    }
    for (const shotIndex of (Array.isArray(gap?.shots) ? gap.shots : [])) {
      const kf = shotKeyframes.find((s) => s.index === shotIndex && s.text.length >= 12)
      if (kf) {
        return kf.text.length > 140 ? kf.text.slice(0, 137).trimEnd() + '…' : kf.text
      }
    }
    // No shot-index match — last resort: first keyframe that mentions the name.
    for (const kf of shotKeyframes) {
      if (kf.text && key && kf.text.toLowerCase().includes(key)) {
        return kf.text.length > 140 ? kf.text.slice(0, 137).trimEnd() + '…' : kf.text
      }
    }
    return ''
  }

  const stubs = []
  for (const gap of detection.gaps) {
    const bucket = gap.kind === 'character' ? library?.characters
      : gap.kind === 'prop' ? library?.props
        : library?.locations
    const existing = (Array.isArray(bucket) ? bucket : []).find(
      (entry) => normalizeKey(entry?.slug || entry?.name) === gap.slug
    )
    if (existing?.assetId) continue // already has a reference — not a gap
    // Character detection descriptions are intentionally empty; prop/location
    // descriptions are the verbatim quoted phrase (often just the name).
    // Either way the seed is thin, so fill/replace it from the shot keyframe
    // text — that's what "Generate all" turns into the reference prompt.
    // A richer verbatim description (longer than the name) is kept as-is,
    // and existing entries keep their description (upsert merges).
    const nameLen = (gap.name || '').length
    const thinDescription = gap.description && gap.description.length <= nameLen + 2
    const seededDescription = thinDescription
      ? (seedDescriptionForCharacter(gap) || gap.description)
      : (gap.description || (gap.kind === 'character' ? seedDescriptionForCharacter(gap) : ''))
    stubs.push({
      kind: gap.kind,
      name: gap.name,
      slug: gap.slug,
      description: seededDescription,
      // Legend-declared = the script's own asset block named it. Heuristic
      // guesses are suggestion-only once a legend exists (format-directive
      // contract: never auto-stub from prose).
      legendDeclared: gap.legend === true,
      provenance: {
        source: gap.legend === true ? 'asset-legend' : 'director-script',
        scriptVersion: null, // caller stamps from the plan signature
        shots: gap.shots,
      },
      gap: {
        source: 'director-script',
        shotRefs: gap.shots,
        matched: existing ? (gap.matched === 'exact' ? 'exact' : 'fuzzy') : 'new',
        detectedAt: new Date().toISOString(),
      },
    })
  }
  return stubs
}

/**
 * Regenerate-All preview (the house previewOnly pattern, §A.1.6):
 * every stub WITHOUT a reference, the exact prompt that will be used,
 * skipped-with-reason for description-less entries, and a queue cap.
 */
export function buildRegenerateAllPreview({ library, cap = 50 }) {
  const all = [
    ...(Array.isArray(library?.characters) ? library.characters : []),
    ...(Array.isArray(library?.props) ? library.props : []),
    ...(Array.isArray(library?.locations) ? library.locations : []),
  ]
  const items = []
  const skipped = []
  for (const entry of all) {
    if (entry?.assetId) continue // already has a reference
    const prompt = buildReferencePrompt(entry)
    if (!prompt) {
      skipped.push({ id: entry.id, name: entry.name, kind: entry.kind, reason: 'needs-description' })
      continue
    }
    items.push({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      prompt,
      negative: referenceNegative(entry.kind),
      shots: entry?.provenance?.shots || entry?.gap?.shotRefs || [],
      estimatedSeconds: 45, // z-image-turbo single image, conservative
    })
  }
  const capped = items.length > cap
  return {
    items: items.slice(0, cap),
    remaining: items.length - Math.min(items.length, cap),
    capped,
    skipped,
    totalEstimatedSeconds: items.slice(0, cap).reduce((sum, item) => sum + item.estimatedSeconds, 0),
  }
}

export function buildReferencePrompt(entry) {
  const base = String(entry?.description || '').trim()
  if (!base) return null // §A.5.5: skip, don't generate garbage
  const kindLabel = entry.kind === 'character' ? 'character reference sheet'
    : entry.kind === 'prop' ? 'prop reference sheet'
      : 'location / environment reference sheet'
  const framing = entry.kind === 'character'
    ? 'Full-body character reference sheet, neutral pose, clean background, consistent identity from every angle, studio lighting'
    : entry.kind === 'prop'
      ? 'Product-style prop reference on a neutral seamless background, sharp detail, catalog lighting'
      : 'Wide establishing shot of the location, no people, full environment visible, consistent geography, cinematic natural lighting'
  const text = `${kindLabel}: ${base}. ${framing}. Photorealistic, high detail.`
  return text.length > 800 ? `${text.slice(0, 797)}...` : text
}

export function referenceNegative(kind) {
  if (kind === 'character') {
    return 'text, watermark, extra people, cropped head, deformed hands, extra fingers, inconsistent face'
  }
  if (kind === 'prop') {
    return 'text, watermark, people, cluttered background, blurry'
  }
  return 'people, text, watermark, indoor-only framing, warped perspective'
}