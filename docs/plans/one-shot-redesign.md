# Belrog one-shot pipeline — audit findings and rebuild plan

Date: 2026-11-27 · Workstream: W13 · Repo: `~/belrog-src` @ `a85faf1` (v0.6.3)
Scope: replace the Suno-track → music-video one-shot pipeline. Zero GPU used for this analysis.
Companion evidence: `~/.hermes/plans/belrog-oneshot-audit-and-redesign.md` (defect detail A1–A10, audio timing PART 7).

---

## 1. Why the current output looks like gibberish

Six independent defects, all confirmed by reading code — no speculation.

**1.1 The director never receives a prompt.** `sunoIntake.js:243` writes the literal string
`Keyframe prompt: [placeholder] … Waiting for the director to write this frame.` into every shot.
The compiler forwards it. Every frame in the video is instructed by the word "placeholder".
39 of 39 clips had zero visual content.

**1.2 The cast list is made of guitar riffs.** `harvestCastSlugs` (`sunoIntake.js:128`) treats any
bracketed line not in an 8-item blocklist as a person. Suno puts **mixing directions** in brackets, so
`[distorted guitar swells]`, `[full band]`, `[aggressive screams]`, `[heavy distorted guitars]` became
15 cast entries, and `locationHint` then searched those strings for place words. Location, props and
characters are all corrupted from this one classifier.

**1.3 Timing comes from line count, not audio.** The Suno `lyrics` tag has no timestamps, so
`parseLyricBlocks` (`:50`) spreads lines evenly — 3.71 s each for the test track. Measured envelope
puts the real section changes at 17.0 / 39.3 / 67.3 / 156.0 / 172.4 / 231.6 / 258.4 / 276.3 s; the
even model puts Chorus 1 at 45.8 s instead of 39.3 s and error grows inside sections. On top of that,
frame-grid snapping rounds every clip up: the chain asks for **306.33 s of video for 283.56 s of
audio (+22.8 s)**.

**1.4 Shots and clips are different lengths.** The script tiles a shot per line (39 for the test
track); the chain builds clips from `planChain` (14). Clip N reads prompt N — clip 14 plays at 269.8 s
with the prompt written for 94.1 s. Nothing anywhere checks that the two numbers agree.

**1.5 There is no script parser.** `MUSIC_VIDEO_SCRIPT_TEMPLATE` documents the DSL and `sunoIntake`
writes it, but **nothing in `src/` reads it back** — the only writer/parser pair is the auto-generator
itself. Everything typed by hand goes through the director as free text. This is precisely the
"script → LTX director formatting fails" complaint: the format is documentation, not a contract.

**1.6 The graph is hand-spliced with no check.** All five Oct 3 smoke runs died *before* generating a
frame: `H3ChainContextPackToClips` linked to `slot_0000` (fixed in `346f0e9`, never retested) and
`CFGGuider.model` linked to the CFGGuider's own output — a self-reference ComfyUI rejects at
validation. The only validator today is the ComfyUI queue.

---

## 2. Design decisions (locked by Gracey, 2026-11-27)

| | Decision |
|---|---|
| D1 | **LTX-2.3 per-shot + ffmpeg stitch.** H3 auto-chain stays reachable behind `--engine h3`, off by default |
| D2 | **Delete the `TextGenerateLTX2Prompt` enhancer subgraph** from the workflow JSON. Prompts are compiled in code |
| D3 | **One interface, three backends** (Gracey ruling, 2026-11-27), chosen by availability in this order: **`local`** = a bundled **`llama-server` sidecar**, shipped exactly like RIFE (`extraResources/llama-runtime/${os}-${arch}/`), spawned on a loopback port, killed when the app quits; the GGUF auto-downloads from Hugging Face on first use into the app-data dir and is handed to the sidecar as `--model`. Because the sidecar speaks the OpenAI-compatible API, **the existing `lmstudio.js` client drives it with only a base-URL override — no new client code**. **`lmstudio`** = opt-in, same client, different base URL, for users already running LM Studio on `localhost:1234`. **`openrouter`** = `:free` fallback only. `node-llama-cpp` is **demoted to a documented alternative** (see §2.1). No WebGPU/browser inference, no vLLM, no llama-node/ctransformers. Weight target (Henry): **4–6 GB VRAM working set, long-form creative prose, very fast decode; tool-calling and vision irrelevant**. **W15 owns the GGUF pick** — W15's doc still says "default openrouter, lmstudio opt-in", which the 4–6 GB envelope supersedes; the pick is open, this plan does not invent one |
| D4 | **One `--single` low-res clip** must pass before any full run |
| D5 | **Prompt-only cast identity** unless Henry supplies a reference sheet |
| Timing | **Audio envelope analysis, never even-spread** |

**Style brief (Henry):** late-1990s professional MTV grammar — Fincher / Gondry / Jonze / Hype
Williams / Romanek. Performance shots intercut with narrative b-roll, cut on the beat, dutch tilts,
Steadicam, dolly zooms, whip pans, crane, hard backlight + colored gels + smoke, film grain,
anamorphic letterbox, industrial and night locations.


### 2.1 Why the sidecar and not `node-llama-cpp` (documented trade, per ruling)

`node-llama-cpp` stays a supported alternative, not the default. What it **buys**: in-process
inference (no second process to spawn, health-check and reap), grammar-constrained decoding through
`createGrammarForJsonSchema()`, and GPU backend auto-detection without shipping a runtime.
What it **costs**: it would be Belrog's **first ABI-bound dependency** — the repo today has no
`asarUnpack`, no `npmRebuild` and no `@electron/rebuild` (`package.json` `build` block, verified), with
ffmpeg, ffprobe, RIFE and whisper all delivered as per-platform binaries through `extraResources`.
Adding it means an Electron-ABI rebuild for win/mac/linux, unpacking its `.node` from the asar or the
`require` fails inside the archive, and choosing CUDA/Metal/Vulkan at build time — all of it landing on
the release workflow that just had its signing repaired. The sidecar reuses a packaging path this repo
already runs in production, and keeps inference out of the app process either way.

Reopen this only if the sidecar's process management proves unreliable in practice; the interface in §5
means the swap does not touch the pipeline.

---

## 3. The contract: `plan.json`

**Frozen. The contract is the file, not this section:**

> **`src/schema/shotPlan.schema.json`** — commit `d081731`, branch `feat/shot-plan-schema-freeze`
> (`npm run test:shot-plan-schema` guards it)

Everything above the fold in this section used to restate that schema inline, and a restatement is
exactly the two-vocabulary bug we are trying to kill, so it is gone. Read the schema file. What follows
is only what cannot be seen inside it.

**Change control (Gracey, 2026-11-27).** Schema v1 is frozen. W-A and W-B build against it; neither
edits it. A change goes to Gracey, who arbitrates, and the freeze test fails any drift the arbitration
misses — an id the config does not ship has to be declared in the test's `PENDING_VOCAB` or the build
goes red.

**W15's obligation is specific:** the `response_format.json_schema.schema` handed to the model **must BE
this file**, loaded and passed through, not a parallel description of it. A hand-written summary of the
shape in the imagination-engine code counts as a second vocabulary and fails review.

Rules that make it machine-checkable, and the two traps the schema closes:

- **Closed vocabularies only.** Every enum id is one `src/config/musicVideoShotConfig.js` already ships
  (extended per §4). The freeze test compares the two lists in both directions, so a schema that drops
  a shipped id fails and a schema that invents one fails unless it is declared pending.
- **Omit, never null.** Optional means the key is absent. A `null` standing in for "not applicable"
  would need a nullable union type, which the grammar builder cannot express — so the schema rejects
  `null` outright instead of letting a half-valid plan through. Same reason `look` overrides per shot
  are three plain optional strings rather than an object with null fields.
- **Lock strings** are canonical prose, emitted verbatim wherever that entity appears, so a location or
  a face cannot be re-described differently in shot 3 and shot 40.
- **Prose carries no generation numbers.** No steps, CFG, sampler, resolution or fps in any prompt
  string — those are graph metadata (the LTX prompt-director's model/workflow-map rule, §10.1). A number
  in prose is a number the graph can silently disagree with.
- **One audio track, absolute offsets.** A clip references the master track plus its start and duration;
  nothing uploads per-clip audio (KupkaProd's handoff-manifest pattern, §10.2).
- **No placeholder token exists.** There is no field a `[placeholder]` could occupy.
- `clips[]` is derived by the timeline builder, never hand-written, and the validator asserts
  `Σ clips.lengthSec == track.durationSec ± 0.5` and that each clip's `shotIds` cover its own span. That
  kills the shot-count/clip-count desync by construction.
- **Camera move ids are the config's hyphenated ids** (`push-in`, `pan-left`, `dolly-zoom`,
  `whip-pan`, `steadicam`, `crane`, `dutch-tilt`, `snap-zoom`) — not underscore aliases, which is how
  the old DSL silently failed to resolve.

### 3.1 Where lighting, lens and grade live (answer to the OPEN question, 2026-11-27)

Checked against the frozen file itself, not from memory. The earlier one-line summary ("enums are only
camera moves, section kinds, `profileSource`, `llm.backend`") was about **enums** and read as if those
were the only *fields*. They are not. Concretely:

| Brief item | Field | Status |
|---|---|---|
| Hard backlight, colored gels, smoke/haze | **`look.lighting`** — required string, stated once, emitted verbatim; per-shot override `shots[].lighting` | **Present** |
| 35 mm grain, halation | **`look.film`** — required string (stock + grain + halation); per-shot override `shots[].film` | **Present** |
| Anamorphic letterbox | **`look.letterbox`** — optional string (`"2.35:1 matte"`) | **Present** |
| Palette / desaturated shadows | **`look.palette`** — optional string | Present |
| Dutch tilt | `shots[].cameraMove: "dutch-tilt"` (in the enum) | Present, as a **move** only |
| **Lens** (focal length, T-stop, anamorphic squeeze) | **no field.** Only reaches the prompt if typed inside `look.film`, which conflates stock with glass | **ABSENT** |
| **Grade / timing** (lift-gamma-gain, teal-orange, bleach bypass) | **no field.** Rides in `look.palette` prose, which is a palette, not a grade | **ABSENT** |

So: carried at **top level on the `look` block** for lighting/film/letterbox/palette; **genuinely
absent** for lens and grade. Henry's brief names both (anamorphic glass, and a grade behind the palette),
and the renderer cannot invent either — a missing lens string means the shot is prompted with no glass at
all, which is how you get a clean digital look on a track that is supposed to read 1997.

**Proposed v2 amendment (mine to write, Gracey's to approve — I have not touched the frozen file):**

```jsonc
"look": {
  "lens":   "35mm anamorphic, 40mm primary, T2.8, oval bokeh, horizontal blue flare",   // REQUIRED
  "grade":  "pushed teal shadows, warm saturated highlights, slight bleach bypass on blacks", // REQUIRED
  ...
}
"shots[]": { "lens": "…", "grade": "…" }   // optional per-shot overrides, same inherit-if-omitted rule as film/lighting
```

Both plain strings stated once and reused verbatim, like `film` and `lighting` already are — not enums,
because there is no vocabulary to key them against; they are prose the compiler emits. Required at
`look` level so a plan cannot be valid while leaving glass to chance; optional per shot so a single
insert can shoot 80mm without restating the whole look. GBNF-neutral: no new keyword class, so V11 is
unaffected. `dutchAngle` (a persistent tilt as a *look*, not a move) is a separate question I have left
out — say the word if Henry wants the tilt to survive as a look-level property.

  `whip-pan`, `steadicam`, `crane`, `dutch-tilt`, `snap-zoom`) — not underscore aliases, which is how
  the old DSL silently failed to resolve.
---

## 4. Reuse, do not reinvent

Existing assets that already do most of the work:

| Asset | Use |
|---|---|
| `src/config/musicVideoShotConfig.js` | The canonical vocabularies and defaults. `MUSIC_VIDEO_SCRIPT_TEMPLATE` is the human-facing format. **Extend, do not replace** |
| `normalizeMusicVideoShot()` | Field normalizer — the shot compiler calls it |
| `estimateLyricLineStartSeconds()`, `parseTimedLyrics()`, `detectTimedLyricsFormat()` | Line timing — feed real times in, remove the even-spread fallback |
| `resolveCastMembersFromNameList()`, `normalizeCastSlug()`, `splitCastNameList()`, `CAST_COLLECTIVE_KEYWORDS` | Cast resolution (`both`/`all`/`band`) |
| `computeCoverageGaps()` | Verifies script coverage against audio before queueing |
| `src/services/comfyui.js:3350 modifyMusicVideoShotWorkflow()` | Already templatizes the LTX-2.3 per-shot workflow: writes shot text to node 1624, `lora_1` ON for lip-sync, `lora_4` ON for camera moves (`cameraLoraStrength` 0.3). Build on it |
| `src/services/castKeyframeQueue.js` (58 KB) | Keyframe generation queue for cast identity |
| `musicVideoDsl.js`, `promptComposer.js`, `scriptCoverage.js` | DSL, prompt assembly, coverage |
| `src/services/lmstudio.js` | Working local-LLM client (connect/list/load/unload/chat/stream, settable base URL). `chatCompletion` spreads `...options` last (`:197-211`, verified) so `response_format: json_schema` passes through and is enforced server-side. Used by the Agent workspaces only — reuse it as the `lmstudio` backend, don't rewrite it |
| `ltx_director/core/{script_parser,shot_parser_validator,prompt_compiler,shot_template_generator}.py` | Deterministic compiler and gates |

**Vocabulary additions for the 1990s brief** (ids must be added to the config file, not invented per
shot): camera moves `dutch-tilt`, `dolly-zoom`, `whip-pan`, `steadicam`, `crane`, `snap-zoom`;
lighting presets `hard-backlit-gel`, `sodium-vapor`, `tungsten-practical`, `strobe-smoke`; film looks
`anamorphic-235`, `super-16mm-grain`, `hi-contrast-bw`. Each gets a `scriptLine` in the same shape as
the existing entries so the DSL keeps working unchanged.

**Two known traps in the current DSL** that the compiler must not replicate: `MUSIC_VIDEO_SHOT_SIZES`
emits a second `Keyframe prompt:` line (duplicate field, last-wins is undefined), and
`MUSIC_VIDEO_ENERGY_OPTIONS` writes into `Motion prompt:` alongside the authored action. The compiler
emits `Camera:`/`Energy:` on their own lines and merges prose into `Motion prompt:` once.

---

## 5. Workstream split

Seam = `plan.json` (§3), defined by **`src/schema/shotPlan.schema.json`** — A produces it, B consumes
it, and neither restates it. **Frozen** at commit `d081731`; changes route through Gracey. Files are
partitioned so no two agents edit the same file.

**Collision with W15, resolved at freeze time (Gracey, 2026-11-27).** W15's `imaginationEngine` returns
the LLM's shot plan, so it writes into this same artifact — two authors and two descriptions of one file
is the two-vocabulary bug in a new building. So: the schema file is the only definition, **W15's
`response_format.json_schema.schema` must BE that file loaded verbatim** (not a hand-written summary of
it), and the freeze test fails any drift the arbitration misses. Neither worker edits it.

### W-A — Input / processing layer (m4a → `plan.json`)

1. `src/services/sunoIntake.js` — delete the placeholder keyframe writer; stop emitting cast from
   bracketed production directions.
2. `src/services/audioStructure.mjs` *(new)* — ffmpeg → PCM → RMS/spectral-centroid envelope in
   Node; section segmentation, beat onsets, `profileSource: "envelope"`. CPU only.
3. `src/services/trackLyrics.mjs` *(new)* — parse the `lyrics` tag; taxonomy
   structural / production-direction / vocal; directions become per-section `music.energy`, never cast.
4. `src/services/shotPlan.mjs` *(new)* — build `plan.json` from lyrics + structure + cast roster, using
   `musicVideoShotConfig.js` helpers. It **loads `src/schema/shotPlan.schema.json`** and validates against
   it before writing; the same loaded object is what step 6 hands to the LLM as `response_format`.
5. `src/services/clipTimeline.mjs` *(new)* — shots → clips reconciliation + frame-grid accounting
   with residual carried, not silently rounded up. Each clip carries `audioStart` + `audioDuration`
   against the one uploaded master track (§10.2), never a per-clip audio file.
5a. `src/services/castAssets.mjs` *(new)* — cast manifest on disk (`characters.json` + per-member ref
   dirs) and `selectRefsForScene(shot, cast)` round-robining across members named in that shot's prose,
   capped at the model's ref limit (10). D5's prompt-only default is unchanged: with no refs on disk
   this returns empty and identity rides on `lock`. Pattern from KupkaProd's `character_manager.py`.
6. Action prose: `src/services/actionProse.mjs` *(new)* — calls **one interface**, never an HTTP client
   directly: `generateShotPlan(prompt, jsonSchema) -> {ok, plan, reason, backend}`, where `jsonSchema`
   is **the frozen `shotPlan.schema.json` loaded verbatim** — never an inline copy of it. Backend picked by
   **availability at call time**, order `local` → `lmstudio` → `openrouter`, and written into `plan.json`
   (`llm.backend`, `llm.modelId`, `llm.endpoint`, `llm.pid`, `llm.logPath`) so every run is reproducible.
   **Enforcement order, regardless of backend: grammar/schema passed into decoding → validator → at most
   one repair retry → `NEEDS-AUTHOR`** (blocks the queue; never a placeholder). Repair retries parse
   failures, never taste failures — that stays V2/V4/V5/V6/V10/V12's job. Backend names follow the
   step-7 ruling: `sidecar` → `lmstudio` → `openrouter`.

   **What the model is actually told** (this was the missing piece, and it is what decides whether the
   output reads like a video or like gibberish). Two passes, so the model holds a story before it holds a
   shot list — pattern from Synesthesia's `llm_logic.py`, §10.3:
   - **Pass 1, treatment:** concept + full lyrics with the section timeline injected as timed lines
     (`[12.40s - 18.00s: SINGING]`, `[39.30s - 67.30s: INSTRUMENTAL]`) + the locked `look` block + cast
     roster with `lock` strings. Returns a short treatment and an arc per section — no shot prose yet.
   - **Pass 2, shots:** the treatment + the *window being written* (its lyrics, its `music.energy`, its
     section kind) + the same locked `look`/cast. The window, not the whole song, so context stays inside
     a 4–6 GB model's budget.
   - **System prompt content** (from the LTX prompt-director playbook, §10.1): the shot grammar
     `[medium+framing] + [subject/opening state] + [chronological action] + [camera] + [environmental
     response] + [lighting/style] + [sound] + [ending state]`; the priority rule *delete decorative
     adjectives before deleting action or camera logic*; verbs with visible consequences, never static
     adjectives; chronological connectors (`At first… / As she… / A beat later… / Finally…`); never a
     generation number; never invent a named entity — refer to cast by locked slug.
   - **One worked example** of a good shot in the prompt (few-shot beats description for a 7B), and the
     `look` strings pasted verbatim so the model has no reason to re-invent a gel.
   - Decoding: low temperature for the structured pass; the LLM sees no node ids, no `\displaystyle`, no
     ComfyUI field names — only the fields in the schema it is returning.
   - **`local` (primary)** — `electron/localLlm.js` *(new)* owns the sidecar lifecycle: spawn
     `extraResources/llama-runtime/${os}-${arch}/llama-server --model <gguf> --port <ephemeral>` on
     loopback, health-check, register `ipcMain.handle('localLlm:generate', …)` in the **main process**,
     kill it on app quit, log to `<appData>/llm/llama-server.log`. Lifecycle precedent in-repo:
     `electron/captionWhisper.js:611-620` and `rifeRuntime.js` (runtime probe + IPC). Pick an ephemeral
     port, never a fixed one — `lmstudio.js` already defaults to `localhost:1234` and a collision would
     be silent. **Open question for W15:** does `llama-server` enforce a JSON schema at the token level
     (grammar), or only repair after the fact? If weak, the order above already covers us — grammar
     string passed directly beats post-hoc repair.
   - **`lmstudio`** — reuse `lmstudio.js` as-is with a base-URL override; same client also drives the
     sidecar, which is the whole reason the sidecar speaks the OpenAI API. It spreads `...options`
     **last** into the body (`lmstudio.js:197-211`, verified), so
     `response_format: {type:'json_schema', json_schema:{name, strict, schema}}` passes through
     untouched and is enforced server-side. **Hazard from that same spread:** any extra key we pass also
     lands in the request body and can 400 the server — the interface hands over exactly
     `response_format`, nothing else. Today only `AgentWorkspace.jsx` / `LLMAssistantWorkspace.jsx` call
     it; the music-video path never has.
   - **`openrouter`** — `:free` tier is 20 req/min and 50/day and **failed attempts count against it**,
     so budget **one call per song** plus at most one repair retry, and never call it in a loop from a
     test.
   `--llm local|lmstudio|openrouter` forces a backend; the default is auto-by-availability. The LLM runs
   on the laptop or in the cloud, never on Spark.
7. **First-run model acquisition UX** — `electron/localLlm.js` + a small React sheet *(new)*. Henry's
   requirement, not a nicety, and the only part of D3 a human actually sees. **Presets ruled (Gracey,
   2026-11-27) — real entries, no placeholders.**

   | # | Preset (key) | Size | VRAM | HF repo / file | Context |
   |---|---|---|---|---|---|
   | 1 | **`mistral-7b-v0.3-q4_k_m`** ← **RECOMMENDED, pre-selected** | 4,372,812,000 B | ~5.4 GB | `lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF` → `Mistral-7B-Instruct-v0.3-Q4_K_M.gguf` | 32k; best speed-per-word of the three, inside the envelope |
   | 2 | `llama-3.1-8b-instruct-q4_k_m` | 4,920,739,168 B | ~6.0 GB | `lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF` → `Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf` | 128k, longest context; most consistent on long structured lists |
   | 3 | `mistral-nemo-2407-q2_k` | 4,791,047,712 B | ~6.0 GB | `unsloth/Mistral-Nemo-Instruct-2407-GGUF` → `Mistral-Nemo-Instruct-2407.Q2_K.gguf` | 12B at Q2_K — **heaviest quality loss; last choice** |

   Recorded sha256 (for the download-time check):
   `1270d22c0fbb3d092fb725d4d96c457b7b687a5f5a715abe1e818da303e562b6` ·
   `f2be3e1a239c12c9f3f01a962b11fb2807f8032fdb63b0a5502ea42ddef55e44` ·
   `e2631c7397d90d3a5338f25d204e704f4acb65211fa225a0e48257e4c24cfc6e`

   - **Hash provenance.** The table arrived **single-sourced** (one unverified list; the Nemo entry came
     from W15's own re-check, not an independent one), so all three were treated as unconfirmed and
     checked against Hugging Face directly. **Verified 2026-11-27 against the live HF API** from Spark —
     `GET /api/models/{repo}/tree/main?recursive=true`, where `lfs.oid` **is** the sha256 — and all
     three hashes **and all three byte sizes MATCH** exactly, so the table is now double-sourced and
     safe to pin. That also means the file is still resident in its repo; a repo re-upload would change
     the oid, which is why ACQ-4 re-runs before every ship rather than trusting this session's output.
     Method, so anyone can re-check without downloading 4.4 GB:
     `curl -s https://huggingface.co/api/models/<repo>/tree/main?recursive=true` → `lfs.oid`, `size`.
     A wrong pinned hash is not a soft failure: every download rejects and the local path is dead on
     that platform, which is the outcome ACQ-4 exists to prevent.
   - **Trigger:** a `--llm local` run finds no GGUF in the app-data model dir.
   - **(a) Picker, shown once.** The three presets above with size and VRAM fit against the detected
     GPU, #1 pre-selected so the path is zero-click (Enter = go), plus a **"use a local file / custom
     URL"** escape hatch. The escape hatch always verifies by hash when the URL is a known preset, and
     by stated-then-computed hash otherwise.
   - **(b) Progress bar:** bytes done / total, source shown (HF repo + file, or the custom URL),
     **resume on restart** rather than restarting a ~4.4 GB transfer, and the sha256 check before the
     file enters the cache (`remoteModelInstall.js` already does resume + poll-to-size + pinned-hash).
   - **(c) Cancel is not a dead end.** Cancel, a failed download, a hash mismatch, or no model present
     falls through to `lmstudio`, then `openrouter`, and the run still produces a plan. A missing weight
     file must never block a video.
   - **(d) Provenance:** the resolved file, hash and backend are written to `plan.json.llm`, so a render
     says which model wrote its prose — and which file, since two presets can share a model name.
   - **Transport is a separate axis from the model, not a fourth preset.** `sidecar` (bundled
     `extraResources/llama-runtime/${os}-${arch}`, the way RIFE/ffmpeg ship — **default**, the only one
     that works when the user installed nothing) vs `lmstudio` (opt-in bring-your-own through the
     existing `src/services/lmstudio.js`). No new npm dependency, no ABI exposure.

   **Acceptance checks (no GPU):**
   `ACQ-1` fresh profile, nothing on disk → picker appears with #1 pre-selected → accept → download
   completes with progress → `plan.json` generated.
   `ACQ-2` re-run the same command → **no download**, no picker, model loaded from cache.
   `ACQ-3` kill the download at ~50 % and re-run → resumes rather than restarts, hash still validates.
   `ACQ-4` **each preset's sha256 verified against HF before shipping** — `tools/verify-presets.mjs`
   (new, ~40 lines, no GPU) asks HF for each file's `lfs.oid` + `size`, diffs both against the preset
   table, and exits non-zero on any mismatch so a ship blocks. Checked once already on 2026-11-27:
   3/3 sha256 MATCH, 3/3 size MATCH. Re-run per release — HF repos get re-uploaded. The runner-up rule:
   if HF is unreachable at ship time, **the presets do not ship** — unverified is not the same as
   verified and must never be represented as verified.
8. `planValidator.mjs` *(new)* — the V1–V10 gates (§6).
9. Rewrite `sunoIntakeProbe.mjs` to emit `plan.json`; delete the tiling path.

### W-B — Output / generation layer (`plan.json` → frames → video)

1. `ltx_director/core/prompt_compiler.py` — deterministic compiler, no LLM, no enhancer.
2. `public/workflows/music_video_shot_ltx2_3_i2v_audio.json` — delete nodes `2109:1617/1618/1620/1623/1625/1928`;
   add named string inputs `SHOT_PROMPT`, `SHOT_NEGATIVE`, `SHOT_START`, `SHOT_DURATION`, `SHOT_FPS`,
   `SHOT_LORA_TALKING_HEAD`, `SHOT_LORA_CAMERA`, `SHOT_LORA_STRENGTH`.
3. `tools/validate-graph.mjs` *(new)* — static link/type/range check against cached `/object_info`;
   also flags cycles (the `CFGGuider.model` self-reference class) and dead links to deleted nodes.
4. `src/services/h3OneShot.js` — production rewrite: LTX-2.3 default engine, `--engine h3` opt-in,
   every stage fail-fast with a message naming the node and the reason.
5. `scripts/oneshot/04-run.sh` — thin wrapper, see §7.
6. Stitch: per-clip frame dirs → ffmpeg concat + audio mux + loudness match, verified duration report.
7. `tools/preview-prompt.mjs` *(new)* — compile-only, prints the exact prompt per shot. Zero GPU.
7a. `tools/doctor.mjs` + `--resume` over `run.json` *(new)* — pre-flight (ComfyUI reachable, checkpoints
   present, disk, GPU) and re-queue that skips clips already rendered, by id. Pattern from KupkaProd's
   `doctor.py` / `resume_manager.py`. A 25-minute full run that dies at clip 19 must not restart at 1.
7b. `tools/render-calibration.json` — measured seconds-per-clip by resolution/backend, so `--single`
   and full runs state expected time and cost instead of guessing. From Synesthesia's
   `render_calibration.json` (§10.3).
8. Tests: `tests/oneShotContract.test.mjs` *(new)* — fixture `plan.json` → compiled prompts → built
   graph, byte-stable, never queued.
9. **The app surface (§11)** — `src/services/musicVideoPipeline.js` (side-effect-free orchestrator) +
   `electron/musicVideoHost.js` (fs, spawn, ComfyUI, log tail) + `mv:*` handlers in `electron/main.js` +
   the `mv:` bridge in `electron/preload.js`, settings stored under the existing `settings:set` key
   `mv.settings` (`src/components/SettingsModal.jsx`), and the `extraResources` entry for
   `build/llama-runtime/${os}-${arch}`.

**W-B acceptance (additions):** `ACC-7` — drop an m4a on the window, press **Generate Script**, press
**Generate video**, get `final/<song-id>.mp4`, **never opening a terminal**; `ACC-8` — the same pipeline
passes in a Node test against a fake host with no Electron, no GPU and no ComfyUI.

### Shared / join points

- `plan.json` schema (§3) — frozen before code.
- Vocabulary additions in `musicVideoShotConfig.js` — W-A proposes, W-B confirms the enum→LoRA mapping.
- `tests/fixtures/forsaken.plan.json` — one fixture, both sides.

---

## 6. Validation gates (all before any GPU work)

| Gate | Rule |
|---|---|
| V1 | `Σ clip lengths` within 0.5 s of track duration; every shot inside exactly one clip |
| V2 | Every enum field resolves to an existing id |
| V3 | No `placeholder`, `TODO`, `TBD`, `Waiting for` anywhere in the plan or compiled prompt |
| V4 | Every `cast`/`props` slug resolves to a declared entity with a `lock` ≥ 8 words |
| V5 | Every shot declares location (explicit or inherited) |
| V6 | Lip-sync shots have `lyric` non-empty and `startSec` inside a detected vocal region |
| V7 | Compiled prompt ≤ 1200 chars and contains the location lock verbatim |
| V8 | Graph has no link to a deleted node, no cycle, no type mismatch (cached `object_info`) |
| V9 | Two consecutive compilations are byte-identical (determinism) |
| V10 | `computeCoverageGaps()` returns zero uncovered vocal lines |
| ACC-1..9 | App-integration acceptance (§11): three input doors land in one project dir; derived files regenerate; resume skips by `promptSha256` and refuses a stale plan; kill -9 leaves a readable log tail; in-app generate works from a cold machine; settings snapshot cannot split a run; the whole flow needs no terminal; the pipeline runs against a fake host with no Electron/GPU; a packaged build finds `llama-server` or degrades with a reason |
| ACQ-1/2/3 | First-run model acquisition: picker appears when nothing is on disk, second run does **not** re-download, interrupted download resumes (W-A step 7) |
| V11 | The schema stays in the **GBNF-friendly subset** (objects, strings, numbers, enums, arrays; **no `$ref`/`$defs`/`oneOf`/`anyOf`/`allOf`/`patternProperties`/`if`-`then`/`pattern`/`format`/`const`/union types**) | a grammar builder cannot express the rest and constrained decoding breaks | **landed** — `npm run test:shot-plan-schema` walks the frozen schema and fails on any hostile keyword, any open object, and any enum id that drifts from the shipped vocabularies. Verified by mutation: injecting `$ref`/`$defs`, a `string|null` union, an open object, or an invented preset id each turn it red |

| V12 | Prose linter `tools/lint-prose.mjs` (§10.1): every shot names a camera position, its action contains a verb with a visible consequence, no banned abstraction, no generation numbers |

Grammar-constraint guarantees the JSON **parses**, not that it is *sane*. V2, V4, V5, V6 and V10 are
unchanged and still required — do not relax any of them because the local model is "constrained".

---

## 7. Developer workflow

```
node scripts/oneshot/belrog.mjs plan   --audio TRACK.m4a            # → plan.json + report (LLM on laptop/cloud, never Spark)
node scripts/oneshot/belrog.mjs plan   --llm local|lmstudio|openrouter      # force an LLM backend; default = auto by availability
node scripts/oneshot/belrog.mjs compile --plan plan.json            # prompts only, NO LLM, 0 GPU
node scripts/oneshot/belrog.mjs check  --plan plan.json             # V1–V7, 0 GPU
node tools/validate-graph.mjs --workflow <json> --comfy $COMFY      # V8, read-only
node tools/preview-prompt.mjs  --plan plan.json --shot 12           # exact prompt, 0 GPU
node scripts/oneshot/belrog.mjs single --plan plan.json --shot 12 --lowres   # D4: one cheap clip
node scripts/oneshot/04-run.sh         --plan plan.json             # full run, gated on all of the above
```

**Two different flags, never one:** `--engine` selects the **render** path (`ltx23` default, `h3` per D1)
and `--llm` selects the **prose backend** (D3). They were briefly sharing the name `--engine`, which
would have made `--engine h3` silently mean "no local LLM" — same class of bug as the shot/clip desync,
just in the CLI.

`04-run.sh` becomes: parse args → run all gates → refuse and print the failing gate → queue → poll →
stitch → verify duration/codec/audio → write `run.json` (including which `--llm` backend served the
prose). No inline logic.

---

## 8. What the test track looks like under the new design

`Forsaken, Falling.m4a`, 283.56 s, metal, no LRC timing. 8 sections detected at
17.0 / 39.3 / 67.3 / 156.0 / 172.4 / 231.6 / 258.4 / 276.3 s. 58 vocal lines.
Chorus hook repeats 4× ("Forsaken, falling / Darkness is calling / …") → a single recurring
performance setup shot on the beat, intercut per the brief; the outro scream section gets the most
aggressive grammar (whip pans, strobe, hi-contrast). Cast: one lead vocalist, prompt-only identity
per D5. Locations: two locked industrial/night locations, reused across the whole video so identity
cannot drift.

---

## 9. Open items — all ruled (2026-11-27)

Every open item below is **decided**, not parked. Nothing here waits on Henry except the GPU go, which
is a standing gate, not a question.

- **O-1 Vocalist reference sheet — DECIDED: prompt-only for v1, refs stay behind the interface.**
  `castAssets.mjs` returns an empty ref list when nothing is on disk and identity rides on `lock` (D5).
  Revisit only if the first full run shows measurable face drift shot-to-shot; we will have a render to
  judge it against instead of guessing now.
- **O-2 `--single` parameters — DECIDED: 480p / 24 fps / 20 frames / 8 steps, one clip.** That exact
  row is written into `tools/render-calibration.json` as `480p|LTX-2.3-distilled` with the measured
  wall-clock time, so the ETA math has one real number in it instead of an estimate. Execution waits on
  Henry's go (D4 gate).
- **O-3 Delete H3? — DECIDED: keep `--engine h3` behind the flag until one full LTX run finishes clean,
  delete it in the release *after* that, not the same one.** A rollback path that dies at the same commit
  as the new path is not a rollback path. No H3 code changes in the interim.
- **O-8 `look.lens` / `look.grade` — DECIDED: approved as a v2 amendment.** Required on `look`, optional
  per shot, `schemaVersion` becomes `[1, 2]`; renderer never invents a gel or glass (§3.1). Written as a
  v2 commit on the freeze branch carrying **nothing else**; lands once Gracey merges, since the freeze
  rule says neither worker edits the file.
- **O-9 Look-level dutch tilt (`dutchAngle`) — DECIDED: declined for v2.** Dutch tilt stays a
  `cameraMove`. A persistent tilt is a shot choice that fits the existing vocabulary; if a shot ever has
  to hold a tilt across clips it returns as a numeric look property with a stated range, and not before.
- **O-10 Per-clip audio windowing — DECIDED: approved into the same v2 commit.** `clips[].audioStart` +
  `clips[].audioDuration` (numbers, required) against one `track.audioFile`. One upload of the master,
  offsets per clip — never N audio files (§10.2).
- **O-11 Cast manifest format — DECIDED: `projects/<song-id>/cast/characters.json`**, `{version,
  members:[{slug, lock, refs[]}]}` with refs as project-relative paths, refs dir `cast/<slug>/ref_NN.png`.
  **Project-scoped, no app-wide cast store in v1** — a cross-project store is a merge-conflict generator
  and buys nothing until a second song reuses a cast.
- **O-12 V12 linter: block or warn? — DECIDED: blocks `check` and `run`, warns in `compile` and
  `preview-prompt`, and never mutates prose.** A queued render must not carry an unspec'd shot; a writer
  iterating in preview needs to see the failures without being stopped by them.
- **O-13 LTX route and generation params — DECIDED: distilled route, 480p / 24 fps for the gate and
  default render, params live in one `renderDefaults` config plus the graph and never in prose (V7 +
  §10.1).** The checkpoint/fps actually available are read from the target's `/object_info` at doctor
  time, not assumed — same law as O-4.
- **O-4..O-7** remain resolved as recorded below.
- **O-4** RESOLVED (verified 2026-11-27): ComfyUI is on Spark at `:8188`; `~/spark-comfyui/data/input`
  exists, and `comfyui.js:1295` already uploads through `POST /upload/image`. When Belrog runs on the
  laptop, "remote ComfyUI" means this same server over the tailnet, so audio must go through the upload
  endpoint rather than a shared path — the pattern already exists, it just needs extending to audio.
  Loader model paths must be read from the target's `/object_info`, not assumed to be `~/.models/…`.

- **O-5** **RESOLVED into work.** Weights are not shipped; they arrive on first use (Henry's
  requirement). Spec and acceptance checks `ACQ-1..3` are now W-A step 7. Remaining sub-detail:
  a Settings path to point at an existing GGUF and skip the download, and a cache keyed by file hash so
  the same 5 GB file is not stored twice. `electron/remoteModelInstall.js` is the in-repo precedent —
  it already does resume (`-c` via curl/wget), poll-to-expected-size, and pinned-`sha256` verify
  (`:13-14`, `:36`, `:153-170`), on the remote-SSH path; the local path wants the same recipe against a
  local write. Which GGUF belongs to W15.
- **O-6** Packaging cost of D3, from `package.json` (verified, not theory): Belrog currently ships
  **zero native Node modules** — no `asarUnpack`, no `npmRebuild`, no `@electron/rebuild`, and every
  external runtime (ffmpeg, ffprobe, RIFE, RTX VSR, whisper) is delivered as a **per-platform binary
  through `extraResources`**, e.g. `build/rife-runtime/${os}-${arch}/rife`. Adding `node-llama-cpp`
  makes it the **first ABI-bound dependency in the app**: it needs an Electron-ABI rebuild per platform
  and its `.node` file must be `asarUnpack`ed or `require` fails inside the archive, and the CUDA/Metal
  backends are build-time options — which lands on the release workflow that builds win/mac/linux.
  **RULING (2026-11-27): the RIFE route won** — `local` ships a prebuilt `llama-server` sidecar in
  `extraResources/llama-runtime/${os}-${arch}/`, driven by a thin main-process controller, and
  `node-llama-cpp` is demoted to the documented alternative in §2.1. Packaging work that still has to
  happen: add the runtime to the `build.files` / `extraResources` lists for all three OS targets, make
  the CI job fetch or build the per-arch binary the same way `build/rife-runtime/${os}-${arch}/` is
  produced, and confirm the sidecar is executable-flagged and notarization-clean on macOS. Do it in the
  release workflow before the next tag push, not in a panic after a failed release.
- **O-7** `@electron/llm` / `ses.registerLocalAIHandler()` are unavailable: the app is on
  `electron ^28.0.0` and those need Electron 37/38+. So the transport is our own IPC over
  `ipcMain.handle` (120 handlers already exist), kept behind the `generateShotPlan()` interface so the
  transport can move to the native handler after an Electron upgrade. `node-llama-cpp` is **not yet a
  dependency**.

## 10. Prior art — what we steal, and what stays ours

Henry's instruction: *find other projects with functions we can steal, learn, steal.* Three repos were
read at source (file trees + the files named below), 2026-11-27. Steal **patterns and rules**, not
files: `KupkaProd` and `ltx-2-3-prompt-director` publish **no LICENSE**, `Synesthesia` is MIT. No code
from the unlicensed two may be vendored.

### 10.1 `AI-KSK/ltx-2-3-prompt-director` → fixes missing piece #1 (the prose rules)

| Their artifact | Where it lands here |
|---|---|
| `references/prompt-construction-playbook.md` §1 shot grammar: `[medium+framing] + [subject/opening state] + [chronological action] + [camera] + [environmental response] + [lighting/style] + [sound] + [ending state]` | The skeleton of our LLM **system prompt** in `src/services/actionProse.mjs`. It is the first written spec of what a shot sentence must contain |
| §2 information priority, verbatim: *"Delete decorative adjectives before deleting action or camera logic."* | Our **token-budget rule** when a plan must compress to fit the 1200-char prompt gate (V7) |
| §3 verbs with visible consequences (`turns, steps, reaches, grips, releases, flinches, pivots, stumbles…`) and material verbs (`billows, ripples, fractures, glints, smears…`) | Banned-abstraction list in the system prompt: prose must contain a verb from this class, not "is emotional" or "feels intense" |
| §3 chronological connectors (`At first… / As she… / Then… / A beat later… / While the camera… / Finally…`) | How multi-beat shots are written so a clip has an inside; also what the linter checks for |
| `scripts/ltx_prompt_lint.py` (stdlib-only, no model call) — camera-term coverage, action-connector detection, dialogue quoting, block-header/weight syntax | Shape of **V12, the prose linter**: `tools/lint-prose.mjs`, run pre-GPU alongside V1–V11. Weights/samplers/steps are not in our prose, so their weight-syntax checks do not apply |
| `references/model-and-workflow-map.md`: *"Do not encode sampler, CFG, steps, resolution, or model filename inside prose… those belong in workflow metadata."* | **Contract rule** (§3): `plan.json` prose carries no numbers about generation. Steps/CFG/resolution/fps live in the graph/params layer. This kills a whole class of prompt-vs-graph disagreement |

### 10.2 `Matticusnicholas/KupkaProd-Music-Video-Pipeline` → fixes our two workflow holes + asset management

| Their artifact | Where it lands here |
|---|---|
| `sample_schemas/ia2v_handoff_manifest.json`: `audio_path` + **`audio_start_time`** + **`audio_duration`** per scene | Answers the hole in §9 outright: per-shot audio is **one uploaded master plus an absolute offset and duration**, not N uploaded clips. `clips[].audioStart` / `audioDuration` (proposed schema v2 — same change-control route as §3.1); W-B uploads the track once and passes offsets |
| `character_manager.py`: `characters/<char_id>/ref_NN.png` + a `characters.json` manifest consumed by ingest, and `select_refs_for_scene()` round-robining across characters named in a scene's prompt, capped at 10 refs/generation | Our **cast asset pipeline** (the piece that was missing entirely): a cast manifest on disk, refs per member, and a deterministic ref-picker keyed to which names appear in the shot. D5's prompt-only default stays; this is what "opt-in refs" concretely means |
| `resume_manager.py`, `doctor.py` | `--resume` over `run.json` (skip completed clips by id, re-queue the rest) and `node tools/doctor.mjs` (ComfyUI reachable, checkpoints present, disk, GPU) before any queue |
| `sample_schemas/*.json` as first-class files (`creative_treatment`, `timeline_scene`, `audio_features`, `assembly_manifest`) | Confirms the frozen-file discipline: every intermediate artifact gets a checked-in sample + schema, not a README description |

### 10.3 `RowanUnderwood/Synesthesia-AI-Video-Director` (MIT) → per-call context assembly and budget math

| Their artifact | Where it lands here |
|---|---|
| `llm_logic.py`: **two passes** — overarching plot first, then per-shot descriptions — with the timeline injected as `[12.40s - 18.00s: SINGING]` lines | Our **context assembly** in `actionProse.mjs` (the part missing from §5 step 6). Pass 1 sees concept + lyrics + section timeline and returns the treatment; pass 2 gets the treatment plus the timed window it is writing for. Two calls, still far inside the OpenRouter `:free` ceiling, and one call for the local path if it fits |
| `render_calibration.json`: measured seconds-per-clip keyed by `"1080p\|LTX-Native"` etc. | `tools/render-calibration.json` — a measured table so `--single` and a full run can state expected minutes and cost instead of guessing. Feeds the D4 gate decision |
| `styles.json`: `name` + `{prompt}` template + `negative_prompt` | The shape of our **look presets** (1990s MTV vocabulary in §4): a preset expands to positive and negative text from one closed entry |
| `config.py` constants (`VRAM_WARN_THRESHOLD`, `SLOWDOWN_WARN_FACTOR`) | Runtime guards worth copying as constants: warn on VRAM > 92 %, warn when a clip takes > 2.5× its calibration estimate |

### 10.4 What stays ours, unchanged by any of the above

Frozen `src/schema/shotPlan.schema.json` v1 at `d081731` (changes only through Gracey) · `llama-server`
sidecar as the default transport (§2) · first-run picker + resumable download UX (W-A step 7) ·
LTX-2.3 per-shot + ffmpeg stitch with H3 behind `--engine h3` (D1) and the enhancer deleted (D2) ·
`--single` as the GPU gate (D4) · prompt-only cast identity as default (D5) · audio-envelope timing from
the existing analyzer (D10, measured on the test track) · the 1990s MTV vocabulary added into
`musicVideoShotConfig.js`, not a parallel list · the GBNF subset constraint (V11) and the
grammar→validator→one-repair→NEEDS-AUTHOR order (§5).

The three stolen pieces that need a **decision before code** are all small: the two `clips[]` audio
offset fields, the cast manifest file format, and whether V12's linter blocks or warns. The first two
are schema amendments for Gracey; the third is W-B's.

---

## 11. App integration — the last mile

Everything above can be true and the app still be unusable. This section is the surface: how the file
gets in, where every byte lands, what the user watches, and what they can change. Grounded against the
repo, not invented: settings live in `electron/main.js:122` `path.join(app.getPath('userData'),
'settings.json')` reached through `settings:get|set|delete` (`main.js:5020/5029/5046`); file pickers
already exist as `dialog:selectFile` / `dialog:selectDirectory` / `dialog:saveFile` (`main.js:4038-4073`);
events reach the UI through `electron/preload.js` `contextBridge.exposeInMainWorld('electronAPI', …)` with
`webContents.send('export:progress'|…)` on the other side; `comfyui.js:1250 interrupt()` already exists;
`spawn(binary, args, { windowsHide: true })` is already the pattern at `electron/captionWhisper.js:257`.
**There is no Tray anywhere in the repo today** — the tray is genuinely new work, not a config flag.

### 11.1 Giving the app the song

Three doors, one destination.

| Door | Implementation |
|---|---|
| Drag-drop onto the window | `src/components/generate/MusicVideoEasyMode.jsx` drop zone → `.m4a/.mp3/.wav` only; the File object's absolute path is resolved through the existing `resolveTrackFilePath()` / `isProbeablePath()` in `src/services/musicVideoTrackIntake.mjs:23-30` |
| File picker | existing `dialog:selectFile` handler, filtered to audio extensions — **no new handler** |
| CLI `--input <path>` | `scripts/oneshot/belrog.mjs` (same process, no window) |

All three call `MusicVideoPipeline.ingest(filePath)` and land in the same place:

```
<userData>/projects/<song-id>/source.m4a      ← always copied, never referenced in place
```

`<song-id>` = `<slug(title)>-<first 8 of sha256(file bytes)>`. **The hash makes identity content-based,
not name-based**: re-picking the same song reopens the same project and its resume point, and two
different files that happen to share a title can never collide into one folder. Copy (not reference)
because a render that outlives a moved download is a broken render — the 5–40 MB is the price of a
reproducible one.

`ACC-1` pick a song three ways → one project dir, `source.m4a` byte-identical to the original, `probe`
duration matches; pick the same file twice → same `song-id`, no duplicate folder.

### 11.2 What lands where

```
<userData>/projects/<song-id>/
  project.json                 song-id, source path+sha, createdAt, schemaVersion, engine, llm backend
  source.m4a                   the copied master track
  plan.json                    the frozen shotPlan contract (§3) — the only authored artifact
  shots/shot_001.json …        compiled per-shot render payloads, derived, never hand-edited
  renders/shot_001.mp4 …       raw per-clip output
  thumbs/shot_001.jpg …        first frame of each clip (ffmpeg), what the UI shows
  final/<song-id>.mp4          stitched + audio-muxed + loudness-matched
  logs/<runId>.log             JSONL, one event per line (§11.5)
  state.json                   resume point (§11.4)
```

`shots/` and `renders/` are **derived from `plan.json` and disposable** — deleting them and re-running
must reproduce the same video. If a file in `shots/` can't be regenerated from `plan.json`, that is a
bug, not a backup.

`ACC-2` delete `shots/` + `renders/`, re-run → everything regenerates; `final/` matches the previous run
byte-for-byte where determinism is claimed (V9 covers the prompts, this covers the tree).

### 11.3 What a shot payload actually contains

`shots/shot_NNN.json` mirrors the graph inputs W-B step 2 adds, one key per `SHOT_*`, so the mapping from
artifact to node is 1:1 and auditable:

```jsonc
{
  "shotId": 12, "startSec": 67.3, "durationSec": 4.2,
  "shotPrompt": "…",        // → SHOT_PROMPT       (prose only: no steps, no CFG, no resolution — §3)
  "shotNegative": "…",      // → SHOT_NEGATIVE
  "ltxParams": { "width": 832, "height": 480, "fps": 24, "frames": 101, "steps": 8, "cfg": 3.0 },
  "audioWindow": { "file": "../source.m4a", "start": 67.3, "duration": 4.2 },  // §10.2 offsets, not per-clip files
  "refs": [],               // cast ref images, [] under D5's prompt-only default
  "promptSha256": "…"       // what was queued, provably; also the cache key for skip-if-rendered
}
```

`ltxParams` are the only place generation numbers live (O-13). `promptSha256` is what `--resume` compares
against, so "already rendered" means *the same prompt*, not merely *the same shot number*.

### 11.4 `state.json` — the resume point, and when to distrust it

```jsonc
{
  "runId": "20261127-214502", "engine": "ltx23", "llmBackend": "sidecar",
  "planSha256": "…",            // §3 plan.json hash — the staleness check
  "currentShot": 13, "completedShots": [1, 2, 3], "failedShots": [{ "shotId": 9, "stage": "generate", "error": "VRAM OOM" }],
  "startedAt": "…", "updatedAt": "…"
}
```

Written **after each clip completes**, never mid-shot, so a crash mid-clip resumes that clip. Resume
refuses to trust a `state.json` whose `planSha256` differs from the `plan.json` on disk — it prints the
diff and asks for `--force`, because resuming a stale plan silently is how you ship half of an old video.

`ACC-3` kill at shot 13 of 25 → `--resume` renders 14-25 and skips 1-13 by `promptSha256`; edit
`plan.json` and resume → **refuses** with the diff.

### 11.5 Logs

JSONL to `logs/<runId>.log`, one object per line:
`{ ts, level, shotId, stage, message, durationMs, comfyPromptId }` — camelCase, the repo's convention
(`cameraMove`, `startSec`); mixed-case keys in one file is a bug magnet, so this deviates from the
sketch's `shot_id`/`duration_ms` on purpose. Stages: `ingest · structure · script-pass1 · script-pass2 ·
validate · compile · upload · generate · stitch · mux`. In dev (`!app.isPackaged`) each line is also
mirrored to the devtools console through the existing log pipe (`main.js:3640`).

`ACC-4` kill -9 mid-run, read the log: the last line names the shot and stage; nothing is silent.

### 11.6 What the user watches

In `src/components/generate/MusicVideoEasyMode.jsx` (extend the intake status already at
`:1035-1036` — one progress surface, not a second one beside it):

- **Progress bar** `shot N of M` + percent, from `mv:progress`.
- **Current shot**: thumbnail from `thumbs/shot_NNN.jpg` + the compiled `shotPrompt` in a collapsed
  drawer, so "why does this shot look like that" is answerable without opening a terminal.
- **ETA** from `tools/render-calibration.json` (§10.3): remaining clips × the measured row for the
  selected resolution. Before calibration has a row for that resolution it says **"no measurement yet"**,
  never a fabricated estimate.
- **Log tail** — last 10 lines, live.
- **Cancel / pause / resume**. Cancel calls `comfyui.js:1250 interrupt()` then stops intake; pause stops
  after the current clip. Both leave `state.json` valid.
- **Tray** — `new Tray` + a `Tray` icon asset that does not exist yet, showing `mv 6/25`. Real work:
  one icon set (win/mac/linux) and quit-vs-hide semantics. Deferred to a follow-up task, explicitly not
  in the first cut.

### 11.7 Generate Script, in the app

A button in the Music Video tab (next to the existing intake control):

1. Opens a modal: cached model line (`mistral-7b-v0.3-q4_k_m · 4.37 GB · on disk`) **or** the first-run
   picker of W-A step 7 if nothing is on disk. Backend line shows what will actually be used and why
   (`sidecar → lmstudio → openrouter`, from availability at call time).
2. Pass 1 — "story": progress, then the treatment text, editable. Editing it feeds pass 2 verbatim.
3. Pass 2 — "shots": progress per section, then `plan.json` is written to the project dir and validated:
   schema → V1-V11 → **V12 prose lint** (§10.1). Result panel lists **pass/fail per gate**; a failed shot
   shows the offending prose and the repair note, not a stack trace.
4. `Generate video` stays disabled until the gates are green. `plan.json` is also reachable from the
   project tree for hand-editing, which re-runs the gates on save.

`ACC-5` generate with no GGUF → picker → download with progress → plan written → gate report; cancel
the download → falls back to `lmstudio`/`openrouter` and still produces a plan (ACQ-3, unchanged).

### 11.8 Backend settings

A **Music Video** section in `src/components/SettingsModal.jsx` (a tab already exists as a pattern —
`GeneralTab` at `:214`), persisted as **one namespaced object under the existing `settings:set` key
`mv.settings`** — *not* a new `config.json`, because Belrog already has one settings store and a second
file means two truths:

| Control | Key |
|---|---|
| LLM backend radio: sidecar (default) / LM Studio / OpenRouter | `mv.settings.llm.backend` |
| Model picker: 3 presets + "local file / custom URL" | `mv.settings.llm.model` |
| LM Studio base URL (default `http://localhost:1234`) | `mv.settings.llm.lmstudioUrl` |
| OpenRouter key presence (never the value in plain text beyond what the app already does) | `mv.settings.llm.openrouterKeySet` |
| ComfyUI URL + **Test** button (`GET /object_info`, shows node count + checkpoint list) | `mv.settings.comfy.url` |
| Render defaults: resolution / fps / steps / CFG | `mv.settings.render.*` (feeds `ltxParams`, §11.3) |
| Output root folder picker (default `<userData>/projects`) | `mv.settings.outputRoot` |

Nothing is read from disk per shot: one settings snapshot is taken at run start and written into
`project.json`, so a settings change mid-run cannot split one render across two configurations.

`ACC-6` change backend mid-run → the running job is unaffected; the next run uses the new value. Test
button against a dead URL → red state with the fetch error, and `Generate video` explains why it is
disabled.

### 11.9 The class that ties it together

```
src/services/musicVideoPipeline.js   (new) — the orchestrator: pure state machine,
    ingest → structure → script → validate → compile → render loop → stitch → mux.
    No fs, no child_process, no fetch: every side effect arrives through an injected host
    { fs, spawn, comfy, llm, log }, so the whole pipeline is testable zero-GPU with a fake host.
electron/musicVideoHost.js           (new) — the real host: fs + paths, spawns the sidecar,
    drives comfyui.js, tails the log.
electron/main.js                     — registers mv:* handlers, owns the host, kills the sidecar on quit.
electron/preload.js                  — exposes onMvProgress/onMvShotDone/onMvError/onMvComplete
                                        (same shape as onExportProgress at :152).
```

IPC (namespaced `mv:`, matching the repo's `export:`/`window:` style):

| Channel | Dir | Payload |
|---|---|---|
| `mv:ingest` | invoke | `{ path } → { songId, projectDir, probe }` |
| `mv:generateScript` | invoke | `{ songId, backend?, model? } → { ok, planPath, gates }` |
| `mv:start` / `mv:pause` / `mv:cancel` | invoke | `{ songId } → { ok }` |
| `mv:status` | invoke | `→ state.json + derived ETA` |
| `mv:progress` | event | `{ songId, shotId, index, total, stage, percent, etaSec }` |
| `mv:shot-done` | event | `{ songId, shotId, mp4, thumb, durationMs }` |
| `mv:error` | event | `{ songId, shotId?, stage, message, logPath }` |
| `mv:complete` | event | `{ songId, finalPath, durationSec, sizeBytes }` |

**Sidecar lifecycle: start lazily on the first `mv:generateScript`, not at app launch** (this deviates
from the sketch, deliberately): a 5.4 GB model resident while the user drags clips around is RAM spent on
nothing, and on Spark that RAM is already spoken for. Idle-timeout 5 min, killed on `before-quit`, pid +
log path in `project.json` (§3 `llm`). Gracey can overrule this if startup latency turns out to matter
more than the memory.

`ACC-7` drive the entire flow with **zero terminal use**: drop file → Generate Script → watch →
`final/<song-id>.mp4`, and every state change is visible as an event. `ACC-8` with a fake host, the
whole pipeline runs in a Node test, no Electron, no GPU, no ComfyUI.

### 11.10 Packaging

`package.json` `build.extraResources` gains, alongside the existing ffmpeg-static / ffprobe /
RIFE / RTX-VSR entries:

```json
{ "from": "build/llama-runtime/${os}-${arch}", "to": "llama-runtime", "filter": ["**/*"] }
```

plus the CI step that puts the binary there per platform, the same shape that produces
`build/rife-runtime/${os}-${arch}/rife` (O-6). Runtime path resolution through
`process.resourcesPath` with a `NODE_ENV=development` fallback to the repo copy. macOS: executable bit +
notarization-clean, or the sidecar is a silent no-op on the one platform most users have.

`ACC-9` a packaged build on each OS finds `llama-server` and reports its path in `mv:status`; a missing
binary **degrades to `lmstudio`/`openrouter` with a stated reason**, never a hang (ACQ-3 again).

---

## 12. Sequencing

Freeze `plan.json` schema (both, ~1 h) → W-A steps 1–4 and W-B steps 1–3 in parallel → V-gates land →
fixture test green → **app surface §11 (ingest, project tree, `mv:*` IPC, status UI, logs,
`mv.settings`, fake-host test — all zero-GPU)** → **D4 single clip (needs Henry's H1 go)** → full run.
Zero GPU until the single clip; no `--run` before gates are green. The app surface sits **before** the
GPU gate on purpose: if the integration is wrong, the gate gets argued with a demo instead of a spec.

W-A step 7 (first-run model UX) can be built in parallel from day one: its acceptance checks need no
GPU, no ComfyUI and no model weights — ACQ-1 passes with a 2 MB dummy file behind the same download
path, so the UX is proven long before a real 5 GB GGUF is picked.
