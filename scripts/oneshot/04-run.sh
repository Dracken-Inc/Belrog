#!/usr/bin/env bash
# ONE-SHOT H3 — THE RUN. Start this AFTER shutting the agent down (GPU must be
# free of vLLM for honest render times). Survives logout via nohup; the runner
# watches disk, auto-resumes stalled chains, logs to oneshot-run.log.
#
# Usage:
#   ./04-run.sh /path/to/song.mp3 /path/to/script.txt [style text] [chunk_seconds]
#
# First-run discipline: audio must be copied into ComfyUI input dir first
# (this script does it). Chain id = oneshot_<timestamp> unless H3_CHAIN set.
set -eu
BELROG_REPO="${BELROG_REPO:-/home/henlafon/belrog-src}"
RUNDIR="${H3_RUNDIR:-$HOME/h3-oneshot-runs/run_$(date +%Y%m%d_%H%M%S)}"
AUDIO="${1:?usage: 04-run.sh song.mp3 [script.txt|--auto] [style] [chunk]}"
SCRIPT="${2:---auto}"
STYLE="${3:-}"
CHUNK="${4:-20}"
INPUT_DIR="/home/henlafon/spark-comfyui/data/input"
OUTPUT_V="/home/henlafon/shared/image-generation/video"

mkdir -p "$RUNDIR" "$OUTPUT_V"
SRC="$AUDIO"
[ -f "$SRC" ] || SRC="$INPUT_DIR/$(basename "$AUDIO")"   # bare name = already staged in ComfyUI input
[ -f "$SRC" ] || { echo "FAIL: audio not found: $AUDIO (give a path or stage it in $INPUT_DIR)"; exit 1; }
cp -n "$SRC" "$INPUT_DIR/" || true
BASE=$(basename "$AUDIO")

# --auto: build the tiled director script from the track itself (duration +
# embedded lyrics via ffprobe). Deterministic; same file = same script.
if [ "$SCRIPT" = "--auto" ]; then
  SCRIPT="$RUNDIR/auto-script.txt"
  node "$BELROG_REPO/scripts/oneshot/suno-script.mjs" --audio "$SRC" --style "$STYLE" --out "$SCRIPT" \
    || { echo "FAIL: suno-script.mjs could not build a script from $SRC"; exit 1; }
  echo "auto-script: $SCRIPT"
fi

echo "=== ONE-SHOT run starting $(date -Is) ==="
echo "run dir: $RUNDIR"

# pre-flight: refuse to start if ComfyUI is unreachable or already busy
curl -s --max-time 5 http://127.0.0.1:8188/system_stats >/dev/null || { echo "FAIL: ComfyUI down"; exit 1; }
Q=$(curl -s http://127.0.0.1:8188/queue | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('queue_running',[]))+len(d.get('queue_pending',[])))")
[ "$Q" = "0" ] || { echo "FAIL: ComfyUI queue is not empty ($Q jobs). Let it drain first."; exit 1; }

# vLLM policy: Henry stops vLLM — scripts NEVER kill it. We only check and warn.
if [ "${KEEP_VLLM:-0}" != "1" ]; then
  BIGV=$(pgrep -f "VLLM::EngineCore" | head -1)
  if [ -n "${BIGV:-}" ]; then
    RSS=$(awk '/VmRSS/{print int($2/1048576)"G"}' /proc/"$BIGV"/status 2>/dev/null || echo "?G")
    echo "WARN: vLLM engine still running (pid $BIGV, ${RSS} RSS). Henry: stop it for full 121GB pool; H3 coexists with only ~33GB otherwise. (Scripts will not kill it.)"
  fi
fi

cd "$BELROG_REPO"
H3_LOG="$RUNDIR/oneshot-run.log" H3_STATE="$RUNDIR/state.json" H3_CHAIN="${H3_CHAIN:-}" \
  nohup node scripts/oneshot/run-oneshot-chain.mjs \
    --audio "$SRC" --script "$SCRIPT" --style "$STYLE" --chunk "$CHUNK" \
    > "$RUNDIR/runner.out" 2>&1 &
PID=$!
echo $PID > "$RUNDIR/runner.pid"
echo "runner pid $PID — detach is fine, it survives."
echo
echo "watch with:  tail -f $RUNDIR/oneshot-run.log"
echo "status with: ./05-status.sh   (or cat $RUNDIR/state.json)"
