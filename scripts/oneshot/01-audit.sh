#!/usr/bin/env bash
# ONE-SHOT H3 — environment audit (SAFE: read-only, touches no GPU)
# Usage: ./01-audit.sh
set -u
BELROG_REPO="${BELROG_REPO:-/home/henlafon/belrog-src}"
COMFY="${COMFY:-http://127.0.0.1:8188}"
echo "=== ONE-SHOT environment audit $(date -Is) ==="

echo "--- ComfyUI reachable? ---"
curl -s --max-time 5 "$COMFY/system_stats" >/dev/null && echo "OK $COMFY" || { echo "FAIL: ComfyUI not reachable at $COMFY"; exit 1; }

echo "--- AutoChain addon nodes registered? ---"
MISS=0
for n in MiniMaxH3AutoChainAudio MiniMaxH3AutoChainMotionContext MiniMaxH3AutoChainMotionContextTrim \
         MiniMaxH3AutoChainSaveLatent MiniMaxH3AutoChainLoadLatent MiniMaxH3AutoChainFrameReference \
         MiniMaxH3AutoChain MiniMaxH3SparseChainStitch MiniMaxH3ReferenceToVideo MiniMaxH3AddGuide; do
  HIT=$(curl -s "$COMFY/object_info/$n" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d and '$n' in d else 'NO')" 2>/dev/null)
  [ "$HIT" = yes ] || { echo "MISSING NODE: $n"; MISS=1; }
done
[ $MISS -eq 0 ] && echo "all chain nodes present"

echo "--- Models on disk? ---"
for f in /home/henlafon/.models/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors \
         /home/henlafon/.models/vae/minimax_h3_video_vae_fp16.safetensors \
         /home/henlafon/.models/vae/minimax_h3_audio_vae_fp32.safetensors \
         /home/henlafon/.models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors \
         /home/henlafon/.models/loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors; do
  [ -f "$f" ] && echo "OK  $(basename $f)" || echo "MISSING MODEL: $f"
done

echo "--- Disk headroom (latents ~ GB/clip) ---"
df -h /home/henlafon/shared | tail -1
echo "=== audit done. If any MISSING lines above, run 02-install-addon.sh / fetch models BEFORE a run. ==="
