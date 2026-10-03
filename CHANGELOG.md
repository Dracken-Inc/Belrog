# Changelog

## v0.4.85 (Belrog 0.4.85 — hotfix 0.4.8.5) — 2026-10-03

### Floating text in keyframes
- **Fixed: garbled captions/subtitles/graffiti appearing in generated keyframes.** Qwen-Image-Edit ignores negative prompts, so the "no text/subtitles" terms there did nothing. The edit instruction now states positively that the frame contains no captions, subtitles, burned-in text, lettering or graffiti and that walls are bare.

## v0.4.84 (Belrog 0.4.84 — hotfix 0.4.8.4) — 2026-10-03

### Two-face cloning and chorus teleporting — found by testing the real "What You Say to Me" project
- **Fixed: multi-character shots rendered two copies of the SAME person.** When a keyframe named both cast members ("g1 and h1 both in frame") but the `Artist:` line listed only one, the shot received a single reference image — and Qwen image-edit cloned that one face to fill both people. The planner now scans the keyframe prose for cast members the Artist line missed and fills both reference slots (warning `artist-added-from-keyframe` names the addition).
- **Fixed: repeated lyrics (chorus) teleported shots to the FIRST occurrence.** `Lyric moment: "What you say to me?"` matches the SRT at both 0:39 and 3:59 — the fuzzy matcher always returned the first hit, so 39 of 53 shots got displaced and the timeline played the song out of order (47 tiling breaks in the shipped project). Matching now collects ALL occurrences and picks the one closest to the script's `Start at:` (or the running cursor), so shots stay in song order.
- **Internal:** `findLyricLineIndexes` (all matches) added; `findTimedLyricLineByText` accepts a `preferNearSec` anchor; C4 24/24, mutation battery 11/11.

## v0.4.83 (Belrog 0.4.83 — hotfix 0.4.8.3) — 2026-10-03

### Adversarial testing: the suite now proves it catches BAD scripts, not just good ones
- **New: legend contract auditor.** A declared legend is now validated instead of silently cleaned — duplicate slugs, the same slug declared under two cast types, missing `location_`/`prop_` prefixes, and duplicate human names all produce visible problems with severity + message. Nothing is auto-repaired; the script (Director Suite) is the place to fix it.
- **New: legend problems banner in Cast Manager.** Any contract violation from the current script shows as an amber banner in the detection panel (⛔ error / ⚠ warning), so bad scripts are loud instead of quietly guessing a winner.
- **Changed: duplicate legend lines are kept in the parse and deduped at detection.** Previously the parser silently dropped the second `location_dpf` — the effect looked correct but nothing ever caught it. Now generation stays single-entry while the duplicate is reported.
- **New: mutation battery (`legendMutation.test.mjs`, 11 tests).** The golden fixture gets poisoned with 7 violation classes at randomized legend positions across 200 seeded runs; every poisoning must be caught — 100% catch rate, no tolerance. Includes a red-team meta-test: with the auditor stubbed to always-pass, the battery fails 10/11 (proven by running it), so the suite cannot pass vacuously.
- **Internal:** C4 24/24 + mutation battery 11/11.

## v0.4.82 (Belrog 0.4.82 — hotfix 0.4.8.2) — 2026-10-03

### The Director Suite golden fixture is now law — and it caught one last leak on our side
- **Fixed: coverage `Purpose:` lines leaked into asset detection.** The parser glued the `Purpose: …` line onto the coverage label ("Main" + "Purpose: …"), and the heuristic then offered "Main Purpose" as a fake location suggestion. Labeled lines inside coverage blocks are no longer appended to the label, and `Purpose:`, `Coverage`, `Lyric moment:`, `Start at:`, `Length:`, `Seed base:`, `Chain:` are hard-blocked as structural labels.
- **New: the Director Suite's v2 script format is pinned as a golden regression fixture** in the test suite (verbatim generator output: pipe legend with `location_`/`prop_` slugs, token+delta shot modules). Parsing that script now provably produces exactly the four declared Cast entries, correct names/slugs/types, and ZERO heuristic suggestions. If a future generator or parser change breaks the contract, this test fails before Henry ever sees a bad script.
- **Internal:** C4 suite 24/24.

## v0.4.81 (Belrog 0.4.81 — hotfix 0.4.8.1) — 2026-10-03

### The Cast-detection trust fix: legend-only stubs, real slug grammar, underscore-safe slugs
- **Fixed: junk stubs from prose are gone.** When a director script declares an ASSET LEGEND, only legend entries are auto-created in Cast Manager. Heuristic prose guesses are now suggestion-only (visible in the gaps panel, one click to add, never silent). This kills the "character listed as location" and "shot-type-b-roll became a place" class of bugs at the root.
- **New: canonical legend grammar** — `TYPE: Name | slug | description` (Henry's format). Location and prop lines carry a human Name (Pine Forest), a short slug (`location_dpf`, `prop_cassette`), and the description in exactly one place. Legacy `slug — description` lines still parse.
- **Fixed: underscores are now meaningful in slugs.** `location_dpf` stays `location_dpf` end-to-end (parser → library → collision checks → queue matching). Previously every layer slugified underscores to hyphens, silently breaking slug ↔ `(token)` ↔ `<slug>.png` byte-matching.
- **New: shots reference locations/props by token.** `LOCATION: (location_dpf), fog thicker…` resolves the library entry's image AND injects its legend description at generation time — the description is never re-pasted per shot, so a fixed description fixes every shot.
- **Internal:** legend parse, underscore-safety, and pipe grammar pinned by C4 regression tests (23/23); queue token matcher accepts `(slug)` and legacy `slug:` forms.

## v0.4.8 (Belrog 0.4.80) — 2026-10-02

### Locations join the cast: a Locations card in People, location reference images in generation, honest Add buttons
- **New: Locations section in music Step 2 (People)** — every Cast-library location now gets a row directly under Cast References: name, script slug, reference image, one-click reference-sheet generation, and jump-to-Manage-Cast editing. No more hunting through the manager to see what the video actually uses.
- **New: "in script" badges** — each location row is checked against every `LOCATION: slug:` directive in the master script AND all alt-pass scripts. Green = this location is really used by shots; gray = it exists but nothing references it. Slug drift (the #1 silent failure) is now visible at a glance.
- **New: location reference images reach generation.** Previously locations only entered keyframes as text. Now, when a location has a reference image, the keyframe queue resolves each shot's `LOCATION:` slug against the Cast library at queue time (re-scanned per queue, so images generated after the plan was built still apply) and attaches the image: environmental/detail b-roll gets the location image as the primary anchor; performance shots keep the performer's face primary and get the location as the second reference — a location image can never replace a face as identity source.
- **Fixed: Cast manager "+ Add" looked like a no-op** — the added row now highlights for ~2.5s, and if your active filter or search would hide it, they're auto-reset so the row appears. The click finally shows its result.
- **Internal:** `flattenYoloPlanVariants` now carries `keyframePromptRaw`, `motionPromptRaw`, and `resolvedLocationAssetId` onto every variant (regression-pinned in C4, test 22); `MusicVideoEasyMode` receives `yoloMusicAltScripts`; C4 suite 22/22.

## v0.4.7 (Belrog 0.4.70) — 2026-10-02

### Inline asset directives: the Perchance director-list format is now first-class
- **Fixed: scripts in the LTX director-list format (inline `LOCATION: slug: description` directives inside keyframe prompts, no legend block) detected nothing or garbage.** Parsing 0.3.32 and 0.4.2 against the same script produced byte-identical contaminated keyframes — the format was never supported. `parseInlineAssetDirectives()` now extracts LOCATION/PROP/CHARACTER declarations from anywhere in the script, dedupes by kind+slug, strips director-list boilerplate ("establish architecture, spatial relationships…"), and skips negative directives ("CHARACTER: no person visible"). Detection treats them as authoritative, same as the 0.4.5 legend.
- **Fixed: the 0.4.5 legend path was silently dead** — `parseAssetLegendLines` was called in `GenerateWorkspace.jsx` without being imported, and the surrounding `try/catch` swallowed the ReferenceError, so legend detection never ran. Import added and verified.
- **Fixed: brief-echo contamination in every keyframe/motion prompt.** The no-lyrics branch of the LLM brief closed its parenthesis early, letting the next instruction ("The script timeline MUST cover…") bleed into shot text — the LLM faithfully echoed it into all 50 shots. Bug present since v0.1.11 (April 2026); the first instrumental brief exposed it. Brief line made self-contained, format rules 11+12 added (ASSET LEGEND required, brief-echo forbidden), and `stripBriefEcho()` scrubs echoed blocks at parse time with brief-only vocabulary anchors (scene prose like "must show on screen" untouched). Verified: your 50-shot test script, 200 contaminations → 0.
- **Fixed: `"Shot type: b_roll"` quoted inside shot text normalized to `shot-type-b-roll` and escaped the structural-label blocklist** (the 0.4.6 check compared the whole candidate, not the label before the colon). Candidate-head check added.
- Tests: 21/21 (2 new: inline directive extraction + structural-fake suppression end-to-end). RIFE 43/45 unchanged (pre-existing host-ffmpeg sha256 gate). Build green.

## v0.4.6 (Belrog 0.4.60) — 2026-10-02

### Hotfix: structural labels can never be detected as assets again
- **Fixed: `Shot type: b_roll`, `CONTINUITY RULES`, and `DIRECTOR STEER` surfacing as three fake locations with nonsense slugs.** They leaked through the heuristic when echoed INSIDE keyframe/motion text (the 0.4.5 fix only blocked them as standalone lines and inside the legend path). All LTX structural labels (`shot type`, `continuity rules`, `director steer`, `camera`, `keyframe`, `motion`, `b roll/b-roll/b_roll`) are now in the structural-marker blocklist at every detection layer.
- Regression test added (structural labels in shot text → zero entities). Suite: 19/19.

## v0.4.5 (Belrog 0.4.50) — 2026-10-02

### Asset Legend: your script now names the Cast, not the guesser
- **Asset legend at the top of the director script is now authoritative.** Declare `slug : description , TYPE` (or `TYPE: slug — description`) lines before the first scene; parsing creates Cast entries with those EXACT names + descriptions. Heuristic guessing remains only as a fallback for undeclared assets, and any guess whose slug matches a declared asset is dropped.
- **Fixed: section headers (`Shot type: b_roll`, `CONTINUITY RULES`, `DIRECTOR STEER`) could appear as detected locations.** Legend lines are excluded from scene/shot text at parse, structural markers are filtered at detection, and a declared PROP/LOCATION can no longer survive as a wrong-kind heuristic entry.
- **Editable Name + Slug on every Cast entry** — display name free-form, slug collision-safe ("slug already taken" surfaces a clear notice). Description editing carried over from 0.4.4.
- **LTX director prompt template** now instructs the AI to emit the asset legend before the first scene, with slug-must-match-`Artist:`-token rules. `docs/RELEASE_NOTES_0.4.5.md` carries the paste-ready Perchance fragment for the director list.
- Tests: 18/18 (4 new: both legend forms, authoritative naming + zero header leakage, legend-suppresses-heuristic both directions, collision-safe rename). RIFE 43/44 unchanged (1 pre-existing host-ffmpeg).

## v0.4.4 (Belrog 0.4.40) — 2026-10-01

### Auto-stub: parsing a director script fills Cast by itself
- **Characters, props, and locations detected in your parsed director script are now added to the Cast library automatically** (idempotent — re-parsing the same script adds nothing). No manual "add to cast" needed.
- **Detected stubs get a real description seeded from the shot's keyframe text**, so Regenerate-All (Generate all) can immediately create their reference images instead of skipping them as "needs-description".
- **Fixed the silent reason props/locations were never detected on music-video plans:** the music plan dropped the raw keyframe/motion prompt fields that detection scans, so it was scanning empty text. Raw prompts now pass through.
- **Fixed shot indexing:** detection previously trusted `shot.index`, which the music plan hardcodes to 1 on every shot (and the parser restarts at 1 per scene) — collapsing the multi-shot frequency filter. Now uses a running 1-based flat index that matches the warnings' `shotIndex`.
- **People tab (music workflow): "Import from Cast" dropdown** — pulls a Cast character into the video's cast with name, slug, and reference image carried over. Already-in-cast entries are disabled. Replaces the dead-end "Add to Cast" strip.
- **"Manage Cast" button** in the music workflow opens the full Cast panel in a modal (the left sidebar with the Cast tab only exists in the main editor — the music workflow has no sidebar).
- **Cast panel upgrades:** single-entry selection, right-click context menu (Generate/Regenerate reference, Edit description, Export entry as importable single-entry JSON, Delete).
- Pipeline verified end-to-end against the real parser: script → parse → detect (character + location) → auto-stub with seeded descriptions → re-parse adds 0 → Generate-all queues all entries.

## v0.4.3 (Belrog 0.4.30) — 2026-10-01

### Cast — the official character/prop/location management window (left panel)
- **New "Cast" tab in the left panel** (under Assets, next to Text/Effects/Settings) — the official home of the reference library. Always visible and fully functional when empty: manual add form (Character / Prop / Location + name + description), filter tabs with counts, search, reference-image thumbnails, **inline-editable descriptions** (the text is exactly what the reference generator uses), per-entry **Gen / Re-gen / Delete**, **Regenerate-All**, and always-visible **Export / Import**.
- **Global shared library.** Cast, the Director "Assets" tab, and the People-tab detection all read/write ONE library (new `assetLibraryStore`), so an entry added in Cast is immediately usable in the Generate workspace and vice versa.
- **Generate from Cast works even before the Generate tab is open.** The Cast panel queues reference generations through a small bridge; the Generate workspace drains it on mount and on each request, routing them through the same `z-image-turbo` reference-sheet jobs (and wires the finished image back to the entry).
- **Director Script → People tab** now shows a "Detected from your Director Script" strip (unresolved cast names as characters, multi-shot props/locations) with one-click **Add to Cast (N)** — idempotent, re-runs only add what's new.

### Verification
- Store + bridge + detection verified by Node smoke test against real field shapes (idempotent re-runs add 0, import preserves local id + asset wiring, no duplicates).

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