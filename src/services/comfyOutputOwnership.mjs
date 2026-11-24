// Which files in ComfyUI's output folder belong to Belrog.
//
// Auto-import only brings in files the app asked ComfyUI to write, and the only record of that is
// the output prefix in the filename. A prefix left off this list is silently never imported - the
// generations just stop appearing - and a prefix written by an old build but missing here is
// stranded in the user's folder forever. Output prefixes were renamed to the belrog_* spelling in
// November 2026; both spellings stay listed, because the old files are already on disk and nothing
// else will move them into a project.
//
// Keep this file free of imports: it is the rule that decides whether someone's renders get pulled
// into their library, so it has to be readable and testable on its own.

const MANAGED_OUTPUT_RE = /^(director_job_|belrog_job_|belrog_|velorn_|velorn_job_|comfystudio_|comfystudio_job_|flow_ai_|topaz_video_upscale_|comfystudiomask_|BelrogMask_)/i

export function isBelrogManagedOutput(fileDesc) {
  return MANAGED_OUTPUT_RE.test(String(fileDesc?.filename || '').trim())
}
