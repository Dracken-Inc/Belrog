#!/usr/bin/env node
/*
Catches names a file uses but never defines - the mistake this guards against is real and
specific: commit 045b8b6 removed GPU sharing from electron/main.js and deleted
`workflowAssetInputs` and `savedWorkflowLibrary` with it, because those declarations sat in
the block being removed. Three later lines still call them, `node --check` passes (it is not
a syntax error), lint is not installed, the release build went green, and every Windows user
got an app that starts, throws ReferenceError inside getGenerationRuns, and never shows its
window. Only running the app catches it, so we also catch the cheap half here.

How: strip comments and literals, collect every name the file binds anywhere (its own scope
set is deliberately generous - a name declared in an inner block counts), then look at every
name used as the root of a property access or a call. Anything left is either undeclared or
in the explicit allowlist below.

Limits worth knowing, so nobody trusts this more than it deserves:
  - It cannot see scope. A name used before its `let` on the same line still passes.
  - It only inspects roots of `name.x` and `name(`. A bare `name` passed as a value is not
    checked, so this finds "deleted declaration, still called", not every undefined variable.
  - It reads one file at a time. Anything genuinely global must be in GLOBALS.

Usage: node scripts/check-undefined-identifiers.cjs [files...]   (default: electron/)
Exit 0 clean, 1 with a file:line list.
*/
const fs = require('fs')
const path = require('path')

// Node built-ins and browser globals a main-process file can legitimately reach for.
const GLOBALS = new Set(`
globalThis global window console process Buffer module exports require __dirname __filename
arguments this super new typeof void delete instanceof in of instanceof
if for while switch catch return function class let const var do else try throw case default
break continue yield await async get set static extends
Infinity NaN undefined null true false
setTimeout setInterval clearTimeout clearInterval setImmediate clearImmediate queueMicrotask
Promise Symbol Proxy Reflect WeakMap WeakSet Map Set Array Object String Number Boolean Date
RegExp Error TypeError RangeError SyntaxError ReferenceError EvalError URIError AggregateError
JSON Math parseInt parseFloat isNaN isFinite encodeURI decodeURI encodeURIComponent
decodeURIComponent structuredClone cloneDeep
URL URLSearchParams TextEncoder TextDecoder AbortController AbortSignal BroadcastChannel
EventEmitter ReadableStream WritableStream TransformStream CompressionStream
fetch Request Response Headers FormData Blob File
Intl ArrayBuffer SharedArrayBuffer DataView Float32Array Uint8Array Uint8ClampedArray
Int8Array Int16Array Uint16Array Int32Array Uint32Array Float64Array BigInt64Array BigUint64Array
BigInt crypto performance atob btoa
`.trim().split(/\s+/))

const KEYWORDS_BEFORE_CALL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'void', 'function', 'delete', 'await', 'yield', 'in', 'of', 'new', 'do', 'else', 'throw', 'case', 'import', 'export', 'const', 'let', 'var', 'class', 'extends'])

// Globals of a browser page: everything in src/ runs in Chromium, as does anything injected
// into ComfyUI's page. They are deliberately NOT in GLOBALS, so `document` in a main-process
// file stays a failure - that call would genuinely throw at runtime.
const BROWSER_GLOBALS = new Set(`
document window navigator screen location history localStorage sessionStorage indexedDB caches
HTMLElement Element Node NodeFilter NodeIterator SVGElement HTMLIFrameElement HTMLCanvasElement
HTMLImageElement HTMLVideoElement HTMLInputElement HTMLDivElement DocumentFragment ShadowRoot
CustomEvent Event EventTarget KeyboardEvent MouseEvent WheelEvent PointerEvent DragEvent
ClipboardEvent InputEvent AnimationEvent TransitionEvent CloseEvent ErrorEvent
CustomElementRegistry MutationObserver ResizeObserver IntersectionObserver PerformanceObserver
requestAnimationFrame cancelAnimationFrame requestIdleCallback getComputedStyle matchMedia
Image Audio AudioContext OfflineAudioContext AnalyserNode MediaRecorder MediaSource
VideoDecoder VideoEncoder EncodedVideoChunk VideoFrame ImageData ImageBitmap ImageData
createImageBitmap OffscreenCanvas Path2D CanvasRenderingContext2D WebGLRenderingContext
WebGL2RenderingContext WebGLTimerQuery EXT_texture_filter_anisotropic
RTCPeerConnection RTCPeerConnection getUserMedia XMLHttpRequest WebSocket Worker SharedWorker
EventSource BroadcastChannel DataTransfer FileReader FileList Blob File DataView DOMParser
XMLSerializer URLSearchParams TextEncoder TextDecoder crypto performance atob btoa structuredClone
DOMException AbortSignalError self WorkerGlobalScope window self
Notification ServiceWorker Notification PermissionStatus CredentialStorage StorageManager
ComfyUI app liteGraph LiteGraph graph canvasGraph $$ $
`.trim().split(/\s+/))

// True when the `/` at i is division rather than the start of a regex literal, decided by
// the token before it. `}` is treated as a block end (so a regex) - it is the one case a
// scanner cannot resolve without real parsing, and treating it as division would hide names.
function isDivision(src, i) {
  const wordBefore = idx => {
    let j = idx
    while (j >= 0 && /\s/.test(src[j])) j--
    const end = j
    while (j >= 0 && /[\w$]/.test(src[j])) j--
    return src.slice(j + 1, end + 1)
  }
  let j = i - 1
  while (j >= 0 && /\s/.test(src[j])) j--
  if (j < 0) return false
  const c = src[j]
  if (c === ')') {
    let depth = 0
    let k = j
    for (; k >= 0; k--) {
      if (src[k] === ')') depth++
      else if (src[k] === '(' && --depth === 0) break
    }
    return !KEYWORDS_BEFORE_CALL.has(wordBefore(k - 1)) // `if (x) /re/.test(y)` is a regex
  }
  if (/[.\w$"'`]/.test(c)) return !KEYWORDS_BEFORE_CALL.has(wordBefore(j))
  return false
}

// Index of the ')' closing the '(' at `open`, or -1. Assumes comments and strings are
// already blanked by stripNoise, so no quote handling is needed here.
function matchingParen(code, open) {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')' && --depth === 0) return i
  }
  return -1
}

function stripNoise(src) {
  // Blank out comments, strings and template literals (keeping line and column) so words
  // inside them cannot be mistaken for code. Template literals are tracked with a stack,
  // because `a${`b`}c` is legal and a flag-based scanner pairs the wrong backticks: the
  // first version of this did that and blanked half of main.js, which turned every name in
  // the file into a false "missing" report.
  const out = []
  // Each frame is { mode, depth }: 'template' frames end at a backtick, 'code' frames were
  // opened by ${ and end at the `}` that closes them (depth 0). Without that pop, every
  // interpolation leaks a frame and the rest of the file is scanned as code.
  const stack = [{ mode: 'code', depth: 0, root: true }]
  let i = 0
  const n = src.length
  const emit = s => { for (const ch of s) out.push(ch) }
  while (i < n) {
    const frame = stack[stack.length - 1]
    const c = src[i]
    const two = src.substr(i, 2)
    if (frame.mode === 'template') {
      if (c === '\\') { emit('  '); i += 2; continue }
      if (c === '`') { stack.pop(); emit(' '); i++; continue }
      if (two === '${') { stack.push({ mode: 'code', depth: 0 }); emit('  '); i += 2; continue }
      emit(c === '\n' ? '\n' : ' ')
      i++
      continue
    }
    if (c === '{') { frame.depth++; emit(c); i++; continue }
    if (c === '}') {
      if (frame.depth === 0 && !frame.root) { stack.pop(); emit(' '); i++; continue }
      frame.depth--
      emit(c)
      i++
      continue
    }
    if (two === '//') {
      while (i < n && src[i] !== '\n') i++
      emit('  ')
    } else if (two === '/*') {
      i += 2
      emit('  ')
      while (i < n && src.substr(i, 2) !== '*/') { emit(src[i] === '\n' ? '\n' : ' '); i++ }
      i += 2
      emit('  ')
    } else if (c === '"' || c === "'") {
      i++
      emit(' ')
      while (i < n) {
        if (src[i] === '\\') { emit('  '); i += 2; continue }
        if (src[i] === c) { i++; emit(' '); break } // consume the closing quote, or it opens again
        if (src[i] === '\n') break // unterminated on this line: let the newline fall through
        emit(' ')
        i++
      }
    } else if (c === '`') {
      stack.push({ mode: 'template', depth: 0, at: i })
      emit(' ')
      i++
    } else if (c === '/' && !isDivision(src, i)) {
      // A regex literal. Without this, /\$\{([^}]+)\}/ reports `$` as an undefined name and
      // /run_(nvidia|cpu)/ reports `run_`. Deciding regex vs division needs the previous
      // token, and `}` is the one genuinely ambiguous case - treated as "regex" here.
      i++
      emit(' ')
      let cls = false
      while (i < n) {
        const d = src[i]
        if (d === '\\') { emit('  '); i += 2; continue }
        if (d === '\n') break
        if (d === '[') cls = true
        else if (d === ']') cls = false
        else if (d === '/' && !cls) { i++; emit(' '); break }
        emit(' ')
        i++
      }
      while (i < n && /[dgimsuvy]/.test(src[i])) { emit(' '); i++ }
    } else {
      emit(c)
      i++
    }
  }
  if (stack.length !== 1) {
    // Unbalanced backticks usually mean a scanner bug, not broken source; say so loudly
    // rather than silently reporting half the file as blank. The line is reported because
    // the usual cause is a backtick the scanner met somewhere it should not have been.
    const open = stack.find(f => f.mode === 'template')
    const line = src.slice(0, open ? open.at : 0).split('\n').length
    throw new Error(`template nesting did not close (depth ${stack.length - 1}), first opened near line ${line}: ` +
      (open ? JSON.stringify(src.split('\n')[line - 1].trim().slice(0, 90)) : ''))
  }
  return out.join('')
}

// Identifiers a declaration introduces, from `start` (just after const/let/var) to the end
// of the statement. Commas at depth 0 separate declarators, and inside each declarator only
// the names before its first depth-0 `=` bind - so `let a = 1, b = 2` yields a and b, and
// `const x = helper` does not make `helper` look declared.
function declarators(code, start) {
  let i = start
  let depth = 0
  const parts = []
  let part = ''
  while (i < code.length) {
    const c = code[i]
    if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') depth--
    else if (depth === 0 && (c === ';' || (c === '\n' && !part.trim().endsWith(',')))) { parts.push(part); break }
    if (depth === 0 && c === ',') { parts.push(part); part = ''; i++; continue }
    part += c
    i++
    if (depth < 0) break
  }
  parts.push(part)
  const names = []
  for (const p of parts) {
    let d = 0
    let head = ''
    for (const c of p) {
      if (c === '{' || c === '[' || c === '(') d++
      else if (c === '}' || c === ']' || c === ')') d--
      if (c === '=' && d === 0) break
      head += c
    }
    for (const m of head.matchAll(/[A-Za-z_$][\w$]*/g)) names.push(m[0])
  }
  return names
}

function declaredNames(code) {
  const names = new Set()
  // const/let/var bindings, including multi-line destructured requires and `let a = 1, b = 2`.
  for (const m of code.matchAll(/\b(?:const|let|var)\s+/g)) {
    for (const name of declarators(code, m.index + m[0].length)) {
      if (!KEYWORDS_BEFORE_CALL.has(name)) names.add(name)
    }
  }
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  // import bindings: default, namespace and named, with `as` renames. The quote after `from`
  // cannot be matched here because stripNoise blanks string contents - including the quotes -
  // so requiring one made every default import look like a use of an undefined name.
  for (const m of code.matchAll(/\bimport\s+([^;'"]{0,3000}?)\s*from\b/g)) {
    for (const id of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) names.add(id[0])
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*([^)]*?)\s*\)/g)) {
    for (const id of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) if (id[0] !== 'from') names.add(id[0])
  }
  // Parameters: every word inside a parenthesised list that is followed by `=>` or `{`.
  // Balanced scanning, not a regex: the common shape here is a factory signature like
  // `function registerX({ ipcMain, getAssets = async () => [] }) {`, where the default value
  // contains parens, so `[^()]*` finds nothing and ipcMain looks undeclared. That one gap
  // accounted for most of this script's first run's 400 "problems".
  for (let i = code.indexOf('('); i >= 0; i = code.indexOf('(', i + 1)) {
    // Whole-word keyword check. A plain `(if|for|of|in)$` matches the "of" inside
    // `acceptProof(` and the "in" inside `begin(`, which throws away real parameter lists and
    // makes their parameters look undefined.
    const before = code.slice(Math.max(0, i - 24), i).replace(/[\s]+$/, '')
    if (/(?:^|[^\w$])(?:if|for|while|switch|catch|with)(?![\w$])/.test(before)) continue // if (...) { / catch (...) {
    const close = matchingParen(code, i)
    if (close < 0) continue
    if (!/^\s*(?:=>|\{)/.test(code.slice(close + 1, close + 12))) continue
    for (const id of code.slice(i + 1, close).matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (!KEYWORDS_BEFORE_CALL.has(id[0])) names.add(id[0])
    }
  }
  // Arrow with one unparenthesised parameter: `item => item.size`.
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) {
    if (!KEYWORDS_BEFORE_CALL.has(m[1])) names.add(m[1])
  }
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  return names
}

function usedNames(code) {
  // Roots of property access and calls, with their line number. The lookbehind matters:
  // without it `list.map(...)` reports `map` as an undefined name, which is how the first
  // version of this script produced 1,252 "problems" and zero signal.
  const found = []
  const before = new Map()
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?:\?\?)?\.\s*[A-Za-z_$#\[]/g)) found.push([m[1], m.index])
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?:\?\?)?\(/g)) found.push([m[1], m.index])
  for (const [name, idx] of found) {
    if (KEYWORDS_BEFORE_CALL.has(name)) continue // dynamic import(), await, typeof
    // Skip method definitions and property shorthand: `{ foo() {} }`, `get foo() {}`.
    const prev = code.slice(Math.max(0, idx - 40), idx).replace(/\s+$/, '')
    if (/[{,]$/.test(prev) || /\b(get|set|async|function|static)$/.test(prev)) continue
    // Class and object methods written one per line: the name sits at the start of its line and
    // its parameter list is followed by `{`. Without this, every method after the first in a
    // `class X { ... }` body looks like an undefined call - 32 false alarms in this repo.
    if (/^\s*$/.test(code.slice(code.lastIndexOf('\n', idx) + 1, idx))) {
      const open = code.indexOf('(', idx)
      const close = open > 0 ? matchingParen(code, open) : -1
      if (close > 0 && /^\s*\{/.test(code.slice(close + 1, close + 14))) continue
    }
    const line = code.slice(0, idx).split('\n').length
    if (!before.has(name)) before.set(name, line)
  }
  return before
}

function checkFile(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const code = stripNoise(raw)
  const declared = declaredNames(code)
  // Renderer code (src/) and scripts injected into ComfyUI's page run in Chromium, so the
  // page's globals are in scope there. They stay out of GLOBALS proper: `document` in a real
  // main-process file is a bug worth failing the build for.
  const browserContext = /[\\/]comfyui-injected[\\/]/.test(file) || /(^|[\\/])src[\\/]/.test(file)
  const problems = []
  for (const [name, line] of usedNames(code)) {
    if (GLOBALS.has(name) || declared.has(name) || (browserContext && BROWSER_GLOBALS.has(name))) continue
    problems.push({ file, line, name })
  }
  return problems
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    // .jsx is deliberately not scanned. In JSX, prose inside a tag is code-shaped to a scanner
    // ("see example.com" reads as a property access on `example`), and the thing a renderer
    // file most often loses - the import of a component used as <Foo /> - is a bare identifier,
    // which this script does not check at all. So the coverage would cost false alarms and buy
    // almost nothing.
    else if (/\.(cjs|js)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) out.push(full)
  }
  return out
}

// A target may be a file or a directory; a directory means every .js/.cjs under it.
function expand(targets) {
  const out = []
  for (const target of targets) {
    const stat = fs.existsSync(target) ? fs.statSync(target) : null
    if (stat?.isDirectory()) walk(target, out)
    else if (stat?.isFile()) out.push(target)
    else console.error(`check-undefined-identifiers: no such file or directory: ${target}`)
  }
  return [...new Set(out)]
}

const targets = expand(process.argv.slice(2).filter(a => !a.startsWith('--')))
if (process.env.NRRM_DEBUG_NAME) {
  // Debug: why does this name look undefined? Shows every occurrence with the stripped and
  // the original line, which is how a stripper bug is told apart from a real missing name.
  const file = targets[0]
  const raw = fs.readFileSync(file, 'utf8')
  const code = stripNoise(raw)
  const name = process.env.NRRM_DEBUG_NAME
  const declared = declaredNames(code)
  console.log(`${file}: ${name} declared=${declared.has(name)}`)
  raw.split('\n').forEach((line, idx) => {
    if (!new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(line)) return
    console.log(`  ${idx + 1} code: ${code.split('\n')[idx].trim().slice(0, 100)}`)
    console.log(`  ${idx + 1} raw : ${line.trim().slice(0, 100)}`)
  })
  process.exit(0)
}
const REPO = path.join(__dirname, '..')
const files = targets.length ? targets : walk(path.join(REPO, 'electron'))
const problems = []
for (const file of files) {
  try { problems.push(...checkFile(file)) } catch (e) { problems.push({ file, line: 0, name: `<unreadable: ${e.message}>` }) }
}
// Inside the repo, a repo-relative path is what you can click. Outside it (a test fixture in
// /tmp), relativizing produces ../../../tmp/... which reads like a bug in the checker.
const shown = file => {
  const rel = path.relative(REPO, file)
  return rel && !rel.startsWith('..') ? rel : file
}
if (!problems.length) {
  console.log(`check-undefined-identifiers: ${files.length} files, no undefined names`)
  process.exit(0)
}
const byName = new Map()
for (const p of problems) {
  const key = `${p.name}`
  if (!byName.has(key)) byName.set(key, [])
  byName.get(key).push(`${shown(p.file)}:${p.line}`)
}
console.error(`check-undefined-identifiers: ${problems.length} uses of ${byName.size} name(s) that this code never defines\n`)
for (const [name, where] of [...byName].sort((a, b) => b[1].length - a[1].length)) {
  console.error(`  ${name}  -  ${where.length} use(s): ${where.slice(0, 6).join(', ')}${where.length > 6 ? ' ...' : ''}`)
}
console.error('\nEither the declaration was deleted by mistake (this is how 0.5.1 shipped a')
console.error('window that never opened) or the name belongs in GLOBALS in this script.')
process.exit(1)
