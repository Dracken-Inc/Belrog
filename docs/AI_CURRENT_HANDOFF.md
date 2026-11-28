# AI Current Handoff — Belrog

**Last updated: 2026-11-28.** If this date is older than the current minor
version, treat this file as stale and say so instead of acting on it.

## State right now

- **Branch:** `feat/shot-plan-schema-freeze` (working branch for the 0.6 line)
- **Latest published tag:** `v0.6.51` (`8cfe14f`, 2026-11-28)
- **Release line:** 0.6.x — version numbers bump per milestone (`0.6.51`, `0.6.52`, …)
- **Local `main`:** 2 ahead of `origin/main` (origin/main still sits at the
  v0.6.2 tag); published work is carried by tags, not by `main`. Do not assume
  `main` is the tip.
- **Remotes:** `origin` = `Dracken-Inc/Belrog` (public, not a GitHub fork),
  `upstream` = `VelornLabs/velorn` (project was renamed Belrog → Velorn
  upstream; upstream `0.4.x` is a *different* version line — never compare our
  0.6.x against their 0.4.x as if they share a baseline).
- **The only checkout on this machine:** `~/belrog-src`. `/tmp/opencode/belrog/*`
  are git worktrees and disappear when `/tmp` is wiped (run `git worktree prune`
  if a `git worktree add` refuses a name that no longer exists).

## Open regression work (active)

Henry's four regressions from the Nov 27–28 work are tracked in
`~/.hermes/plans/belrog-quality-loop-tracker.md` (an automated 20-minute quality
loop owns them; owner works directly, no delegation):

| id | symptom | status @ v0.6.51 |
|----|---------|------------------|
| R1 | Workspace crashes moving to step 1 of the music-video workflow | open |
| R2 | LTX keyframe shot quality worse than before | open |
| R3 | Director scripts weak/silly from the local Qwen engine | open |
| R4 | Characters/locations malformed → 4-panel collage shot, `"Roses boots"`, `CHARACTER: location only` | **fixed** in `681f4db` (keep asset boilerplate out of still/keyframe prompts) |

Method Henry mandated, in order: collect all issues → failing tests first →
online research → fix → verify → test → push/tag/build/notify → next item.

## Test baseline (verified 2026-11-28, v0.6.51)

```bash
node --test 'tests/**/*.test.*' 'src/**/*.test.*' 'electron/**/*.test.*'
```

Result: **848 tests, 832 pass, 15 fail, 1 skipped (~35 s).** There is no
`npm test`; do not add `--experimental-default-type=module` (it forces the CJS
`electron/` files into ESM and produces fake failures).

The 15 known failures, classified — **run this baseline before blaming your own
change:**

| count | area | classification |
|-------|------|-----------------|
| 8 | `src/services/discoverCatalog.test.mjs` | needs network to the public catalog endpoint (no DNS in isolated environments) |
| 3 | `tests/rtxVideoUpscale.test.js` | Windows-path expectations (`C:\…`) asserted on Linux |
| 1 | `tests/opticalFlowCache.test.js` | platform/temp-path assumptions |
| 1 | `tests/runtimePackageGate.test.js` | local FFmpeg/minterpolate availability |
| 2 | `tests/myWorkflowCatalog.test.js` | **real**: marker case mismatch — code emits `Belrog_PROMPT`, tests assert `BELROG_PROMPT` |

Rules: never delete, skip, or "fix" a failing test to get green. If a failure is
not in the list above, it is either your regression or a newly discovered defect
— report it with file:line evidence.

Also required before claiming done: `npm run build`, and
`node --check electron/main.js && node --check electron/preload.js`.

**Structural gap:** CI (`.github/workflows/release.yml`) builds releases but
does **not** run tests. Tests are a local gate only until that changes.

## Current architecture (0.6 music-video line)

```
m4a → Suno intake (src/services/sunoIntake.js)
    → audio envelope analysis (src/services/audioAnalysis.js)
    → two-pass local LLM: plot, then per-shot CSV (src/services/actionProse.mjs,
       bundled llama-server sidecar, prompts compiled in code via promptCompiler.js)
    → V-gate: ltx_prompt_lint.py + JSON schema + one repair retry
       (src/services/shotPlanValidator.js against src/schema/shotPlan.schema.json)
    → plan.json → render/stitch (src/services/musicVideoRender.js)
Electron main wires it: electron/main.js → electron/musicVideoIpc.mjs →
   src/services/musicVideoPipeline.js (IPC events mv:progress / mv:complete / …)
UI: src/components/MusicVideoEasyMode.jsx, GenerateWorkspace.jsx
   (master director prompt: buildMusicVideoLLMPrompt, ~line 2348)
```

Decision record for this architecture: `docs/plans/one-shot-redesign.md`
(in-repo) / `~/.hermes/plans/belrog-oneshot-audit-and-redesign.md`.

## Release state

- Latest assets published: **v0.6.5** (4 assets) and **v0.6.51** (fix for R4).
- Release procedure: `docs/AI_RELEASE_HANDOFF.md` + `docs/RELEASE_PROCESS.md`.
- Releases are drafts; verify 4 assets before publishing; never let signing
  block artifacts.

## Stale instruction cleanup (2026-11-28)

Archived (do not read as current): home-root `belrog-*.md` ×5,
`~/projects/BELROG LTX-DIRECTOR SCRIPT GENERATOR INTEGRATION/`, the 0.4.x-era
`belrog-maintenance` skill body, and `backUP01_PROJECT_SUMMARY.md`.
Everything is preserved in `~/backups/belrog-instructions-2026-11-28/`.
Authoritative instruction files are exactly: `AGENTS.md`,
`docs/AI_CURRENT_HANDOFF.md`, `docs/AI_PROJECT_CONTEXT.md`,
`docs/AI_RELEASE_HANDOFF.md`.
