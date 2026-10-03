# ONE-SHOT H3 — Offline Test Session Commands

How this works: I build, you run. Each phase is a block you paste into the
Spark console **after shutting my agent down** (phases marked 🟢 can run with
me still on). When a phase finishes, turn me back on and tell me which phase
you ran — I read `~/h3-oneshot-runs/*/oneshot-run.log` and `state.json` and
decide the next iteration.

All scripts live in: `/home/henlafon/belrog-src/scripts/oneshot/`
Everything logs to: `~/h3-oneshot-runs/run_<timestamp>/` (`oneshot-run.log`,
`state.json`) — the runner also self-heals: a stalled chain auto-resumes from
the first missing clip, never from scratch.

---

## 🟢 PHASE 0 — audit (safe, read-only, GPU untouched)

```bash
cd /home/henlafon/belrog-src/scripts/oneshot && ./01-audit.sh
```

Paste me the output (or just say done). Any `MISSING MODEL` lines = we stop
and talk (ref2va engine likely needs a ~20GB fetch from Comfy-Org/MiniMax-H3).

## PHASE 1 — install the auto-chain addon (ComfyUI restarts ~30s)

```bash
cd /home/henlafon/belrog-src/scripts/oneshot && ./02-install-addon.sh
```

Ends with `addon live: N AutoChain nodes registered` or a FAIL — tell me which.

## PHASE 2 — dry run (queues nothing; safe either way)

```bash
cd /home/henlafon/belrog-src/scripts/oneshot && ./03-dry-run.sh /path/to/song.mp3 /path/to/script.txt "cinematic photoreal, consistent character"
```

I want to see the clip plan (count + per-clip seconds) before a single frame renders.

## PHASE 3 — SMOKE RUN: 3 clips (~60s of video)  🔴 shut me down first

Smoke = short 3-shot script + a ~60s audio excerpt so the loop is ~1-2h:

```bash
cd /home/henlafon/belrog-src/scripts/oneshot
ffmpeg -y -i /path/to/full-song.mp3 -t 60 -c copy /tmp/smoke60.mp3
./04-run.sh /tmp/smoke60.mp3 /path/to/smoke-script.txt "cinematic photoreal, consistent character" 20
```

It prints the run dir and exits — the runner keeps going after you close the
terminal. Check anytime (works with me off or on):

```bash
cd /home/henlafon/belrog-src/scripts/oneshot && ./05-status.sh
```

**If it dies mid-run — do nothing, it auto-resumes. If the box reboots**
(overcurrent risk), re-run the same line with the chain pinned:

```bash
H3_CHAIN=<chainId from state.json> ./04-run.sh --resume /tmp/smoke60.mp3 /path/to/smoke-script.txt
```

(If that flag form errors, tell me the state.json contents and I'll make the
resume by hand next session.)

## PHASE 4 — FULL RUN (the 20-hour one)  🔴 shut me down, only after Phase 3 is signed off

```bash
cd /home/henlafon/belrog-src/scripts/oneshot
./04-run.sh /path/to/full-song.mp3 /path/to/full-script.txt "cinematic photoreal, consistent character" 20
```

Same status/watch commands. The runner auto-resumes stalls for up to 3x
expected runtime, then bails honestly.

---

## What I look at when you turn me back on

1. `state.json` → stage / clips done / resume cursor
2. `oneshot-run.log` → per-clip timings, warnings, audit lines, re-queues
3. the clip MP4s themselves → join quality (the 1-second clip-1 trim question), lip-sync drift at cuts
4. `journalctl -k` for reboot/brownout evidence if the run died strangely

## Known open questions this test answers

- clip-1 1-second-short join behavior at real joins (their docs' warning)
- lip-sync quality on singing vs speech (Phase 3 visual check — YOU eyeball the clips)
- H3 memory coexistence (runner tries to free vLLM before queueing; vLLM is a HOST process so it may need the manual 'sudo kill' the script prints — with vLLM up it holds ~88GB of the 121GB unified pool, leaving H3 only ~33GB: not recommended. KEEP_VLLM=1 skips freeing entirely.)
