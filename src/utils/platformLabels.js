/**
 * Platform-aware wording for user-facing strings. The ComfyUI Portable launcher
 * is a .bat on Windows and a .sh everywhere else, and the SSH key lives in a
 * different place on each OS - printing the Windows path on a Linux box reads as
 * a broken app, not as advice.
 */

function currentPlatform() {
  if (typeof process !== 'undefined' && process?.platform) return process.platform
  if (typeof window !== 'undefined' && window?.electronAPI?.platform) return window.electronAPI.platform
  return ''
}

export function isWindowsPlatform(platform = currentPlatform()) {
  return String(platform || '').startsWith('win32')
}

/** The launcher script name a user should pick for their OS. */
export function launcherScriptName(platform = currentPlatform()) {
  return isWindowsPlatform(platform) ? 'run_nvidia_gpu.bat' : 'run_nvidia_gpu.sh'
}

export function noLauncherConfiguredMessage(platform = currentPlatform()) {
  return `No launcher configured. Pick your ${launcherScriptName(platform)} to let Belrog start ComfyUI`
}

export function noLauncherConfiguredInstruction(platform = currentPlatform()) {
  return `No launcher configured — open Settings → ComfyUI Launcher to pick your ${launcherScriptName(platform)}, or restart ComfyUI manually.`
}

export function sshKeyPathPlaceholder(platform = currentPlatform()) {
  return isWindowsPlatform(platform)
    ? 'C:\\Users\\you\\.ssh\\id_ed25519'
    : '~/.ssh/id_ed25519 (or /mnt/c/Users/you/.ssh/id_ed25519 in WSL)'
}
