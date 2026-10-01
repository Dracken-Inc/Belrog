/**
 * Asset-library reference-generation bridge.
 *
 * The Cast panel lives in the LEFT panel (App level); the generation queue
 * lives inside GenerateWorkspace. GenerateWorkspace is kept mounted
 * (display:none) after its first visit, but a user can reach the Cast panel
 * before ever opening the Generate tab. This module bridges that gap with a
 * module-level pending queue (survives the SPA session in memory) plus a
 * window event so the listener can drain as soon as it's alive.
 *
 * CastPanel  -> requestAssetLibraryReference(payload)  [push + dispatch]
 * Generate -> drainAssetLibraryReferences(cb)          [pull all pending]
 */

const QUEUE_EVENT = 'asset-library-queue-reference'

// Module-level pending queue: persists even while GenerateWorkspace is
// unmounted (first visit), so nothing is lost between the request and the
// moment the listener drains it.
let pending = []
// Monotonic nonce so a fresh event always wakes a listener that already
// drained the queue (re-delivery guard on the consumer side).
let nonce = 0

/**
 * Queue a reference-image generation for a library entry.
 * @param {object} payload { entryId, kind, name, prompt, negative }
 */
export function requestAssetLibraryReference(payload) {
  if (!payload) return false
  pending.push({ nonce: ++nonce, ...payload })
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent(QUEUE_EVENT, { detail: { nonce } }))
    } catch {
      /* non-browser (SSR/test) — the pending queue still holds it */
    }
  }
  return true
}

/** Number of queued (not-yet-drained) reference requests. */
export function pendingAssetLibraryReferenceCount() {
  return pending.length
}

/**
 * Drain all pending requests, calling `cb(payload)` for each. Returns the
 * count drained. Safe to call repeatedly (a no-op when empty).
 */
export function drainAssetLibraryReferences(cb) {
  if (!Array.isArray(pending) || pending.length === 0) return 0
  const batch = pending
  pending = []
  let count = 0
  for (const item of batch) {
    try {
      cb(item)
      count += 1
    } catch {
      /* one bad item must not block the rest */
    }
  }
  return count
}

export const ASSET_LIBRARY_QUEUE_EVENT = QUEUE_EVENT