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
AUDIO="${1:?usage: 04-run.sh song.mp3 script.txt [style] [chunk]}"
SCRIPT="${2:?need script}"
STYLE="${3:-}"
CHUNK="${4:-20}"
INPUT_DIR="/home/henlafon/spark-comfyui/data/input"
OUTPUT_V="/home/henlafon/shared/image-generation/video"

mkdir -p "$RUNDIR" "$OUTPUT_V"
cp -n "$AUDIO" "$INPUT_DIR/" || true
BASE=$(basename "$AUDIO")

echo "=== ONE-SHOT run starting $(date -Is) ==="
echo "run dir: $RUNDIR"

# pre-flight: refuse to start if ComfyUI is unreachable or already busy
curl -s --max-time 5 http://127.0.0.1:8188/system_stats >/dev/null || { echo "FAIL: ComfyUI down"; exit 1; }
Q=$(curl -s http://127.0.0.1:8188/queue | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('queue_running',[]))+len(d.get('queue_pending',[])))")
[ "$Q" = "0" ] || { echo "FAIL: ComfyUI queue is not empty ($Q jobs). Let it drain first."; exit 1; }

# Free unified memory for H3. Live check (2026-10-03): the 87GB vLLM engine is
# NOT a sparkrun workload (sparkrun status: idle) and not a systemd unit —
# it's a host process; earlyoom protects it. Try sparkrun first (in case it's
# ever launched that way), then say honestly what we failed to stop.
if [ "${KEEP_VLLM:-0}" != "1" ]; then
  if command -v sparkrun >/dev/null; then
    sparkrun stop fe6334717bce 2>/dev/null || true
  fi
  # non-destructive report: if a big vLLM engine is still resident, warn loudly
  BIGV=$(pgrep -f "VLLM::EngineCore" | head -1)
  if [ -n "${BIGV:-}" ]; then
    RSS=$(awk '/VmRSS/{print int($2/1048576)"G"}' /proc/"$BIGV"/status 2>/dev/null || echo "?G")
    if [ "${RSS%G}" != "0G" ]; then
      echo "WARN: vLLM engine still running (pid $BIGV, ${RSS} RSS). Run 'sudo kill $BIGV' for full GPU/memory headroom, or set KEEP_VLLM=1 to accept coexistence."
    fi
  fi
fi

cd "$BELROG_REPO"
H3_LOG="$RUNDIR/oneshot-run.log" H3_STATE="$RUNDIR/state.json" H3_CHAIN="${H3_CHAIN:-}" \
  nohup node scripts/oneshot/run-oneshot-chain.mjs \
    --audio "$BASE" --script "$SCRIPT" --style "$STYLE" --chunk "$CHUNK" \
    > "$RUNDIR/runner.out" 2>&1 &
PID=$!
echo $PID > "$RUNDIR/runner.pid"
echo "runner pid $PID — detach is fine, it survives."
echo
echo "watch with:  tail -f $RUNDIR/oneshot-run.log"
echo "status with: ./05-status.sh   (or cat $RUNDIR/state.json)"
