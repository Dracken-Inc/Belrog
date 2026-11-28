# Belrog Project Context

Durable architecture and product context for coding agents, valid independent of
any previous chat or machine. For *current* branch/version/test state read
`docs/AI_CURRENT_HANDOFF.md`; for house rules read `../AGENTS.md`.

**Last revalidated: 2026-11-28 (v0.6.x).**

## Product

Belrog is an open-source desktop AI video workstation. It combines a real
multi-track editor with guided AI generation, project asset management,
captions, effects, export, and a local MCP control layer for agents.

The founder's background is VFX and editorial. Product decisions should reflect
real production workflows while keeping AI video approachable for people who do
not want to operate a node graph.

Core product principles:

- Make the common creative path simple and guided.
- Keep outputs editable on a real timeline.
- Let advanced users bring custom workflows without making every user manage nodes.
- Keep local editing useful without ComfyUI. Only generation features and
  explicitly ComfyUI-backed utilities should require it.
- Prefer visible review and iteration over one-shot automation for creative work.
- Preserve user projects and existing behavior before optimizing architecture.

## Technical shape

Belrog is an Electron desktop application with a React renderer.

- **Electron main process:** `electron/main.js`
  Native windows, filesystem IPC, dialogs, FFmpeg, export workers, ComfyUI
  launching, workflow installation, the local MCP server, and the music-video
  IPC layer (`electron/musicVideoIpc.mjs`).
- **Preload bridge:** `electron/preload.js`
  A limited `window.electronAPI` surface. Renderer code uses this bridge, never
  Node APIs directly.
- **React renderer:** `src/App.jsx`, `src/components/`
  Workspaces, editor interaction, preview, Generate, captions, settings, export UI.
- **State:** `src/stores/` (Zustand)
  Project, timeline, asset, workflow, generation monitor, transient UI. Some
  slices persist to local storage; the project file is the durable document.
- **Services:** `src/services/`
  Domain logic: projects, workflows, generation, captions, media preparation,
  export, MCP actions, filesystem abstraction, and the music-video pipeline.
- **Configuration:** `src/config/`
  Built-in workflow registries, setup catalogs, model/node dependencies.

Main and renderer are separate processes. Renderer needs for native
filesystem/subprocess/OS behavior go through a narrow IPC handler in
`electron/main.js`, exposed only as the required method in `electron/preload.js`.

Note on module formats: `electron/*.js` is CommonJS; `src/**` is ESM-syntax
JavaScript with no package `type` field (Node ≥22 syntax detection applies in
tests). Do not blanket-force one module system over the other.

## Music-video / director pipeline (0.6 line)

The flagship guided creator: m4a in → beat-synced keyframes/video out.

```
sunoIntake.js (lyrics, sections, cast slugs, shot budget)
 → audioAnalysis.js (envelope → beats/sections)
 → actionProse.mjs (two-pass local LLM: plot → per-shot CSV; maxTokens 2048,
    computeShotBudget 2–8, downsampleBeats 32)
 → shotPlanValidator.js (V-gate: ltx_prompt_lint grammar → JSON schema
    → one LLM repair retry) against src/schema/shotPlan.schema.json
 → musicVideoRender.js (clip render + stitch)
orchestrated by src/services/musicVideoPipeline.js, wired to the UI in
src/components/MusicVideoEasyMode.jsx; master director prompt =
buildMusicVideoLLMPrompt in src/components/GenerateWorkspace.jsx (~line 2348).
```

Hard rules of record (2026-11-27 ruling, `docs/plans/one-shot-redesign.md`):

- The local llama-server sidecar writes the director script; prompts are compiled
  in code. The in-graph prompt enhancer was removed on purpose — do not restore it.
- The frozen contract is `shotPlan.schema.json`; anything produced outside it
  is a defect.
- Structured slots (LOCATION / CHARACTER / ACTION-FROZEN) must never receive
  prose spliced from the director script: montage/motion language belongs to the
  video stage only. This exact class of bug caused the 4-panel collage regression.

## Project data

Each project is a folder with project-owned assets, renders, cache, autosaves,
and a `project.comfystudio` JSON document (legacy filename kept for
compatibility; never surface it as the product name).

- Prefer project-relative media paths so projects move across Windows, macOS,
  and Linux; keep absolute-path fallback and relinking intact.
- Do not put generated test media or personal projects in the repository.
- Hydration coordinates `projectStore`, `timelineStore`, `assetsStore` — changing
  one contract affects project opening, autosave, MCP snapshots, and export.
- Timeline edits use existing store actions so undo, dirty tracking, autosave,
  and MCP snapshots stay accurate.

## Editing and preview

The timeline is driven by `timelineStore` / `assetsStore`; preview is assembled
from timeline clips rather than a classic NLE engine.
`src/components/CanvasPreviewRenderer.jsx` composes video/image sources, text
and shape rasters, masks, transitions, transforms, and effects. Cache keys and
source versions matter: a paused frame may need repainting even when the frame
number did not change.

Export has multiple paths — native/FFmpeg, and canvas/frame-pipe for states that
need renderer composition — running in a hidden Electron worker window. Hardware
encoding and Windows-only RTX upscaling are optional capabilities with
availability/fallback behavior. Browser preview, FFmpeg output, and packaged
Electron behavior are **not** identical; test the boundary you changed.

## ComfyUI and generation

Belrog talks to a separately installed local ComfyUI server, normally at
`127.0.0.1:8188`, and can embed it as an advanced workspace. Generation covers
curated built-in local and cloud workflows, guided creators (Music Video, UGC,
Business Ad, Short Film), imported API-format workflows, and custom workflow
bindings.

- Custom workflow support must not be restricted to the bundled catalog;
  detection tolerates real-world node naming without binding the wrong field.
- Cloud workflows spend credits: keep costs visible and require explicit
  approval before an agent queues paid work.

## Agents and MCP

A loopback MCP server runs at `http://127.0.0.1:19790/mcp`
(`electron/mcpServer.js`). It is a control layer over the same visible project,
never a second project model.

Safety expectations: read before writing; resolve ambiguous timeline targets
before mutation; use `previewOnly` where supported; ask approval for file
writes, timeline changes, generation, credit spending, installs, or export; use
project checkpoints for risky multi-step work; keep the server loopback-only.
See `docs/MCP.md`.

## Development

```bash
npm ci
npm run electron:dev      # vite + electron
npm run build             # production renderer build
```

Tests (no `npm test` umbrella script — see `AGENTS.md` Verification):

```bash
node --test 'tests/**/*.test.*' 'src/**/*.test.*' 'electron/**/*.test.*'
node --experimental-default-type=module --test path/to/specific.test.mjs  # single ESM suite
node --check electron/main.js && node --check electron/preload.js         # CJS syntax check
```

Build warnings about large chunks and mixed dynamic/static imports are known;
they are not a failed build — but do not add avoidable bundle growth.

## Git and releases

- Repository: `https://github.com/Dracken-Inc/Belrog` (public; **not** a GitHub
  fork of upstream). True upstream remote: `https://github.com/VelornLabs/velorn`.
- License: GPL-3.0-only.
- Use focused branches and commits; never mix generated media, experiments, and
  release work into a feature commit.
- Never discard a dirty checkout to update it — make a worktree and migrate
  intended changes deliberately.
- GitHub Actions builds Windows, macOS, and Linux from tags; releases are drafts
  reviewed before publication. Read `docs/AI_RELEASE_HANDOFF.md` and
  `docs/RELEASE_PROCESS.md` before release work.

## Where to look first

- Product overview: `README.md`
- Current state: `docs/AI_CURRENT_HANDOFF.md`
- House rules: `AGENTS.md`
- MCP behavior: `docs/MCP.md`
- Release procedure: `docs/AI_RELEASE_HANDOFF.md`
- Decision record for the 0.6 pipeline: `docs/plans/one-shot-redesign.md`
- App shell: `src/App.jsx`
- Project persistence: `src/services/fileSystem.js`, `src/stores/projectStore.js`
- Timeline: `src/stores/timelineStore.js`, `src/components/Timeline.jsx`
- Preview composition: `src/components/CanvasPreviewRenderer.jsx`
- Export: `src/components/ExportPanel.jsx`, `src/components/ExportWorker.jsx`
- Native layer: `electron/main.js`, `electron/preload.js`
- MCP server: `electron/mcpServer.js`
- Music-video pipeline: `src/services/musicVideoPipeline.js`
