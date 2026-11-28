// ESM loader for fpsAuthority.test.mjs: src/services/*.js use bundler-style
// extensionless relative imports (e.g. './localComfyConnection' inside a
// `from { ... } of './x'` list) that vite resolves but bare Node does not.
// Node's ERR_MODULE_NOT_FOUND carries the URL it guessed, so recover the real
// base from there rather than pattern-matching the specifier — that covers
// multi-line import lists as well as single-line ones. Directory imports map
// to <dir>/index.js. Nothing else is rewritten.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw err
    // err.url is the fully-resolved URL Node failed on (parent + specifier),
    // regardless of how the specifier was written in the source.
    const failed = err.url ? new URL(err.url) : context.parentURL ? new URL(specifier, context.parentURL) : null
    if (!failed || failed.protocol !== 'file:') throw err
    const base = fileURLToPath(failed)
    for (const guess of [base + '.js', base + '/index.js']) {
      if (existsSync(guess)) {
        return { url: new URL('file://' + guess).href, shortCircuit: true }
      }
    }
    throw err
  }
}
