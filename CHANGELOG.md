# Changelog

## v0.4.0 (Belrog 0.4.00) — 2026-09-29

### Security
- **SSH key material removed from full git history.** `ssh-keys/` (an OpenSSH private key used for passwordless Belrog → server SSH) had been removed from the working tree in September, but remained recoverable from history via `git show <old-commit>:ssh-keys/id_rsa`. The entire 420-commit history was rewritten (git-filter-repo) and force-pushed; the key is now absent from every commit on `main`. The pre-rewrite bundle is stored off-repo. The exposed key must be treated as revoked and rotated.

### Keyframes (music video generation)
- **Qwen-Image-Edit 2511 is now the default local keyframe model.** Bundled workflows (`image_qwen_image_edit_2509.json`, `image_qwen_image_edit_2509_Model_and_Product.json`) and the dependency-pack checklist now point at `qwen_image_edit_2511_bf16.safetensors` + `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors`. 2511 measurably separates scene change from identity preservation (A/B tested on the real GPU against the 2509 clone).
- **Face-only preservation prompt dialect.** Keyframe shot prompts now order the model to keep the face only and fully re-dress/re-stage (replacing the wardrobe-lock `continuityFocus` wording that fed the clone). `QWEN_KEYFRAME_EDIT_PREFIX` / `QWEN_KEYFRAME_NEGATIVE` live in `musicVideoShotConfig.js` as a single source of truth.
- **Negative conditioning no longer clobbered.** `modifyQwenImageEdit2509Workflow` writes the negative prompt into `TextEncodeQwenImageEditPlus` negative nodes instead of the positive prompt, and sampler overrides (steps/cfg/denoise) are null-safe so existing Lightning 4-step defaults are preserved.
- Install catalog now ships verified download recipes for the 2511 checkpoint (40.9 GB BF16) and its Lightning LoRA.

### Timeline (Resolve-21 look)
- **Eased auto-follow.** During playback the timeline no longer snaps `scrollLeft` every frame; a rAF loop eases toward the follow target so the view glides (same cached-metric discipline — the hot path stays pure arithmetic).
- **Playhead polish.** Gradient shaft, tighter glow, larger gradient handle with crisper shadow.
- **Clip polish.** Video clips gained subtle inset top-highlight/bottom-shadow depth and the selection ring is now Resolve-style orange.

### App icon & Windows installer
- New icon: **B wreathed in flames** (regenerated, vision-verified 9.5/10). Replaces the prior "B + film strip" mark in `build/icon.{png,ico,icns}` — Windows exe icon, Linux icons, and macOS all pick it up.

### Build / CI
- `Release Desktop Builds` gains two dispatch inputs:
  - `sign` (`true`/`false`, default `true`) — `false` produces **unsigned Windows test builds**: Azure secrets are not required and `azureSignOptions` is stripped before packaging.
  - `build` (`all`/`windows-only`, default `all`) — test builds can skip macOS/Linux runners.
- Version bumped `0.3.32` → `0.4.0`.