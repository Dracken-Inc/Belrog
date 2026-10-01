import { create } from 'zustand'
import {
  loadAssetLibrary,
  saveAssetLibrary,
  upsertLibraryEntry,
  setEntryAssetId,
  removeLibraryEntry,
  findLibraryEntry,
  importLibraryJson,
  serializeLibraryForExport,
  makeEntityId,
} from '../services/assetLibraryStore.js'

/**
 * Global asset-library store (characters / props / locations).
 *
 * This wraps the pure service module so that the LEFT-PANEL Cast tab and the
 * GENERATE workspace (gap detection + reference generation) share ONE library
 * in memory, and so a single persistence path (the service's localStorage)
 * stays authoritative. Every mutation runs the pure service function, commits
 * the result to memory, and persists through saveAssetLibrary — never
 * double-writing.
 *
 * `notice` is a transient { tone, text } toast shared across both surfaces.
 */

const EMPTY_LIBRARY = { characters: [], props: [], locations: [] }

function safeLoad() {
  try {
    return loadAssetLibrary()
  } catch {
    return { ...EMPTY_LIBRARY }
  }
}

export const useAssetLibraryStore = create((set, get) => ({
  library: safeLoad(),
  notice: null,

  // ── Notice (transient toast) ────────────────────────────────────────────
  setNotice(notice) {
    set({ notice })
  },
  clearNotice() {
    set({ notice: null })
  },

  // ── Core persistence ────────────────────────────────────────────────────
  commit(next) {
    const library = next && typeof next === 'object' ? next : { ...EMPTY_LIBRARY }
    set({ library })
    try {
      saveAssetLibrary(library)
    } catch {
      /* quota / storage unavailable — in-memory copy still holds */
    }
    return library
  },

  reload() {
    set({ library: safeLoad() })
    return get().library
  },

  // ── Single-entry mutations ──────────────────────────────────────────────
  /** Add or update one entry. Returns { entry, created }. */
  upsert({ kind, name, slug, description = '', provenance = null, gap = null, forceDescription = false }) {
    const { entry, created, library } = upsertLibraryEntry(get().library, {
      kind, name, slug, description, provenance, gap, forceDescription,
    })
    get().commit(library)
    return { entry, created }
  },

  /** Edit just the description of an entry (verbatim — becomes the prompt). */
  updateDescription(id, description) {
    const found = findLibraryEntry(get().library, id)
    if (!found) return false
    const kindKey = found.kind === 'character' ? 'characters' : found.kind === 'prop' ? 'props' : 'locations'
    const next = {
      ...get().library,
      [kindKey]: (get().library[kindKey] || []).map((entry) => (entry?.id === id
        ? { ...entry, description: String(description || '').trim(), updatedAt: new Date().toISOString() }
        : entry)),
    }
    get().commit(next)
    return true
  },

  /** Wire (or clear) a generated reference image to an entry. */
  setAssetId(id, assetId) {
    const { library } = setEntryAssetId(get().library, id, assetId)
    get().commit(library)
  },

  /** Remove an entry (manual only — the user confirms in the UI). */
  remove(id) {
    const { library } = removeLibraryEntry(get().library, id)
    get().commit(library)
  },

  // ── Bulk operations ─────────────────────────────────────────────────────
  /**
   * Add a list of stubs (from gap detection or manual). Idempotent — the
   * service upserts by slug, so re-adding known slugs just merges.
   * Returns the count of newly-created entries.
   */
  addMany(stubs) {
    if (!Array.isArray(stubs) || stubs.length === 0) return { added: 0, total: 0 }
    let working = get().library
    let created = 0
    for (const stub of stubs) {
      const result = upsertLibraryEntry(working, stub)
      working = result.library
      if (result.created) created += 1
    }
    get().commit(working)
    return { added: created, total: stubs.length }
  },

  /** Merge-safe import from exported JSON text. Returns the service result. */
  import(text) {
    const result = importLibraryJson(String(text || ''), get().library)
    if (result?.ok) get().commit(result.library)
    return result
  },

  /** Serialize the library for export (JSON string). */
  export() {
    return serializeLibraryForExport(get().library)
  },

  /** Reset to empty (rarely used; the Cast tab has no hard wipe). */
  reset() {
    get().commit({ ...EMPTY_LIBRARY })
  },
}))

/**
 * Selectors / helpers kept out of the store so consumers stay lean.
 */
export function allLibraryEntries(library) {
  return [
    ...((library?.characters || []).map((e) => ({ ...e, _kind: 'character' }))),
    ...((library?.props || []).map((e) => ({ ...e, _kind: 'prop' }))),
    ...((library?.locations || []).map((e) => ({ ...e, _kind: 'location' }))),
  ]
}

export function libraryCounts(library) {
  return {
    characters: (library?.characters || []).length,
    props: (library?.props || []).length,
    locations: (library?.locations || []).length,
  }
}

export function newEntryId(kind) {
  return makeEntityId(kind)
}