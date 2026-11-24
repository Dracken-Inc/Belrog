// Feature wiring audit.
//
// Why this exists: the Velorn 0.4.1 merge took four large "container" files from
// one side or the other instead of merging both. GenerateWorkspace.jsx became
// byte-identical to upstream, which silently deleted Belrog's two-person keyframe
// call sites, and three other containers kept Belrog's copy, which silently dropped
// upstream's own panels. Every unit test stayed green the whole time, because the
// helpers still exist and still pass their own tests - nothing imports them.
//
// A feature whose only importer is its own test is not a feature. This script finds
// those, plus any call site that a named feature contract says must exist.
const fs = require('node:fs')
const path = require('node:path')

const EXTS = ['.js', '.jsx', '.mjs', '.cjs']

// Features that must be reachable from the running app, not merely present on disk.
// `mount` is a regular expression that must match in `file`; a feature that loses its
// mount point fails even though its implementation file is untouched.
const CRITICAL_FEATURES = [
  {
    name: 'two-person keyframe identity mapping',
    file: 'src/components/GenerateWorkspace.jsx',
    mount: /\bapplyTwoPersonIdentityMapping\s*\(/,
    why: 'two cast members in one shot must map to image1/image2 by index, or the edit clones one face onto both',
  },
  {
    name: 'Qwen image-edit prompt prefix',
    file: 'src/components/GenerateWorkspace.jsx',
    mount: /\bQWEN_(?:KEYFRAME_)?EDIT_PREFIX\b/,
    why: 'without the prefix the model treats a keyframe edit as a fresh generation and ignores the reference face',
  },
  {
    name: 'asset slug tokens expanded in prompts',
    file: 'src/components/GenerateWorkspace.jsx',
    mount: /\bexpandAssetSlugTokensInPrompt\s*\(/,
    why: 'LOCATIONS:/PROPS: slugs must resolve to their library descriptions before the model sees them',
  },
  {
    name: 'keyframe-prose cast safety net',
    file: 'src/components/GenerateWorkspace.jsx',
    mount: /artist-added-from-keyframe/,
    why: 'a shot that names a second cast member only in prose must still fill both reference slots',
  },
  {
    name: 'easy-mode director hero',
    file: 'src/components/generate/MusicVideoEasyMode.jsx',
    mount: /<DirectorHero\b/,
    why: 'the guided music-video entry point',
  },
  {
    name: 'easy-mode router picture',
    file: 'src/components/generate/MusicVideoEasyMode.jsx',
    mount: /\brouterPicture\b/,
    why: 'routes picture prompts to the right image workflow',
  },
  {
    name: 'settings section tabs',
    file: 'src/components/SettingsModal.jsx',
    mount: /<SettingsSectionTabs\b/,
    why: 'settings sections are unreachable without the tab rail',
  },
  {
    name: 'audio ducking inspector',
    file: 'src/components/InspectorPanel.jsx',
    mount: /<AudioDuckingInspector\b/,
    why: 'dialogue-over-music ducking is only editable here',
  },
  {
    name: 'audio EQ inspector',
    file: 'src/components/InspectorPanel.jsx',
    mount: /<AudioEqInspector\b/,
    why: 'per-clip EQ is only editable here',
  },
  {
    name: 'clip speed gesture',
    file: 'src/components/InspectorPanel.jsx',
    mount: /\bclipSpeedGesture\b/,
    why: 'timeline speed drag handles',
  },
]

// Files allowed to sit unreachable: upstream leftovers that no tree has ever mounted,
// plus engines driven from scripts/MCP instead of the renderer. Add a reason or do not
// add an entry - an empty allowlist is the goal.
const UNREACHABLE_ALLOWED = {
  'src/components/BottomTabs.jsx': 'orphaned upstream, never mounted in any tree',
  'src/components/GeneratePanel.jsx': 'superseded by GenerateWorkspace.jsx',
  'src/components/LLMAssistantWorkspace.jsx': 'orphaned upstream',
  'src/components/panels/ScenesPanel.jsx': 'orphaned upstream',
  'src/components/panels/SettingsPanel.jsx': 'superseded by SettingsModal.jsx',
  'src/components/panels/WorkflowsPanel.jsx': 'orphaned upstream',
  'src/components/Sidebar.jsx': 'superseded by LeftPanel/RightPanel',
  'src/hooks/useVideoPlayback.js': 'orphaned upstream',
  'src/stores/workflowsStore.js': 'superseded by workflow catalog',
  'src/components/StoryboardPanel.jsx': 'orphaned upstream, replaced by StoryboardRail',
  'src/components/ProductionAnimatic.jsx': 'orphaned upstream',
  'src/components/ComfyRouterPanel.jsx': 'orphaned upstream',
  'src/services/h3OneShot.js': 'headless engine: driven by scripts/oneshot and MCP actions',
  'src/services/h3OneShotWatch.js': 'headless engine: driven by scripts/oneshot',
}

function listSourceFiles(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'release') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (EXTS.includes(path.extname(entry.name))) out.push(full)
    }
  }
  for (const dir of ['src', 'electron']) walk(path.join(root, dir))
  return out
}

const isTestPath = (rel) => /\.test\.[cm]?js$/.test(rel)

function resolveSpecifier(root, fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(path.join(root, fromFile)), spec)
  const candidates = [base, ...EXTS.map((ext) => base + ext), path.join(base, 'index.js')]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.relative(root, candidate)
  }
  return null
}

// Returns { unreachable: [{file, tested}], missingMounts: [{name, file, why}] }
function auditRepo(root) {
  const files = listSourceFiles(root)
  const importers = new Map()
  const pattern = /(?:import[^'"]*from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
  for (const file of files) {
    const rel = path.relative(root, file)
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(pattern)) {
      const target = resolveSpecifier(root, rel, match[1])
      if (!target) continue
      if (!importers.has(target)) importers.set(target, new Set())
      importers.get(target).add(rel)
    }
  }

  const unreachable = []
  for (const file of files) {
    const rel = path.relative(root, file)
    if (isTestPath(rel)) continue
    const text = fs.readFileSync(file, 'utf8')
    if (!/^\s*export\s/m.test(text)) continue
    const who = [...(importers.get(rel) || [])].filter((x) => !isTestPath(x))
    if (who.length > 0) continue
    if (UNREACHABLE_ALLOWED[rel]) continue
    unreachable.push({ file: rel, tested: [...(importers.get(rel) || new Set())].some(isTestPath) })
  }

  const missingMounts = []
  for (const feature of CRITICAL_FEATURES) {
    const full = path.join(root, feature.file)
    if (!fs.existsSync(full)) {
      missingMounts.push({ ...feature, reason: 'container file is missing' })
      continue
    }
    if (!feature.mount.test(fs.readFileSync(full, 'utf8'))) {
      missingMounts.push({ ...feature, reason: 'mount point is gone - the implementation exists but nothing uses it' })
    }
  }

  return { unreachable, missingMounts }
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..')
  const { unreachable, missingMounts } = auditRepo(root)
  for (const m of missingMounts) {
    console.error(`UNMOUNTED  ${m.name}\n           ${m.file}: ${m.reason}\n           why it matters: ${m.why}`)
  }
  for (const u of unreachable.sort((a, b) => a.file.localeCompare(b.file))) {
    console.error(`UNREACHABLE ${u.file}${u.tested ? '  (green tests import it directly - that is the false green)' : ''}`)
  }
  if (missingMounts.length + unreachable.length === 0) {
    console.log(`Feature wiring OK: ${CRITICAL_FEATURES.length} critical mount points present, no unreachable modules.`)
  } else {
    console.error(`\n${missingMounts.length} unmounted feature(s), ${unreachable.length} unreachable module(s).`)
    process.exitCode = 1
  }
}

module.exports = { auditRepo, CRITICAL_FEATURES, UNREACHABLE_ALLOWED }
