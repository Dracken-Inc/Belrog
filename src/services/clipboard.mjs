/**
 * One clipboard path for the whole app.
 *
 * Why this exists: `navigator.clipboard.writeText` rejects with
 * NotAllowedError ("Document is not focused") whenever focus is inside a
 * cross-origin iframe — the Director Script planner in particular. Every copy
 * button in a guided workflow is next to that iframe, so the renderer-only path
 * silently did nothing. The main process has no focus requirement, so it goes
 * first and the web APIs are only fallbacks (plain browser, or an old preload).
 *
 * Never throws: a failed copy has to be reportable in the UI instead of
 * landing as an unhandled promise rejection.
 */

/** @returns {{ ok: boolean, via?: string, error?: string }} */
export async function copyText(text, { api = globalThis.window?.electronAPI, nav = globalThis.navigator, doc = globalThis.document } = {}) {
  const value = String(text ?? '')
  if (!value) return { ok: false, error: 'Nothing to copy.' }

  if (typeof api?.writeClipboardText === 'function') {
    try {
      const result = await api.writeClipboardText(value)
      if (result?.ok) return { ok: true, via: 'main' }
      // Fall through: an older main process may reject the channel.
    } catch (error) {
      const message = String(error?.message || error)
      if (!nav?.clipboard?.writeText && !doc) return { ok: false, error: message }
    }
  }

  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(value)
      return { ok: true, via: 'web' }
    } catch (error) {
      if (!doc) return { ok: false, error: String(error?.message || error) }
      try {
        legacyCopy(value, doc)
        return { ok: true, via: 'legacy' }
      } catch (fallbackError) {
        return { ok: false, error: String(error?.message || error || fallbackError) }
      }
    }
  }

  if (doc) {
    try {
      legacyCopy(value, doc)
      return { ok: true, via: 'legacy' }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  return { ok: false, error: 'Clipboard is not available here.' }
}

/** True when a copy failure should be blamed on focus rather than permissions. */
export function isFocusClipboardError(error) {
  return /not focused/i.test(String(error?.message || error || ''))
}

function legacyCopy(value, doc) {
  const textarea = doc.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  doc.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    doc.execCommand('copy')
  } finally {
    doc.body.removeChild(textarea)
  }
}
