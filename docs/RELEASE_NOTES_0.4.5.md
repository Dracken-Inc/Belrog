# Release Notes — Belrog 0.4.5

## Cast/Props/Locations: your script now names them correctly

Before 0.4.5, Belrog guessed what your cast, props, and locations were by
scanning shot text for quoted phrases and capitalized words. Guessing means
it sometimes grabbed structural words from the director format itself
(`Shot type: b_roll`, `CONTINUITY RULES`, `DIRECTOR STEER`) as fake
"locations", and the guessed names didn't match their descriptions.

0.4.5 makes your script the **authoritative source** via an **asset legend**,
and lets you edit everything Cast detects.

---

### 1. The Asset Legend (paste into your script / Perchance output)

Before the first `Scene`/`Shot` block, declare every asset — one line each:

```
slug : description , TYPE
```

Example:

```
CHARACTER: rose — the lead singer, silver braid, kind eyes, worn flannel shirt
monastery-cell : cavernous damp cell with charcoal-grey walls, one candle , LOCATION
old-cassette : worn cassette tape with green-glowing label , PROP
```

Both forms are accepted, mixed freely:
- `TYPE: slug — description` (prefix form: `CHARACTER:` / `CAST:` / `LOCATION:` / `PROP:`)
- `slug : description , TYPE` (trailing form — the format the Perchance LTX
  director list emits)

Rules:
- **slug** — short, lowercase, hyphenated. It is the EXACT token used in every
  `Artist:` line for that asset. One slug = one asset.
- **description** — one concrete visual line (subject, key visual traits,
  material/lighting). No "the character" vagueness — **this text becomes the
  reference-image generation prompt verbatim.**
- **TYPE** — `CHARACTER` | `LOCATION` | `PROP`
- Legend lines count ONLY before the first scene heading. Do not repeat them
  inside scenes.
- Do NOT list `Shot type:`, `CONTINUITY RULES`, or `DIRECTOR STEER` as assets —
  they are structural markers. 0.4.5 also ignores them if they ever slip in.

### 2. How auto-detection + naming works (0.4.5)

1. **Parse.** `parseAssetLegendLines` reads the legend block (both forms) into
   `{ kind, slug, name, description }`. Legend lines are excluded from scene /
   shot text, so they can never be mis-detected as assets.
2. **Detect.** `detectScriptGaps` merges detection results in priority order:
   - **Legend entries first** — authoritative. Name, slug, and description are
     verbatim from your script; name always relates to description because
     they come from the same line.
   - **Heuristic guesses second** — only for assets you did NOT declare
     (quoted phrases + capitalized proper nouns across ≥2 shots, or
     already-known entities). Any guess whose slug matches a declared asset
     is dropped — your declaration always wins, in both directions.
3. **Auto-stub.** On every parse, detected + declared assets are upserted
   into the Cast library (idempotent — re-parsing adds nothing; entries that
   already have a reference image are left alone). Descriptions are seeded so
   Regenerate-All can queue everything.
4. **Edit.** Every Cast entry now has editable **Name** (free-form display
   label) and **Slug** (the script-routing token — collision-safe; a slug
   owned by another entry of the same type is rejected with a clear message),
   plus the existing editable description.
5. **Use.** Import from Cast into the music workflow as before; reference
   images generate from the description verbatim.

### 3. Perchance fragment

Add this to the LTX director list instructions:

```
Before the first Scene/Shot block, output an ASSET LEGEND: one line per
character, location, and prop in the video. Format (exact):

  slug : description , TYPE

- slug: short lowercase, hyphenated, the EXACT token used in every "Artist:"
  line for that asset. One slug = one asset.
- description: one concrete visual line (subject, key visual traits,
  material/lighting). This text becomes the reference-image prompt verbatim.
- TYPE: CHARACTER | LOCATION | PROP

Example:
  rose : the lead singer, silver braid, kind eyes, worn flannel shirt , CHARACTER
  monastery-cell : cavernous damp cell with charcoal-grey walls, one candle , LOCATION
  old-cassette : worn cassette tape with green-glowing label , PROP

Do NOT repeat legend lines inside scenes. Never list structural markers
("Shot type:", "CONTINUITY RULES", "DIRECTOR STEER") as assets.
```

Belrog's own LTX director prompt now requests this legend automatically.

### Fixes
- Section headers (`Shot type: …`, `CONTINUITY RULES`, `DIRECTOR STEER`) can
  no longer appear as detected locations — blocked at parse (excluded from
  shot text) and at detection (structural-marker filter + cross-kind
  promotion so a declared PROP never shows as a heuristic location).
- Legend lines carrying the type twice (`LOCATION: x : desc , LOCATION`) no
  longer leak the trailing type into the description.

### Verification
- Test suite: **18/18** (4 new tests: both legend forms parsed,
  authoritative naming + zero header leakage, legend-suppresses-heuristic in
  both directions, collision-safe rename).
- Build green, RIFE hardening 43/44 (1 pre-existing host-ffmpeg check,
  unrelated).
