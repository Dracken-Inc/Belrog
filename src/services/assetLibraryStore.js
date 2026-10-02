/**
 * Asset library store — global character / prop / location identities for the
 * Music Video Director flow (C4, 0.4.1).
 *
 * Design constraints (round-3 addendum §A.2, §A.5):
 *   - Immutable ids with kind prefixes: `chr_` / `prp_` / `loc_` + ULID.
 *   - One store, never forked: characters, props and locations share this
 *     shape so provenance and matching rules apply uniformly.
 *   - Stubs carry the director's VERBATIM words as `description` (the
 *     generation prompt seed) — the UI must not silently rewrite them.
 *   - `provenance` records where an entity came from (director-script gap
 *     detection vs manual) — provenance, not a second identity.
 *   - `gap` records the last detection verdict (matched: exact|fuzzy|new).
 *
 * Persistence: localStorage (renderer-only, no new deps, no build impact —
 * matches the app's existing settings-persistence pattern). The library is
 * GLOBAL by design (not per-project) so characters survive across projects;
 * JSON export/import is the escape hatch for backup and machine moves.
 */

const LIBRARY_STORAGE_KEY = 'belrog-asset-library-v1'
const MAX_LIBRARY_ENTRIES = 5000 // hard safety cap; export/import is the path beyond it

const KIND_PREFIX = Object.freeze({
  character: 'chr_',
  prop: 'prp_',
  location: 'loc_',
})

const KIND_FROM_PREFIX = Object.freeze({
  chr: 'character',
  prp: 'prop',
  loc: 'location',
})

function safeStorage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    /* SSR / privacy mode */
  }
  return null
}

/**
 * Crockford-style base32 encode (alphabet `0-9a-v`, never `w-z`) for the
 * sortable timestamp portion. Manual (not `.toString(32)`) so the output
 * stays within the id alphabet and never gains a leading `-`.
 */
function encodeBase32(value, length) {
  const alphabet = '0123456789abcdefghijklmnopqrstuv'
  let out = ''
  let v = Math.max(0, Math.floor(value))
  while (v > 0) {
    out = alphabet[v % 32] + out
    v = Math.floor(v / 32)
  }
  return out.padStart(length, '0')
}

/**
 * ULID-ish unique id: sortable (48-bit ms timestamp, base32) + 16 random
 * chars. Deliberately dependency-free (no ULID package) — uniqueness for
 * library entries only, not a consensus system. Always `[prefix][0-9a-v]+`.
 */
export function makeEntityId(kind) {
  const prefix = KIND_PREFIX[kind] || 'ent_'
  // 13 base32 chars cover 48+ bits; Date.now() (~2^41) is far below that, so
  // the padded result is a stable, lexicographically-sortable timestamp.
  const timestamp = encodeBase32(Date.now(), 13)
  const alphabet = '0123456789abcdefghijklmnopqrstuv'
  let random = ''
  const randomView = typeof crypto !== 'undefined' && crypto.getRandomValues
    ? crypto.getRandomValues(new Uint8Array(16))
    : null
  for (let i = 0; i < 16; i += 1) {
    const value = randomView ? randomView[i] : Math.floor(Math.random() * 256)
    random += alphabet[value % 32]
  }
  return `${prefix}${timestamp}${random}`
}

function coerceEntry(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '').trim()
  const kind = KIND_FROM_PREFIX[id.slice(0, 3).toLowerCase()]
    || (['character', 'prop', 'location'].includes(raw.kind) ? raw.kind : null)
  if (!id || !kind) return null
  const name = String(raw.name || '').trim() || id
  const slug = String(raw.slug || '').trim().toLowerCase()
  return {
    id,
    kind,
    name,
    slug,
    label: String(raw.label || '').trim() || name,
    description: String(raw.description || '').trim(),
    assetId: String(raw.assetId || '').trim() || null,
    // assetId = null on stubs (no reference generated yet) — that is the
    // whole "stub" concept; Regenerate-All operates on exactly this state.
    provenance: raw.provenance && typeof raw.provenance === 'object'
      ? {
          source: String(raw.provenance.source || '').trim(),
          scriptVersion: raw.provenance.scriptVersion || null,
          shots: Array.isArray(raw.provenance.shots)
            ? raw.provenance.shots.map((shot) => Number(shot)).filter(Number.isFinite)
            : [],
          createdAt: raw.provenance.createdAt || null,
        }
      : { source: 'manual', scriptVersion: null, shots: [], createdAt: raw.createdAt || null },
    gap: raw.gap && typeof raw.gap === 'object'
      ? {
          detectedAt: raw.gap.detectedAt || null,
          source: String(raw.gap.source || 'director-script'),
          shotRefs: Array.isArray(raw.gap.shotRefs)
            ? raw.gap.shotRefs.map((shot) => Number(shot)).filter(Number.isFinite)
            : [],
          matched: ['exact', 'fuzzy', 'new'].includes(raw.gap.matched) ? raw.gap.matched : 'new',
        }
      : null,
    updatedAt: raw.updatedAt || raw.createdAt || null,
    _index: index,
  }
}

export function loadAssetLibrary() {
  const storage = safeStorage()
  if (!storage) return { characters: [], props: [], locations: [] }
  let raw = null
  try {
    raw = JSON.parse(storage.getItem(LIBRARY_STORAGE_KEY) || 'null')
  } catch {
    raw = null
  }
  const entries = Array.isArray(raw?.entries) ? raw.entries : []
  const characters = []
  const props = []
  const locations = []
  entries.forEach((entry, index) => {
    const coerced = coerceEntry(entry, index)
    if (!coerced) return
    if (coerced.kind === 'character') characters.push(coerced)
    else if (coerced.kind === 'prop') props.push(coerced)
    else locations.push(coerced)
  })
  return { characters, props, locations }
}

export function saveAssetLibrary(library) {
  const storage = safeStorage()
  if (!storage) return false
  const characters = Array.isArray(library?.characters) ? library.characters : []
  const props = Array.isArray(library?.props) ? library.props : []
  const locations = Array.isArray(library?.locations) ? library.locations : []
  const all = [...characters, ...props, ...locations]
  if (all.length > MAX_LIBRARY_ENTRIES) {
    return false // never silently truncate — force export/import beyond the cap
  }
  const entries = all.map(({ _index, ...entry }) => entry)
  try {
    storage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify({ version: 1, savedAt: Date.now(), entries }))
    return true
  } catch {
    return false // quota exceeded — export is the escape hatch
  }
}

/** Find an entry by id, or null. */
export function findLibraryEntry(library, id) {
  const all = [
    ...(Array.isArray(library?.characters) ? library.characters : []),
    ...(Array.isArray(library?.props) ? library.props : []),
    ...(Array.isArray(library?.locations) ? library.locations : []),
  ]
  return all.find((entry) => entry?.id === id) || null
}

/**
 * Upsert by slug (case/whitespace/hyphen-insensitive). Existing entries keep
 * their id and first-seen description unless `forceDescription` is set
 * (the explicit "refresh from script" action — never automatic, §A.5.3).
 * Returns the resulting entry + whether it was created.
 */
export function upsertLibraryEntry(library, { kind, name, slug, description = '', provenance = null, gap = null, forceDescription = false }) {
  const bucketKey = kind === 'character' ? 'characters' : kind === 'prop' ? 'props' : 'locations'
  const bucket = (Array.isArray(library?.[bucketKey]) ? library[bucketKey] : []).map((entry) => ({ ...entry }))
  const normalizedSlug = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const existingIndex = normalizedSlug
    ? bucket.findIndex((entry) => String(entry?.slug || '').trim().toLowerCase() === normalizedSlug)
    : -1
  const now = new Date().toISOString()
  if (existingIndex >= 0) {
    const existing = bucket[existingIndex]
    const keptDescription = String(existing?.description || '').trim()
    const mergedDescription = forceDescription
      ? String(description || '').trim()
      : (keptDescription && String(description || '').trim() && !keptDescription.includes(String(description || '').trim()))
        ? `${keptDescription} ${String(description || '').trim()}`
        : (keptDescription || String(description || '').trim())
    const mergedShots = new Set([
      ...(Array.isArray(existing?.provenance?.shots) ? existing.provenance.shots : []),
      ...(Array.isArray(provenance?.shots) ? provenance.shots : []),
    ])
    bucket[existingIndex] = {
      ...existing,
      description: mergedDescription,
      provenance: {
        ...existing.provenance,
        ...(provenance || {}),
        shots: [...mergedShots],
      },
      gap: gap || existing.gap,
      updatedAt: now,
    }
    return { entry: bucket[existingIndex], created: false, library: { ...library, [bucketKey]: bucket } }
  }
  const entry = {
    id: makeEntityId(kind),
    kind,
    name: String(name || '').trim() || normalizedSlug,
    slug: normalizedSlug,
    label: String(name || '').trim() || normalizedSlug,
    description: String(description || '').trim(),
    assetId: null,
    provenance: provenance
      ? { source: String(provenance.source || 'director-script'), scriptVersion: provenance.scriptVersion || null, shots: Array.isArray(provenance.shots) ? provenance.shots : [], createdAt: now }
      : { source: 'manual', scriptVersion: null, shots: [], createdAt: now },
    gap: gap || null,
    createdAt: now,
    updatedAt: now,
  }
  bucket.push(entry)
  return { entry, created: true, library: { ...library, [bucketKey]: bucket } }
}

/** Wire a generated reference image to an entry (or clear it). */
export function setEntryAssetId(library, id, assetId) {
  const found = findLibraryEntry(library, id)
  if (!found) return { library, changed: false }
  const kindKey = found.kind === 'character' ? 'characters' : found.kind === 'prop' ? 'props' : 'locations'
  const next = {
    ...library,
    [kindKey]: (library[kindKey] || []).map((entry) => (entry?.id === id
      ? { ...entry, assetId: assetId || null, updatedAt: new Date().toISOString() }
      : entry)),
  }
  return { library: next, changed: true }
}

/**
 * Rename an entry (display name and/or slug). Collision-safe: if the new slug
 * is already taken by a DIFFERENT entry in the same kind bucket, the rename is
 * rejected with { ok:false, reason } so the UI can tell the user. The entry's
 * own current slug always passes (a no-op). Display name is free-form.
 */
export function updateEntryIdentity(library, id, { name, slug } = {}) {
  const found = findLibraryEntry(library, id)
  if (!found) return { ok: false, reason: 'not-found' }
  const kindKey = found.kind === 'character' ? 'characters' : found.kind === 'prop' ? 'props' : 'locations'
  const bucket = library[kindKey] || []
  const normalized = String(slug ?? found.slug ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug != null && !normalized) return { ok: false, reason: 'empty-slug' }
  const collides = slug != null && normalized !== String(found.slug || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    ? bucket.some((entry) => entry?.id !== id
        && String(entry?.slug || '').toLowerCase().replace(/[^a-z0-9]+/g, '-') === normalized)
    : false
  if (collides) return { ok: false, reason: 'slug-taken' }
  const next = {
    ...library,
    [kindKey]: bucket.map((entry) => (entry?.id === id
      ? {
          ...entry,
          ...(name != null ? { name: String(name).trim() || entry.name, label: String(name).trim() || entry.label } : {}),
          ...(slug != null && normalized ? { slug: normalized } : {}),
          updatedAt: new Date().toISOString(),
        }
      : entry)),
  }
  return { ok: true, library: next }
}

/** Remove an entry by id. Manual-only — gap detection never deletes. */
export function removeLibraryEntry(library, id) {
  const kindKey = 'characters'
  const found = findLibraryEntry(library, id)
  if (!found) return { library, removed: false }
  const key = found.kind === 'character' ? 'characters' : found.kind === 'prop' ? 'props' : 'locations'
  return {
    library: { ...library, [key]: (library[key] || []).filter((entry) => entry?.id !== id) },
    removed: true,
    _dropKey: kindKey, // internal, stripped by consumers
  }
}

export function serializeLibraryForExport(library) {
  return JSON.stringify({
    format: 'belrog-asset-library',
    version: 1,
    exportedAt: new Date().toISOString(),
    entries: [
      ...(Array.isArray(library?.characters) ? library.characters : []),
      ...(Array.isArray(library?.props) ? library.props : []),
      ...(Array.isArray(library?.locations) ? library.locations : []),
    ].map(({ _index, ...entry }) => entry),
  }, null, 2)
}

/**
 * Parse an exported library file. Merge-safe: entries with a slug that
 * already exists locally keep the local id; unknown slugs are imported.
 * Returns { library, imported, skipped } — caller decides whether to save.
 */
export function importLibraryJson(text, intoLibrary = null) {
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Not valid JSON.' }
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    return { ok: false, error: 'Missing entries[] — is this a Belrog asset library export?' }
  }
  const base = intoLibrary || { characters: [], props: [], locations: [] }
  let imported = 0
  let skipped = 0
  let working = base
  for (const raw of parsed.entries) {
    const coerced = coerceEntry(raw, 0)
    if (!coerced) {
      skipped += 1
      continue
    }
    const { entry, created, library } = upsertLibraryEntry(
      working,
      {
        kind: coerced.kind,
        name: coerced.name,
        slug: coerced.slug,
        description: forceDescriptionFromImport(coerced, working),
        provenance: { ...coerced.provenance, source: `import:${coerced.provenance.source}` },
        gap: null,
        forceDescription: false,
      }
    )
    working = library
    // Preserve the imported reference binding when the local entry has none.
    if (coerced.assetId && !findLibraryEntry(working, entry.id)?.assetId) {
      const wired = setEntryAssetId(working, entry.id, coerced.assetId)
      working = wired.library
    }
    if (created) imported += 1
    else skipped += 1
  }
  return { ok: true, library: working, imported, skipped }
}

function forceDescriptionFromImport(coerced, working) {
  // On import, the imported description wins only if the local entry is
  // missing or description-less — never overwrite a director-verbatim text
  // the user has been iterating on.
  const existing = (working?.characters || []).concat(working?.props || [], working?.locations || [])
    .find((entry) => entry?.slug === coerced.slug)
  if (existing?.description) return ''
  return coerced.description
}