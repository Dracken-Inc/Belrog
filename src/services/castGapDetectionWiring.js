/**
 * Cast gap detection — the seam between the Director Script and the Cast library.
 *
 * The 0.5.0 upstream-base swap of GenerateWorkspace.jsx deleted the inline version
 * of this logic and the "Detected from your Director Script" panel kept rendering
 * nothing, silently: a component mounted without the detection prop simply skips
 * its block, with no error and no console warning. Pure functions in a real module
 * mean the wiring has a testable seam instead of living inside a 19k-line JSX file
 * (tests/castGapDetection.test.cjs).
 *
 * Rules this encodes (unchanged from 0.4.4–0.4.8):
 *  - Assets come from the script the user is actually looking at: the active alt
 *    pass if one is selected, otherwise the master script.
 *  - An ASSET LEGEND block is authoritative (contract v2): declared assets are
 *    auto-stubbed into Cast; prose guesses become suggestions only.
 *  - Alt passes do not inherit the master cast. Being in the video cast on Master
 *    does not mean that pass has a picture, so an alt pass reports its own
 *    declared assets as gaps. Their unresolved-artist warnings are filtered out of
 *    the plan warnings elsewhere, so nothing here depends on them.
 */
import { detectScriptGaps, buildStubUpserts } from './scriptGapDetection.js'
import { parseAssetLegendLines, parseInlineAssetDirectives } from '../utils/yoloPlanning.js'

/** Declared assets for one script: legend block first, inline directives after. */
export function parseDeclaredAssets(script = '') {
  const raw = String(script || '')
  if (!raw.trim()) return []
  const legend = parseAssetLegendLines(raw)
  const inline = parseInlineAssetDirectives(raw)
  if (inline.length === 0) return legend
  const seen = new Set(legend.map((entry) => `${entry.kind}:${entry.slug}`))
  return [...legend, ...inline.filter((entry) => !seen.has(`${entry.kind}:${entry.slug}`))]
}

/** The script text the active pass is showing (alt pass wins when selected). */
export function activeScriptText({ script = '', altScripts = [], activeScriptId = '' } = {}) {
  if (!activeScriptId) return String(script || '')
  const slot = (Array.isArray(altScripts) ? altScripts : [])
    .find((entry) => entry?.id === activeScriptId)
  return String(slot?.script || '')
}

/**
 * What the script names that Cast has no picture for. Null means "no panel":
 * not the music mode, or nothing planned yet.
 */
export function buildCastGapDetection({
  isEnabled = false,
  script = '',
  altScripts = [],
  activeScriptId = '',
  plan,
  warnings = [],
  cast = [],
  library,
} = {}) {
  try {
    if (!isEnabled) return null
    if (!Array.isArray(plan) || plan.length === 0) return null
    const assets = parseDeclaredAssets(activeScriptText({ script, altScripts, activeScriptId }))
    return detectScriptGaps({
      scenes: plan,
      warnings: Array.isArray(warnings) ? warnings : [],
      cast: activeScriptId ? [] : (Array.isArray(cast) ? cast : []),
      library,
      assets,
    })
  } catch {
    return null
  }
}

/**
 * Stubs to write into Cast. `declaredOnly` is the auto-stub path (an effect that
 * runs whenever a plan is rebuilt, so it must never invent entries from prose);
 * the explicit "Add to Cast" button passes everything the detector found.
 */
export function buildCastStubs({ detection, library, scenes, declaredOnly = false } = {}) {
  const stubs = buildStubUpserts({ detection, library, scenes })
  if (!declaredOnly) return stubs
  if ((detection?.legend?.length || 0) === 0) return stubs
  return stubs.filter((stub) => stub.legendDeclared)
}
