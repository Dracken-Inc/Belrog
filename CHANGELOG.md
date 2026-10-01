# Changelog

## v0.4.2 (Belrog 0.4.20) — 2026-10-01

### Asset library (the visible part)
- **New "5. Assets" tab in the Director workspace** — a real, always-visible place to manage reference entries. Manual add form (Type: Character / Prop / Location + Name + Description), full entry list with reference-image thumbnails, **editable descriptions** (the text you type is exactly what the reference generator uses), per-entry **Generate/Regenerate** and **Delete**, plus a "Detected from the current script" strip with one-click "Add all".
- **Import / Export are always visible** in this tab (not only when the library is non-empty), so the library is a destination you can go to rather than a panel that appears out of nowhere.
- **Gap detection now only runs on the master plan** (alt passes build with an empty cast by design, so unresolved-artist warnings there are noise, not gaps).

### Remote ComfyUI — workflow-setup install actually works now (was dead in remote mode)
- **The installer no longer demands a local ComfyUI folder in remote mode.** Previously, both the renderer and the main process validated the *local* `comfyRootPath` before ever reaching the remote branch — so with the tunnel up and the remote roots configured, workflow-setup install still failed with "Choose a valid ComfyUI folder" while the ComfyUI tab worked. Remote mode is now resolved first; the local root gate is bypassed and the remote root is validated over SSH instead.
- **Misconfigured remote mode fails loudly** (remote on + tunnel active + Models Root empty) with the correct "set the Remote ComfyUI paths in Settings" message, instead of silently falling back to a local install.
- Clearer "Remote ComfyUI paths not set" UI in the setup panel when that's the actual problem.

## v0.4.1 (Belrog 0.4.10) — 2026-09-30

### Bug fix (critical)
- **"Load in ComfyUI" now actually loads the selected workflow.** The v0.34.0 frontend boots, loads its default/persisted graph (~1.6 s after start), and only then settles. The old injector fired as soon as the load function *existed* — so the injected graph was clobbered by the boot load and you were left staring at the default template. The injector now waits for the frontend's boot-time graph load to **settle** (node count stable across samples) before injecting, then **verifies** the node count landed and retries (up to 8 attempts) instead of claiming success. The renderer now reports a verified claim ("N nodes confirmed on the canvas"). Verified live against the running ComfyUI v0.34.0: early injection at 1.2 s — previously crashed with `Cannot read properties of undefined (reading 'setGraph')` — now loads all 94 nodes of the 2511 multi-angles workflow stably. Bonus: the v0.34.0 draft store keeps the loaded workflow across reloads.

### Director workspace (new)
- **Asset library** — a persistent (localStorage, cross-project) character/prop/location reference store. After building a director-script plan, a "Missing references" panel reports gaps: unresolved cast names (characters) plus props/locations mentioned across multiple shots. One click stubs them into the library with their verbatim script description and shot provenance; re-runs are idempotent (only genuinely-new items are added).
- **Regenerate-All** — queues a `z-image-turbo` reference-sheet job for every library entry that has a description but no reference image yet. Entries without a description are skipped with a reason (no garbage generations), the queue is capped at 50 with a "N more wait" note, and a time estimate is shown. Generated reference images wire back to their entry on completion so the next run skips them.
- **Export / Import** — the library exports to a portable JSON file and imports merge-safely (known slugs keep the local id and your verbatim description; unknown slugs are added with fresh local ids).

### Remote ComfyUI mode (server routing)
- **Workflow-setup installs now run on the remote server in remote mode.** Model downloads execute server-side (aria2c with wget/curl fallback, resumable, detached via `nohup` so the SSH tunnel can't stall them), with a disk-space preflight, stall detection during the poll, and sha256 verification after the download. Node packs route through the existing remote installer. All helpers are pure and tested with an injectable command runner (10/10).
- **Mode-explicit connection resolver** — the embedded ComfyUI tab and every ComfyUI action now resolve against the mode you actually selected (local vs. remote) instead of implicit fallback.
- **Verified sha256** added to the 2511 multiple-angles LoRA recipe (hash matched against the on-disk file) so the remote installer can verify it end-to-end.

### Models
- Multiple-angles keyframe workflows pinned to the 2511 stack (checkpoint + Lightning LoRA + multi-angles LoRA).

### Tests
- New `scriptGapDetection` suite (14 tests) including the **golden director-script format pin** — if the script format ever drifts, CI fails instead of silently producing wrong reference stubs.

## v0.4.0 (Belrog 0.4.00) — 2026-09-29

### Security
- **SSH key material removed from full git history.** `ssh-keys/` (an OpenSSH private key used for passwordless Belrog → server SSH) had been removed from the working tree in September, but remained recoverable from history via `git show <old-commit>:ssh-keys/id_rsa`. The entire 420-commit history was rewritten (git-filter-repo) and force-pushed; the key is now absent from every commit on `main`. The pre-rewrite bundle is stored off-repo. The exposed key must be treated as revoked and rotated.

### Keyframes (music video generation)
- **Qwen-Image-Edit 2511 is now the default local keyframe model.** Bundled workflows (`image_qwen_image_edit_2509.json`, `image_qwen_image_edit_2509_Model_and_Product.json`) and the dependency-pack checklist now point at `qwen_image_edit_2511_bf16.safetensors` + `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors`. 2511 measurably separates scene change from identity preservation (A/B tested on the real GPU against the 2509 clone).
- **Face-only preservation prompt dialect.** Keyframe shot prompts now order the model to keep the face only and fully re-dress/re-stage (replacing the wardrobe-lock `continuityFocus` wording that fed the clone). `QWEN_KEYFRAME_EDIT_PREFIX` / `QWEN_KEYFRAME_NEGATIVE` live in `musicVideoShotConfig.js` as a single source of truth.
- **Negative conditioning no longer clobbered.** `modifyQwenImageEdit2509Workflow` writes the negative prompt into `TextEncodeQwenImageEditPlus` negative nodes instead of the positive prompt, and sampler overrides (steps/cfg/denoise) are null-safe so existing Lightning 4-step defaults are preserved.
- Install catalog now ships verified download recipes for the 2511 checkpoint (40.9 GB BF16) and its Lightning LoRA.

### Timeline (Resolve-21 look)
- **Eased auto-follow.** During playback the timeline no longer snaps `scrollLeft` every frame; a rAF loop eases toward the follow target so the view glides (same cached-metric discipline — the hot path stays pure arithmetic).
- **Playhead polish.** Gradient shaft, tighter glow, larger gradient handle with crisper shadow.
- **Clip polish.** Video clips gained subtle inset top-highlight/bottom-shadow depth and the selection ring is now Resolve-style orange.

### App icon & Windows installer
- New icon: **B wreathed in flames** (regenerated, vision-verified 9.5/10). Replaces the prior "B + film strip" mark in `build/icon.{png,ico,icns}` — Windows exe icon, Linux icons, and macOS all pick it up.

### Build / CI
- `Release Desktop Builds` gains two dispatch inputs:
  - `sign` (`true`/`false`, default `true`) — `false` produces **unsigned Windows test builds**: Azure secrets are not required and `azureSignOptions` is stripped before packaging.
  - `build` (`all`/`windows-only`, default `all`) — test builds can skip macOS/Linux runners.
- Version bumped `0.3.32` → `0.4.0`.