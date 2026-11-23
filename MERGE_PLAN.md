# Belrog ← Velorn Merge Plan (merge-velorn branch)

Date: 2026-11-22 · Prepared mid-merge, branch `merge-velorn` in `/home/henlafon/belrog-src`
`main` is untouched and green (28/28 tests, pushed to `1a13ef9`).

## 1. Objective

Take the upstream Velorn codebase (what Belrog was before the rename/scrub) up to its
current root — 336 commits of editor work we never had — and re-apply everything Belrog
built since the May fork point, so the merged product:

1. Keeps every Belrog-only capability (list in §4) working exactly as on `main`.
2. Gains upstream's editor improvements (captions, audio mix, export paths, GPU compositor).
3. Builds, passes the full test suite, and stays local-mode: no account service,
   no spending gates, no cloud router. Our desktop app talks to local ComfyUI only.
4. Never says "Velorn"/"ComfyStudioPro" anywhere in UI strings.

Definition of done: merge committed on `merge-velorn`, `npm run build` exit 0,
`npm test` fully green, branding grep clean, then (separate approval) GPU smoke.

## 2. Divergence ground truth (measured, not estimated)

- Fork point (merge-base): `aa280f7`, 2026-05-14.
- Ours since: 369 commits (`aa280f7..main`). Upstream since: 336 commits.
- 293 files conflicted in `git merge upstream/main`.
- Upstream added a commercial cloud layer tangled through shared files:
  `comfyRouter.cjs`, generation spending gates, phone approval, crash recovery,
  account/engine-lease `setupHelper`, `veloDesktopEngine`. We do NOT run these;
  files stay (inert) but nothing of ours may depend on them.
- Both trees grew in the same files for 6 months (GenerateWorkspace.jsx:
  ~2,000-line direct delta; mcpServer.js: 318 conflict regions).

## 3. Approach (agreed)

Upstream-wins base + Belrog retrofit, not a symmetric merge:

1. Branch = upstream files everywhere shared code conflicts; our new standalone
   files land as-is (they don't collide).
2. Our edits inside shared files are replayed deliberately, one work package at a
   time, each with a check — not trusted to a blanket merge.
3. Docs/branding = ours wholesale.
4. Two binary splash/hero images = ours (Belrog art) — still unmerged, see WP-A.

## 4. Belrog-only feature ledger (must survive — the retrofit checklist)

From `git log aa280f7..main`, grouped; every item here must be verifiable on the branch.

| # | Feature | Key files (shared files marked *) | Status in merge tree |
|---|---------|-----------------------------------|----------------------|
| F1 | ONE-SHOT H3 engine (headless chain runner, script→clips compiler, disk-truth watcher, smoke-all) | scripts/oneshot/*, src/services/h3OneShot.js (+test), scripts/smoke-all.sh | files PRESENT; *runner final-stage wired to F8 |
| F2 | Suno intake (m4a→tiled director script, deterministic) | src/services/sunoIntake.js (+test), scripts/oneshot/suno-script.mjs | files PRESENT |
| F3 | Integrity gate (final artifact proves audio+duration before `verified`) | *h3OneShot.js auditFinalArtifact, *run-oneshot-chain.mjs | PRESENT in files; verify wiring survived |
| F4 | Cast / asset library / director legend (legend-driven detection, legend contract auditor, locations cards, two-person keyframe identity mapping, golden fixture v2) | *GenerateWorkspace.jsx, *InspectorPanel.jsx, *yoloPlanning.js, src/components/panels/CastPanel.jsx, *AssetLibrary panel | files PRESENT; *wiring into shared components needs WP3 |
| F5 | Lyrics-timed shot grid (nearest-occurrence SRT matching, Start-at, clip-grid ceil math, no 15s clamp) | *MusicVideoEasyMode.jsx, *audioAnalysis.js | ours-dropped in shared files — WP3 |
| F6 | AutoChainAudio slot contract (prompt=4, chain_config=5) + live object_info validation in workflow builder | *comfyui.js or builder module, *workflowRegistry | WP3 |
| F7 | Whisper caption engine (mac/linux build) | *captionWhisper.js, .github/workflows/whisper-mac-engine.yml | PRESENT; workflow file took theirs — replay ours |
| F8 | MCP server additions (our action set) | *electron/mcpServer.js, *src/services/mcpActions.js, *mcpSnapshot, .mcp.json | ours-dropped in mcpServer — WP3 biggest item |
| F9 | vLLM policy in oneshot (never kill; container `qwen38-flash` check; memory math warnings) | scripts/oneshot/*, smoke scripts | PRESENT |
| F10 | Branding: Belrog/Dracken names, icons, splash art, README family | 13 branding-only files + icons + splash | WP4 wholesale re-apply |
| F11 | Port 8052 local dev/serve values | *electron/main.js | WP3 one-liner |
| F12 | Release workflow (tag-only v* triggers, our vars) | .github/workflows/release.yml | theirs won — replay ours §WP5 |

## 5. What happened on the branch so far (audit trail)

1. `git merge upstream/main --no-commit` → 293 conflicts.
2. Docs/branding/metadata → ours (verified rule).
3. All other conflicts resolved "upstream base, replay our delta"; replay used
   `git apply --3way`, whose failures ROLL BACK SILENTLY → 199 files ended up pure
   upstream with our in-file edits missing. Files not touched by upstream all kept
   our versions. **No feature file is lost from history — everything in §4 is
   recoverable via `git show main:<path>`.** This is the retrofit list, not a rescue.
4. Remaining index conflicts: `public/hero-v1.webp`, `public/splash.png` (take ours).
5. Nothing committed, no push, `main` clean.

## 6. Retrofit work packages — FINAL STATUS (2026-11-23)

- **WP-A binaries**: DONE (ours, in merge commit).
- **WP-B package.json**: DONE (27015c0, 418727a) = upstream base + Belrog
  identity keys + version 0.4.9 + union deps (+5 upstream-new) + their
  scripts block. NOTE: the first take-ours pass had silently made it pure
  upstream — caught by version probe, not by a test.
- **WP-C mcpServer**: DONE as NO-OP. Action-name sets proved subset-equal
  (ours 128 ⊂ theirs 134); no action graft needed. The "318-conflict monster"
  was context conflict, not feature divergence.
- **WP-D semantic graft**: DONE via recipe below — LeftPanel CastPanel mount
  (962b1f5) + 9-file graft incl. MusicVideoEasyMode, yoloPlanning, mcpActions,
  comfyui.js, InspectorPanel, GenerateWorkspace, main.js, preload, audioAnalysis
  (67c9c9c), zero conflict markers.
- **WP-E main.js/preload**: DONE via graft. NOTE: "port 8052" never existed in
  the repo (memory artifact) — VOID item.
- **WP-F branding residue**: PARTIAL — build-loop fixed VELORN_OPEN_STOCK_EVENT
  globally + musicVideoShotConfig graft (fix round). Remaining velorn tokens
  in UI strings pending a pass; does not break build.
- **WP-G CI/.mcp.json/scripts**: DONE (ours kept).
- **WP-H verify**: build GREEN (✓ 15s). Full 422-file sweep = the live gate.

### Graft recipe that worked

Per file: `git checkout --theirs -- <p>` (pure upstream base), then
`git diff upstream/main main -- <p> | git apply --3way -`. Direct branch-to-
branch diff on a clean base applied clean 9/9. The earlier silent failure came
from replaying `aa280f7..main` (stale base) onto conflicted files — wrong base,
wrong starting state. Branding renames must be GLOBAL (exporter + importers);
renaming only the exporter fails the build loop.
- **WP-J commit merge** on branch, list deviations in commit message.
- **WP-K (needs Henry)**: GPU smoke — 60s clip on generated script, within his cap,
  vLLM policy respected. Full *Forsaken, Falling* render only after smoke green.

## 7. Open decisions for Henry

1. Upstream's commercial files (comfyRouter/account/spending): keep inert in tree
   (default, least breakage) vs strip now? Recommendation: keep inert, strip later.
2. Upstream renamed editor features that reached users (Discover tab, cloud-lite):
   take upstream UI text as-is for now, Belrog-rename in WP-H — confirm.
3. After branch is green: merge to main as-is, or squash-merge so main history stays
   clean? Recommendation: merge commit (keeps upstream traceability for future pulls).
4. Tag/ship: no tag until WP-K smoke passes.

## 8. Rules enforced throughout

- main stays protected until this branch is fully green + Henry approves.
- No GPU generations without explicit go; 16 GB short-batch cap when he gives it.
- Scripts never kill vLLM.
- Every replay verified by reading the result, never by "command exited 0"
  (this merge already produced two false-greens from silent rollbacks).

## 9. Final sweep classification (422 files / 5234 tests: 5195 pass, 12 fail)

RED-ON-UPSTREAM (each proven against upstream's own files; do not chase here):
- comfyRouterPackaged.test.cjs x5 - wiring-region asserts contradict upstream main.js.
- exportPresetLibrary.test.mjs production* x3 - stale electron stubs (no setNavigationHandler).
- localAgentDesktopChatHarness.test.cjs x3 - harness asserts a media-instruction
  sentence ('To SHOW a preview to the user in chat') that exists in NO app file of
  either branch; upstream rc1 shipped harness and prompt out of sync. ACTION (WP-I):
  when Belrog next edits connectedAgent TOOL_INSTRUCTIONS, add that media line -
  harness then goes green as a side effect. Do not fake it.
- runtimePackageGate 'installed native FFmpeg' x1 - upstream ships native-media pins
  for linux-x64/darwin only; this box is linux-arm64. ACTION (WP-P): choose trusted
  arm64 FFmpeg build + pin sha256 before any Spark-shipped build. Host ffmpeg has
  minterpolate; runtime path unaffected - packaging gate only.

FIXED BY US DURING MERGE (Belrog features the merge had eaten):
- repeatedLyricMatch: findTimedLyricLineByText param nearSeconds (was preferNearSec)
  - nearest-chorus-repeat beat-sync law.
- veloOwnerTestGateway: owner-metered candidate banner + 'Provider status
  unavailable' fallback now rendered in src/main.jsx (was contract-without-UI upstream).
- F11 settings tab (SettingsModal/useWorkflowSetupFlow) + preload invoke/flat aliases.
- compoundAudioNative/export-cancel/connectedAgentEditing clusters.
