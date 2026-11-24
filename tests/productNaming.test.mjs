import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

// The product is Belrog. "Velorn" survives only where something outside this repository still
// reads it - an installed older app, a paired phone, a saved project file, a production service -
// or where it is history that should not be rewritten. Everything else is drift: the brand sweep
// ran once, and a case-sensitive sweep leaves lowercase copies behind in .py files, workflow YAML
// and shipped provenance text. That drift has already cost a release (the RIFE secure build
// banner) and leaked the old name into a shipped artifact (whisper-cli's PROVENANCE.txt), so it
// is a test now instead of a rule in someone's head.
//
// Two tiers, because the two halves fail for different reasons:
//
//   ARTIFACTS - files that ship verbatim or are shown to a person: package metadata, what is in
//     public/, the text the release workflow posts to Discord. Zero tolerance; anything listed in
//     EXCEPTIONS below is an explicit, dated, reasoned exception rather than a blind spot.
//
//   BACKLOG - identifiers that already exist on user disks and inside saved projects (localStorage
//     keys, saved theme ids, blob-name prefixes, message channels, node titles in old project
//     files). Those are retired by a migration that reads the old value and writes the new one,
//     never by find-and-replace, so the count is ratcheted: no commit may add to it. Lowering
//     BACKLOG_BASELINE is the progress metric of that migration.
//
// docs/ is deliberately not scanned. Release notes, handoff notes and migration records name the
// old product precisely because they describe the past, and rewriting them would destroy the
// record this file says not to rewrite.

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const BACKLOG_DIRS = ['src', 'electron', 'scripts']
const ARTIFACT_DIRS = ['public', path.join('.github', 'workflows')]
const ARTIFACT_FILES = ['package.json']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'Release', '__pycache__', '.vite'])
const MAX_BYTES = 2 * 1024 * 1024
const BINARY = /\.(png|jpg|jpeg|gif|webp|mp4|webm|ico|woff2?|ttf|otf|pyc|zip|dll|exe|so|dylib|node)$/

const BACKLOG_BASELINE = 388

// Files above that are known to contain the old name, with the reason they are not simply
// renamed. An entry has to be deletable by someone with an afternoon: if the blocker is a product
// decision, name who has to make it.
const EXCEPTIONS = new Map([
  // The Discover list is content hosted by the upstream organisation (its raw.githubusercontent
  // URL and velorn.ai/discover/catalog.json are the only trusted remote sources), and public/
  // holds the offline mirror of it. Item ids are the remote's, so renaming the mirror's copies
  // would make the fallback disagree with what the app fetches.
  ['public/discover/catalog.json', 'item ids mirror the catalog hosted upstream; they have to match the remote copy'],
  // Theme description strings are looked up by theme id (settings.appearance.themes.<id>), and
  // 'velorn' is the id installed builds have saved in their settings. Renaming the key means
  // renaming the id and accepting the old saved value - a migration of a persisted value, not a
  // text edit. See src/config/themes.js.
  ['public/lang/lang_en.json', "keyed by the persisted theme id; needs the theme-id migration in src/config/themes.js"],
  ['public/lang/lang_jp.json', 'keyed by the persisted theme id; needs the theme-id migration in src/config/themes.js'],
  // The marketing site is still velorn.ai: belrog.ai has no DNS record as of 2026-11, so this link
  // cannot move yet. Blocked on Henry deciding where the website lives.
  ['.github/workflows/discord-release.yml', 'website_url is the live site, which is still velorn.ai until the domain is switched over'],
])

// Add to LEGACY only with a reason that names the outside reader. The right fix for an internal
// identifier is to rename both sides of it in the same commit.
const LEGACY = [
  // URLs, headers and env names that production services and old builds read.
  [/VelornLabs/g, 'GitHub organization that hosts signed download artifacts and the Discover catalog'],
  [/X-Velorn-Computer-Id/g, 'request header the cloud Router still accepts'],
  [/connect\.velorn\.ai/g, 'origin check against the live hosted service'],
  [/VELORN_[A-Z_]+/g, 'environment variable names read by external setups'],
  // Identifiers shared with a peer we do not control in lockstep: an installed older app, a
  // paired phone, or a project file already on disk. Readers accept both spellings, writers emit
  // Belrog.
  [/velorn[-_](?:tool|tool-setup)/g, 'tool-fence and installer tokens in stored chats'],
  [/\bvelorn:[a-z-]+/g, 'window event channel names emitted by older builds'],
  [/\.velorn-[a-z]*\$?\{?[a-z.]*/g, 'partial-download file names already in user temp dirs'],
  // Compatibility alias for the legacy package/protocol namespace.
  [/comfystudio/g, 'legacy package and protocol namespace alias'],
]

const LEGACY_PATTERNS = LEGACY.map(([pattern]) => pattern)

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name))
      continue
    }
    yield path.join(dir, entry.name)
  }
}

function scanFiles(dirs, files) {
  return files.map(name => path.join(REPO_ROOT, name)).concat(
    dirs.filter(dir => fs.existsSync(path.join(REPO_ROOT, dir))).flatMap(dir => [...walk(path.join(REPO_ROOT, dir))]),
  )
}

function findOldBrand(files) {
  const hits = []
  for (const file of files) {
    let stat
    try { stat = fs.statSync(file) } catch { continue }
    if (!stat.isFile() || stat.size > MAX_BYTES || BINARY.test(file) || /\.min\.(js|css)$/.test(file)) continue
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue } // binary, or unreadable by this user
    if (!/velorn/i.test(text)) continue
    const relative = path.relative(REPO_ROOT, file)
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      let line = lines[index]
      if (!/velorn/i.test(line)) continue
      for (const pattern of LEGACY_PATTERNS) line = line.replace(pattern, ' ')
      if (!/velorn/i.test(line)) continue
      hits.push({ file: relative, text: `${relative}:${index + 1}: ${line.trim().slice(0, 110)}` })
    }
  }
  return hits
}

test('nothing that ships as it is calls the product by its old name', () => {
  const hits = findOldBrand(scanFiles(ARTIFACT_DIRS, ARTIFACT_FILES))
    .filter(hit => !EXCEPTIONS.has(hit.file))
  const listed = [...EXCEPTIONS].map(([file, reason]) => `  ${file}: ${reason}`).join('\n')
  assert.deepEqual(hits.map(hit => hit.text), [],
    `The old brand reached a file that ships or displays verbatim. If it has to stay, add the file `
    + `to EXCEPTIONS with a reason naming who has to fix it.\nCurrently excepted:\n${listed}\n`
    + `New hits:\n${hits.map(hit => hit.text).join('\n')}`)
})

test('every exception is still a real exception', () => {
  // A stale exception is a blind spot with a comment attached: once the file stops containing the
  // old name, the entry has to go, otherwise the next accidental occurrence walks through it.
  const present = new Map(findOldBrand(scanFiles(ARTIFACT_DIRS, ARTIFACT_FILES)).map(hit => [hit.file, hit.text]))
  for (const [file, reason] of EXCEPTIONS) {
    assert.ok(reason.length > 20, `${file} needs a reason that explains who is blocked`)
    assert.ok(present.has(file), `${file} is excepted but no longer contains the old name - delete the exception`)
  }
})

test('the compat-identifier backlog does not grow', () => {
  const hits = findOldBrand(scanFiles(BACKLOG_DIRS, []))
  assert.ok(hits.length <= BACKLOG_BASELINE,
    `${hits.length} old-brand compat identifiers found, ${hits.length - BACKLOG_BASELINE} more than the recorded `
    + `${BACKLOG_BASELINE}. These are retired by a migration that reads the stored old value and writes the `
    + `new one, not by adding a new occurrence. If you retired one on purpose, lower BACKLOG_BASELINE here.\n`
    + `First 20:\n${hits.slice(0, 20).map(hit => hit.text).join('\n')}`)
})

test('the compatibility allow list stays small and each entry still earns its place', () => {
  // An entry whose pattern matches nothing in the tree is dead weight that hides the real
  // exceptions, so it has to be deleted rather than left behind.
  const corpus = scanFiles([...BACKLOG_DIRS, ...ARTIFACT_DIRS], ARTIFACT_FILES)
    .filter(file => {
      try { return fs.statSync(file).isFile() && fs.statSync(file).size <= MAX_BYTES && !BINARY.test(file) } catch { return false }
    })
    .map(file => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } })
    .join('\n')
  for (const [pattern, reason] of LEGACY) {
    assert.ok(reason.length > 12, `${pattern} needs a reason naming the outside reader`)
    assert.ok(corpus.match(pattern), `${pattern} matches nothing in the scanned tree any more - delete it`)
  }
  assert.ok(LEGACY.length <= 12, 'the compatibility allow list has grown past a dozen entries')
})
