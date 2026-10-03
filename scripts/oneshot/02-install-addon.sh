#!/usr/bin/env bash
# ONE-SHOT H3 — install the auto-chain addon into the spark-comfyui container.
# SAFE: clones into the custom_nodes bind-mount (NOT docker cp), then restarts
# the ComfyUI service via the proper manager. ComfyUI must be IDLE.
# Usage: ./02-install-addon.sh   (needs sudo ONLY for the service restart)
set -eu
TARGET="/home/henlafon/spark-comfyui/data/custom_nodes/ComfyUI-H3-Motion-Context-Auto-Chain-addon"
REPO="https://github.com/Ltamann/ComfyUI-H3-Motion-Context-Auto-Chain-addon"

if [ -d "$TARGET" ]; then
  echo "addon already at $TARGET — pulling latest"
  git -C "$TARGET" pull --ff-only
else
  git clone --depth 1 "$REPO" "$TARGET"
fi

echo "--- syntax-check nodes on host before restart ---"
python3 -m py_compile "$TARGET/auto_chain_nodes.py" "$TARGET/motion_context_core.py" && echo "py ok"

echo "--- restart ComfyUI (service) ---"
/home/henlafon/spark-comfyui/spark-comfyui.sh service restart 2>/dev/null || sudo docker restart spark-comfyui

echo "--- wait for boot ---"
for i in $(seq 1 30); do
  sleep 4
  N=$(curl -s --max-time 5 http://127.0.0.1:8188/object_info 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(sum(1 for k in d if 'AutoChain' in k))" 2>/dev/null || echo 0)
  if [ "${N:-0}" -ge 6 ]; then echo "addon live: $N AutoChain nodes registered"; exit 0; fi
done
echo "FAIL: addon nodes not visible after 120s — check: docker logs --tail 50 spark-comfyui"
exit 1
