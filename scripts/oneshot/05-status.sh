#!/usr/bin/env bash
# ONE-SHOT H3 — status snapshot of the newest run. Read-only.
set -u
RUNDIR=$(ls -dt "$HOME"/h3-oneshot-runs/run_* 2>/dev/null | head -1)
[ -n "${RUNDIR:-}" ] || { echo "no runs found under ~/h3-oneshot-runs"; exit 1; }
echo "run: $RUNDIR"
[ -f "$RUNDIR/state.json" ] && python3 - "$RUNDIR/state.json" <<'EOF'
import json, sys
s = json.load(open(sys.argv[1]))
total = s.get('clipsTotal') or 0
done = s.get('done') or []
pct = round(len(done)/total*100) if total else 0
bar = '#' * (pct//4) + '.' * (25 - pct//4)
print(f"stage : {s.get('stage')}   chain: {s.get('chainId')}")
print(f"clips : {len(done)}/{total}  [{bar}] {pct}%")
print(f"start : {s.get('startClip')} (resume cursor)  final: {s.get('final')}")
print(f"updated: {s.get('updatedAt')}")
EOF
echo "--- last log lines ---"
tail -6 "$RUNDIR/oneshot-run.log" 2>/dev/null
echo "--- stitched final? ---"
ls -lht /home/henlafon/shared/image-generation/video/ 2>/dev/null | grep -v clip_ | head -3
RUNNER=$(cat "$RUNDIR/runner.pid" 2>/dev/null)
if [ -n "${RUNNER:-}" ] && kill -0 "$RUNNER" 2>/dev/null; then echo "runner: ALIVE (pid $RUNNER)"; else echo "runner: not running"; fi
