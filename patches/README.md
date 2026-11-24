# Historical patch drafts — Qwen keyframe identity work (Sept 2026)

Three draft patches for the Qwen image-edit keyframe prompts, recovered from a stale
local clone before that clone was deleted on 2026-11-24. Kept for provenance only.

**Nothing here needs to be applied.** All three shipped as committed code in v0.4.86
and the current versions live in the normal source tree:

| Patch | Became | Lives now in |
| --- | --- | --- |
| `01-qwen-edit-dialect-prompts.patch` | face-only preservation wording in the storyboard prompt builder | `src/components/GenerateWorkspace.jsx`, `src/config/musicVideoShotConfig.js` |
| `02-qwen-modifier-sampler-negative.patch` | sampler/negative-prompt wiring for the image-edit workflow | `src/services/comfyui.js` |
| `03-qwen-keyframe-constants.patch` | the `QWEN_KEYFRAME_EDIT_PREFIX` / `QWEN_KEYFRAME_NEGATIVE` constants | `src/config/musicVideoShotConfig.js` |

Patch 01 is superseded, not missing. It says "preserve ONLY the facial identity of the
person in the input image" (singular). The two-person split testing in v0.4.86 proved a
singular prefix makes a two-person shot clone one face onto both cast members, so the
wording moved to per-person, image-index addressing and now goes through
`applyTwoPersonIdentityMapping`. Do not re-apply this patch on top of the current code.
