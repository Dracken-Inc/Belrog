# Agent Notes — Belrog

This is the single source of truth for working on this repo. If any other
instruction file (skill, plan, handoff, memory, old doc) contradicts this file,
**this file wins** — and tell Henry the stale file so it can be cleaned up.

## Identity

- The product is **Belrog**. Never call it ComfyStudio in user-facing text, MCP
  metadata, docs, or chat.
- `comfystudio` survives only as a legacy package name, the project-file
  extension (`project.comfystudio`), and bridge/protocol identifiers.

## Vision

Belrog is an open-source AI video workstation: a real multi-track desktop editor
plus 100+ MCP tools for agents. The founder comes from VFX and editorial, so
workflows must read like production editorial — not like node graphs.

- The common creative path is simple and guided; every output lands on a real
  timeline the user can keep editing.
- Advanced users may bring custom ComfyUI workflows; routine product surfaces
  must never become node configuration.
- Editing, captions, and export must work without ComfyUI. Only generation and
  explicitly ComfyUI-backed features may require it.
- Prefer visible review and iteration over one-shot automation for creative work.
- Preserve user projects and existing behavior before optimizing architecture.
- Ship one feature at a time: build, test, stabilize, then move to the next.

## Locked architecture (ruling of record, 2026-11-27)

The music-video / director pipeline. Law until Henry changes it; full text in
`docs/plans/one-shot-redesign.md`:

- The director script (plot → per-shot) is written by the **bundled llama-server
  sidecar** in two passes — `src/services/actionProse.mjs` — and validated
  against `src/schema/shotPlan.schema.json` by `src/services/shotPlanValidator.js`
  (V-gate: grammar lint → JSON schema → one repair retry).
- Prompts are **compiled in code** (`src/services/promptCompiler.js`), one LLM
  call per song. The in-graph prompt enhancer was deliberately removed
  (`7f88440`); do not reintroduce it.
- The Perchance generator page is an optional manual tool, not the required path.

## Quality doctrine (how work is done here)

1. Collect the **whole** defect list before fixing anything.
2. Write the **failing test first**; fix only with the test red, then green.
3. One defect per commit. Never batch unrelated fixes.
4. Establish the test baseline before blaming your own change (see below).
5. Never claim success you have not actually run.
6. Inspect first, preview when supported, use existing undo/checkpoint paths.
7. Keep changes narrowly scoped; test the boundaries you touched (renderer,
   Electron IPC, packaged platform).
8. Never commit generated media, personal projects, or release folders.

## Verification — run before claiming anything is done

```bash
npm run test:all                                # ~35 s; node --test over tests/ src/ electron/
npm run build
node --check electron/main.js && node --check electron/preload.js
npx vite build                                  # MANDATORY before any commit touching src/**/*.jsx —
                                                # node --test never parses JSX, so tests can't catch it
```

(Equivalent: `node --test 'tests/**/*.test.*' 'src/**/*.test.*' 'electron/**/*.test.*'`)

Known baseline on 2026-11-28 (v0.6.51): 848 tests, 832 pass, **15 known
failures** — catalog tests need network, RTX/runtime tests assume Windows,
plus 2 real `myWorkflowCatalog` marker failures. Full breakdown and the
baseline rule are in `docs/AI_CURRENT_HANDOFF.md`. Do not silently "fix",
skip, or delete failing tests to get green — investigate or report them.
Note: Node ≥ 22 module-syntax detection is required — do not add
`--experimental-default-type=module` (it breaks CJS/ESM interop in tests).

## Henry's GPU and spend rules

- Image/keyframe generations: OK without asking, in reason.
- **Video generations: explicit go required.**
- Cloud credits: always require explicit approval first.
- Never kill the local vLLM / llama-server processes.

## Releases

- Read `docs/AI_RELEASE_HANDOFF.md` and `docs/RELEASE_PROCESS.md` first.
- Releases are drafts; verify assets before publishing.
- Never upload `.blockmap` / `latest*.yml`; never commit secrets or `.p12`.
- CI (`.github/workflows/release.yml`) builds from tags — **it does not run the
  test suite**, so tests are a local responsibility.

## Reading order

1. `docs/AI_CURRENT_HANDOFF.md` — state right now
2. `docs/ACTIVE-WORK.md` — **where work stopped and the next action** (live
   quality-loop tracker; update it as phases complete)
3. `docs/AI_PROJECT_CONTEXT.md` — durable architecture
4. `docs/AI_RELEASE_HANDOFF.md` — before any commit, tag, or Actions work

Anything else is reference material until proven current: check its "Last
updated" date against the current version before trusting it. Old instruction
files (home-root `belrog-*.md`, the 0.4.x-era skill body, `backUP01_*.md`) were
archived to `~/backups/belrog-instructions-2026-11-28/` and must not be read as
current.
