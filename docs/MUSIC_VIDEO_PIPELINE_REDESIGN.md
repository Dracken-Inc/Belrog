# Music Video pipeline: file in, script out (0.6.1)

## The rule

Step 1 takes a media file. **Everything between that file and Keyframes exists to
produce two things: a real director script, and the assets that script names.**
Those steps are mostly automatic. They are not four gates you have to push
through, and no step should ever require you to copy text into the clipboard.

## Target flow

| step | name | what it does | what it must leave behind |
|---|---|---|---|
| 1 | Song | pick mp3 / m4a / mp4; read duration; transcribe or import lyrics | clock + timed lyric lines |
| 2 | Director | the LTX planner **inline** (off the top tab bar). Belrog sends the seed/brief, the planner sends a script back, Parse turns it into shot tiles | a parsed shot list |
| 3 | Cast & Locations | built **from the script**: every `Artist:` slug and location the script mentions becomes an entry with a placeholder sheet | named assets, real sheets optional |
| 4 | Keyframes | unchanged | reference sheets per shot |
| 5 | Videos | unchanged | clips |

Steps 2 and 3 collapse into one panel once the placeholder harvest is automatic:
the director builds the script, the script builds the asset list, you fix faces
and then queue.

## What is broken now, with proof

1. **Copy Brief does nothing.** The laptop's `app.log` shows
   `Uncaught (in promise) NotAllowedError: Document is not focused.` eight times
   in 26 seconds. `copyTextToClipboard` (`GenerateWorkspace.jsx:481`) uses
   `navigator.clipboard`, which throws when focus is inside the Perchance iframe
   (`App.jsx:897`). No `clipboard.writeText` exists in `electron/main.js`, so there
   is no fallback. Nothing catches the rejection, so the UI reports success anyway.
2. **"Script from audio" ignores the song.** It opens a second file picker
   (`electron/main.js:4367`) instead of using the step-1 asset, reads only the
   file's own lyric tags (Suno m4a carries none), and never receives the step-1
   transcription — no code outside `src/services/` mentions `lyricsRaw`. Its
   filter omits mp4.
3. **Its output is boilerplate.** `sunoIntake.js:141-166` writes the same style
   line, the same "slow push-in", and the title `Suno tile 001` for every shot.
   No `Artist:`, no location, no story arc. 31 shots of the same frame.
4. **A script cannot fill in assets.** `yoloMusicResolvedCast`
   (`GenerateWorkspace.jsx:6327`) drops any cast entry without a finished image,
   so a script-first run sends a brief with no cast and gets back a script that
   cannot name anyone.
5. **Nothing pushes the current script back into the planner.** Brief goes out,
   script comes in; there is no return path for editing what you already have.

## Changes

### Stage 1 — make the parts work (no layout change)

- **Clipboard through the main process.** `electron/main.js` gains
  `belrog:writeClipboardText` using `electron.clipboard`; preload exposes it;
  `copyTextToClipboard` prefers it and reports failure instead of swallowing it.
  Focus-independent, which is the whole point.
- **Copy Brief sends, it does not copy.** It builds the same brief payload and
  posts it into the planner. A small "copy instead" fallback stays for offline.
- **One audio intake.** Reuse the step-1 asset, accept mp4/mov, and pass the
  step-1 timed lyrics into `sunoIntake` so lyric timing comes from the file, the
  transcription, or nothing — and say which.
- **The local generator stops writing fake shots.** It emits a *skeleton*: exact
  cut times, the real lyric line on each cut, `Artist: <slug>` and `Location:`
  lines marked uncast, and no invented keyframe prose. Story comes from the
  planner.
- **Cast resolution keeps unresolved slugs** in the brief as "to be cast"
  instead of dropping them.

### Stage 2 — the pipeline, and the layout move

- Director planner moves out of the top tab bar into step 2, kept mounted while
  the music workflow is open. `App.jsx`'s postMessage bridge moves into
  `src/services/directorBridge.js` so both mount points share one contract.
- **Build from this track** runs the chain end to end: probe → lyrics → brief →
  planner → script back → parse → placeholder assets. Each stage reports state,
  and the chain stops honestly if the planner needs a click.
- On any script landing (planner, parse, paste), harvest entities through
  `detectScriptGaps` + `buildStubUpserts` and create the missing cast/location
  entries as placeholders. That engine already exists and is tested; today it
  only runs when you open the gap panel.

## Verification

- `copyTextToClipboard` prefers the IPC path when `electronAPI` exists, and the
  test fails when that preference is removed.
- Audio intake test: feed a probe with no lyric tag plus timed lyrics from
  transcription and assert the script carries the lyric lines; remove the lyrics
  argument and it must go red.
- Skeleton test: assert every shot has an `Artist:` or is marked b-roll, and that
  shot times chain with zero gaps.
- Harvest test: script with `Artist: rose` and no rose asset ⇒ one placeholder
  entry created, and the brief still names rose as to-be-cast.
- Flow gate on the built bundle: step 2 contains the planner iframe, and removing
  it from the step fails the gate — same fixture pattern as the existing browser
  checks.
