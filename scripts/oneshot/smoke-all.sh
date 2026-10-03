#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  ONE-SHOT H3 — smoke run, everything in one script.
#  Run after shutting the agent down:
#     /home/henlafon/belrog-src/scripts/oneshot/smoke-all.sh
#
#  Steps: stage audio -> free vLLM -> launch chain -> watch with progress
#         bar until done/fail -> complete report saved to REPORT.txt
# ═══════════════════════════════════════════════════════════════════════
set -u
REPO=/home/henlafon/belrog-src
SON=$REPO/scripts/oneshot
INPUT=/home/henlafon/spark-comfyui/data/input
OUTV=/home/henlafon/shared/image-generation/video
AUDIO_SRC="/home/henlafon/.hermes/attachments/Answer to My Name.mp3"
SCRIPT_TXT=/tmp/smoke-script.txt
STYLE="cinematic photoreal, 35mm film look, cold blue palette, consistent character"
RUNDIR="$HOME/h3-oneshot-runs/smoke_$(date +%Y%m%d_%H%M%S)"
REPORT="$RUNDIR/REPORT.txt"
CHAIN=""
mkdir -p "$RUNDIR"
say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()  { say "  ✔ $*"; }
bad() { say "  ✘ $*"; }

# smoke script (self-heal if /tmp was cleared between sessions)
if [ ! -s "$SCRIPT_TXT" ]; then
cat > "$SCRIPT_TXT" <<'EOF'
BELROG DIRECTOR SCRIPT
CHARACTER: rose — young woman, early twenties, silver-blonde braid over left shoulder, olive field jacket over cream knit, warm brown eyes, mud-spattered boots
LOCATION: pine_forest | location_dpf | dense pine forest at blue hour, cold fog drifting between trunks, single lantern as practical light

Coverage 1: Main
Shot 1: T-01
Start at: 0:00
Length: 20
Artist: rose
Keyframe prompt: LOCATION: (location_dpf), rose stands between fogged pine trunks holding a lantern, singing quietly into the cold air. CHARACTER: rose only; exact supplied appearance.
Motion prompt: slow dolly forward through drifting fog, lantern sway matching her voice

Shot 2: T-02
Start at: 0:20
Length: 20
Artist: rose
Keyframe prompt: close-up on rose's face lit by lantern from below, singing with closed eyes, breath visible in cold air, fogged pines behind. CHARACTER: rose only; exact supplied appearance. LOCATION: (location_dpf).
Motion prompt: shallow rack focus from pine branch to her face, subtle handheld sway

Shot 3: T-03
Start at: 0:40
Length: 20
Artist: rose
Keyframe prompt: wide shot, rose turns and walks deeper between the pines, lantern light shrinking, fog swallowing the frame edge to edge. CHARACTER: rose only; exact supplied appearance. LOCATION: (location_dpf).
Motion prompt: locked static camera, fog slowly overtaking the silhouette
EOF
ok "smoke script restored at $SCRIPT_TXT"
fi

echo "════════ STEP 1/4  stage audio ════════"
if [ -f "$AUDIO_SRC" ]; then
  cp -f "$AUDIO_SRC" "$INPUT/" && ok "full song copied to ComfyUI input"
  ffmpeg -y -v error -i "$INPUT/Answer to My Name.mp3" -t 60 -c copy "$INPUT/smoke60.mp3" \
    && ok "smoke60.mp3 cut (60s)" || { bad "ffmpeg cut failed"; exit 1; }
elif [ -f "$INPUT/smoke60.mp3" ]; then ok "smoke60.mp3 already staged"
else bad "no audio found ($AUDIO_SRC or input/smoke60.mp3)"; exit 1; fi

echo "════════ STEP 2/4  free vLLM (~88GB) ════════"
VPID=$(pgrep -f "VLLM::EngineCore" | head -1)
if [ -n "${VPID:-}" ]; then
  say "  vLLM engine running (pid $VPID) — stopping it (needs sudo)"
  sudo kill "$VPID" 2>/dev/null || { bad "could not kill vLLM (sudo failed). Continuing anyway — H3 will have only ~33GB."; }
  for i in $(seq 1 15); do pgrep -f VLLM::EngineCore >/dev/null || break; sleep 2; done
  pgrep -f VLLM::EngineCore >/dev/null && bad "vLLM still resident" || ok "vLLM down — full 121GB pool free"
else ok "vLLM already stopped"; fi

echo "════════ STEP 3/4  launch chain ════════"
cd "$SON"
H3_RUNDIR="$RUNDIR" H3_LOG="$RUNDIR/oneshot-run.log" H3_STATE="$RUNDIR/state.json" \
  ./04-run.sh smoke60.mp3 "$SCRIPT_TXT" "$STYLE" 20 2>&1 | sed 's/^/  /' | tail -5
STATE="$RUNDIR/state.json"
for i in $(seq 1 30); do [ -f "$STATE" ] && grep -q chainId "$STATE" 2>/dev/null && break; sleep 2; done
CHAIN=$(python3 -c "import json;print(json.load(open('$STATE')).get('chainId',''))" 2>/dev/null)
[ -n "$CHAIN" ] && ok "chain launched: $CHAIN" || { bad "runner never wrote state — check $RUNDIR/runner.out"; }

echo "════════ STEP 4/4  watch progress ════════"
START=$(date +%s); DEADLINE=$((START + 3*3600)); FAIL=""
while :; do
  # verdict first: done = 3 clips AND a non-clip composite newer than clips,
  # OR all 3 clips present AND runner exited cleanly (stitch mode covers it)
  NCLIP=$(ls "$OUTV"/${CHAIN}_clip_*.mp4 2>/dev/null | wc -l); NCLIP=${NCLIP:-0}
  FINAL=$(ls "$OUTV"/${CHAIN}final*.mp4 "$OUTV"/${CHAIN}_final*.mp4 2>/dev/null | head -1)
  if [ "$NCLIP" -ge 3 ] && { [ -n "$FINAL" ] || ! pgrep -f run-oneshot-chain.mjs >/dev/null; }; then
    ok "all 3 clips present${FINAL:+ + final composite}"; break
  fi
  STAGE=$(python3 -c "import json;print(json.load(open('$STATE')).get('stage',''))" 2>/dev/null)
  [ "$STAGE" = "failed" ] && { FAIL="runner reported failed"; break; }
  # progress bar from clip files on disk
  DONE=$(ls "$OUTV"/${CHAIN}_clip_*.mp4 2>/dev/null | wc -l); DONE=${DONE:-0}
  ELAP=$(( ($(date +%s) - START) / 60 ))
  P=$((DONE*100/3)); [ $P -gt 100 ] && P=100
  BAR=$(printf '%0.s#' $(seq 1 $((P/4))) 2>/dev/null)$(printf '%0.s.' $(seq 1 $((25-P/4))) 2>/dev/null)
  printf '\r  [%s] %3d%%  clips %d/3  %dm elapsed     ' "$BAR" "$P" "$DONE" "$ELAP"
  # watchdogs
  NEWEST=$(ls -t "$OUTV"/${CHAIN}_clip_*.mp4 2>/dev/null | head -1)
  if [ $DONE -gt 0 ] && [ -n "$NEWEST" ] && [ $(( $(date +%s) - $(stat -c %Y "$NEWEST") )) -gt 3000 ]; then
    FAIL="no new clip for 50min after clip $DONE — stalled"; break; fi
  [ $(date +%s) -gt $DEADLINE ] && { FAIL="3h hard cap reached"; break; }
  if ! pgrep -f run-oneshot-chain.mjs >/dev/null && [ $DONE -lt 3 ]; then
    sleep 20; pgrep -f run-oneshot-chain.mjs >/dev/null && continue
    # runner may be between re-queues; if it exited entirely, trust the files
    DONE2=$(ls "$OUTV"/${CHAIN}_clip_*.mp4 2>/dev/null | wc -l); DONE2=${DONE2:-0}
    [ $DONE2 -ge 3 ] && break
    FAIL="runner exited with only $DONE2/3 clips"; break; fi
  sleep 20
done
echo

# ── complete report ────────────────────────────────────────────────────
{
  echo "════════ ONE-SHOT H3 SMOKE — COMPLETE REPORT $(date -Is) ════════"
  echo "chain: $CHAIN   run dir: $RUNDIR"
  echo "outcome: ${FAIL:+FAIL — $FAIL}${FAIL:-complete (or clips present)}"
  echo
  echo "--- clips on disk ---"
  if ls "$OUTV"/${CHAIN}_clip_*.mp4 >/dev/null 2>&1; then ls -lh "$OUTV"/${CHAIN}_clip_*.mp4; else echo "  (none)"; fi
  echo "--- final composite ---"
  COMPOSITE=$(ls "$OUTV"/${CHAIN}_final*.mp4 2>/dev/null | head -1)
  if [ -n "$COMPOSITE" ]; then ls -lh "$COMPOSITE"; else echo "  (none)"; fi
  echo "--- clip durations vs expected (20.75s each, final ~60s) ---"
  for f in "$OUTV"/${CHAIN}_clip_*.mp4; do [ -f "$f" ] && echo "  $(basename "$f"): $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")s"; done
  echo "--- warnings/errors from runner log ---"
  grep -iE "warn|error|fail|skip" "$RUNDIR/oneshot-run.log" 2>/dev/null | tail -10 || echo "  (clean log)"
  echo "--- tail of log ---"
  tail -8 "$RUNDIR/oneshot-run.log" 2>/dev/null
  echo "--- state.json ---"
  cat "$STATE" 2>/dev/null
  echo "--- kernel reboot check ---"
  journalctl -k --since "-4 hours" 2>/dev/null | grep -icE "oom|watchdog|thermal|brownout" | xargs -I{} echo "  reboot-risk log lines: {}"
  echo "════════ END REPORT — turn the agent back on and say 'read the smoke report' ════════"
} | tee "$REPORT"
