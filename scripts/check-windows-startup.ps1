<#
.SYNOPSIS
  Starts a packaged Belrog build and fails unless it shows a window a person can actually use.

.DESCRIPTION
  Why this exists: 0.5.1 shipped to Windows as an app that launched, threw "ReferenceError:
  workflowAssetInputs is not defined" inside app.whenReady(), and never showed its window. The
  process ran, the JS ran, the splash appeared, nothing else ever did. Every CI check was green
  because they all inspect files on disk - none of them ever started the thing.

  What counts as "opened": a top-level window, belonging to the launched process tree, that is
    - WS_VISIBLE and not DWM-cloaked (a cloaked window is invisible even when WS_VISIBLE),
    - has a caption, which excludes the frameless splash window - counting windows is exactly how
      the 0.5.1 bug would have looked fine - and
    - at least 500x350, so a hidden 400x200 export worker cannot pass as the app.

  Also fails on ReferenceError / "is not defined" / UnhandledPromiseRejection / "Cannot find
  module" in the child's stderr, and on failure prints every window it saw plus the stderr tail,
  because "it did not open" alone tells you nothing.

  The verdict comes from each process's MainWindowHandle (the OS's own idea of "the app window":
  top-level and captioned). A full EnumWindows sweep runs too, but only for diagnostics - it is
  called through a native callback, and a check must not depend on that for its answer.

  Belrog runs against a throwaway %APPDATA%, so no real profile is created or read, and the whole
  process tree is killed at the end. Exit 0 = opened, 1 = did not.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-windows-startup.ps1 -Executable release\win-unpacked\Belrog.exe
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [int]$TimeoutSeconds = 90,
  [string]$LogDirectory = '',
  [switch]$LeaveRunning
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not [System.IO.Path]::IsPathRooted($Executable)) { $Executable = Join-Path (Get-Location).Path $Executable }
if (-not (Test-Path -LiteralPath $Executable)) { throw "Belrog executable not found: $Executable" }
$exeDir = Split-Path -Parent $Executable

$workRoot = Join-Path $env:TEMP ('belrog-startup-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$appData = Join-Path $workRoot 'AppData\Roaming'
New-Item -ItemType Directory -Path $appData -Force | Out-Null
if ($LogDirectory) { New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null }

Add-Type -Namespace Win32 -Name Win -MemberDefinition @'
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtrW(IntPtr hWnd, int idx);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int val, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@

$GWL_STYLE = -16
$WS_VISIBLE = 0x10000000
$WS_CAPTION = 0x00C00000
$DWMWA_CLOAKED = 14
$MIN_WIDTH = 500
$MIN_HEIGHT = 350

function Test-UsableWindow([IntPtr]$handle) {
  if ($handle -eq [IntPtr]::Zero) { return $false }
  $style = [int64][Win32.Win]::GetWindowLongPtrW($handle, $GWL_STYLE)
  $cloaked = 0
  [void][Win32.Win]::DwmGetWindowAttribute($handle, $DWMWA_CLOAKED, [ref]$cloaked, 4)
  $rect = New-Object 'Win32.Win+RECT'
  [void][Win32.Win]::GetWindowRect($handle, [ref]$rect)
  $visible = [Win32.Win]::IsWindowVisible($handle) -and (($style -band $WS_VISIBLE) -ne 0)
  return $visible -and ($cloaked -eq 0) -and (($style -band $WS_CAPTION) -ne 0) `
    -and ($rect.Right - $rect.Left) -ge $MIN_WIDTH -and ($rect.Bottom - $rect.Top) -ge $MIN_HEIGHT
}

function Describe-Window([IntPtr]$handle) {
  if ($handle -eq [IntPtr]::Zero) { return 'none' }
  $style = [int64][Win32.Win]::GetWindowLongPtrW($handle, $GWL_STYLE)
  $cloaked = 0
  [void][Win32.Win]::DwmGetWindowAttribute($handle, $DWMWA_CLOAKED, [ref]$cloaked, 4)
  $rect = New-Object 'Win32.Win+RECT'
  [void][Win32.Win]::GetWindowRect($handle, [ref]$rect)
  $len = [Win32.Win]::GetWindowTextLength($handle)
  $title = ''
  if ($len -gt 0) {
    $buf = New-Object System.Text.StringBuilder ($len + 2)
    [void][Win32.Win]::GetWindowTextW($handle, $buf, $buf.Capacity)
    $title = $buf.ToString()
  }
  $flagVisible = [Win32.Win]::IsWindowVisible($handle)
  $styleVisible = (($style -band $WS_VISIBLE) -ne 0)
  $caption = (($style -band $WS_CAPTION) -ne 0)
  return ('WS_VISIBLE={0}/{1} cloaked={2} caption={3} {4}x{5} "{6}"' -f `
      $flagVisible, $styleVisible, ($cloaked -ne 0), $caption, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top), $title)
}

function Get-ProcessTree([int]$rootPid) {
  # Electron is a tree: browser process plus gpu/renderer/utility children.
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($rootPid)
  for ($pass = 0; $pass -lt 3; $pass++) {
    $found = $false
    foreach ($p in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
      if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
        [void]$ids.Add([int]$p.ProcessId); $found = $true
      }
    }
    if (-not $found) { break }
  }
  return @($ids | ForEach-Object { [int]$_ })
}

# Diagnostics only. The native callback runs these scriptblocks in script scope, so the pids to
# match have to live in $script: - a function-local variable reads as empty inside the callback.
$script:ProbePids = @()
$script:ProbeWindows = New-Object System.Collections.ArrayList
$probeCallback = [Win32.Win+EnumWindowsProc] {
  param($hWnd, $lParam)
  $owner = [uint32]0
  [void][Win32.Win]::GetWindowThreadProcessId($hWnd, [ref]$owner)
  if ($script:ProbePids -contains [int]$owner) {
    $rect = New-Object 'Win32.Win+RECT'
    [void][Win32.Win]::GetWindowRect($hWnd, [ref]$rect)
    [void]$script:ProbeWindows.Add([pscustomobject]@{ Pid = [int]$owner; Handle = $hWnd })
  }
  return $true
}

function Get-AllWindowsFor([int[]]$pids) {
  try {
    $script:ProbePids = @($pids)
    $script:ProbeWindows = New-Object System.Collections.ArrayList
    [void][Win32.Win]::EnumWindows($probeCallback, [IntPtr]::Zero)
    return @($script:ProbeWindows)
  } catch {
    return @()
  }
}

# APPDATA is redirected rather than passed as an argument so a real profile is never created or
# read. Start-Process has no -Environment on Windows PowerShell, so use ProcessStartInfo.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Executable
$psi.WorkingDirectory = $exeDir
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.EnvironmentVariables['APPDATA'] = $appData
$proc = [System.Diagnostics.Process]::Start($psi)
# Start draining immediately: an Electron app writes enough to stderr to fill a 4 KB pipe, and
# a full pipe blocks the child, which would then look like "it never opened".
$readErr = $proc.StandardError.ReadToEndAsync()
$readOut = $proc.StandardOutput.ReadToEndAsync()

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$opened = $false
$openDetail = ''
$seenWindows = @()
$exitCode = $null
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) { $exitCode = $proc.ExitCode; break }
  $pids = Get-ProcessTree -rootPid $proc.Id
  $found = $null
  foreach ($p in $pids) {
    try {
      $live = Get-Process -Id $p -ErrorAction Stop
      $live.Refresh()
      if (Test-UsableWindow -handle $live.MainWindowHandle) { $found = [pscustomobject]@{ Pid = $p; Handle = $live.MainWindowHandle }; break }
    } catch { }
  }
  $seenWindows = @(Get-AllWindowsFor -pids $pids | ForEach-Object { "pid=$($_.Pid) $(Describe-Window $_.Handle)" })
  if ($found) {
    $opened = $true
    $openDetail = "pid $($found.Pid) $(Describe-Window $found.Handle)"
    break
  }
  Start-Sleep -Milliseconds 500
}

if (-not $LeaveRunning) {
  foreach ($p in (Get-ProcessTree -rootPid $proc.Id)) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 1
try { [void]$readErr.Wait(3000) } catch { }
try { [void]$readOut.Wait(3000) } catch { }
$errText = if ($readErr.IsCompleted -and -not $readErr.IsFaulted) { $readErr.Result } else { '' }
$outText = if ($readOut.IsCompleted -and -not $readOut.IsFaulted) { $readOut.Result } else { '' }

$fatal = @()
foreach ($marker in @('ReferenceError', 'is not defined', 'UnhandledPromiseRejection', 'Cannot find module', 'TypeError: Cannot read propert')) {
  if ($errText -like "*$marker*") { $fatal += $marker }
}

$appLog = Join-Path $appData 'belrog\app.log'
$logTail = if (Test-Path -LiteralPath $appLog) { @(Get-Content -LiteralPath $appLog -Tail 15 -ErrorAction SilentlyContinue) } else { @() }
# The window list must come from while the app was alive: enumerating after Stop-Process finds
# nothing and makes "it never opened" look like "there were no windows at all".
if (-not $seenWindows) { $seenWindows = @(Get-AllWindowsFor -pids (Get-ProcessTree -rootPid $proc.Id) | ForEach-Object { "pid=$($_.Pid) $(Describe-Window $_.Handle)" }) }
$allWindowLines = @($seenWindows)

if ($LogDirectory) {
  $errText | Out-File -FilePath (Join-Path $LogDirectory 'belrog-startup-stderr.log') -Encoding utf8
  $outText | Out-File -FilePath (Join-Path $LogDirectory 'belrog-startup-stdout.log') -Encoding utf8
}

$report = New-Object System.Collections.ArrayList
if (-not $opened -or $fatal.Count -gt 0) {
  [void]$report.Add('STARTUP FAILED')
  [void]$report.Add(("process: pid={0} exited={1} exitCode={2}" -f $proc.Id, [bool]$proc.HasExited, $exitCode))
  [void]$report.Add(("windows belonging to the tree: {0}" -f $allWindowLines.Count))
  foreach ($line in $allWindowLines) { [void]$report.Add("  $line") }
  if ($fatal.Count) { [void]$report.Add('fatal stderr markers: ' + ($fatal -join ', ')) }
  [void]$report.Add('--- stderr (last 25 lines) ---')
  foreach ($line in @($errText -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -Last 25) { [void]$report.Add("  $line") }
  if ($logTail.Count) {
    [void]$report.Add('--- app.log tail ---')
    foreach ($line in $logTail) { [void]$report.Add("  $line") }
  }
} else {
  [void]$report.Add('STARTUP OK')
  [void]$report.Add("  $openDetail")
}
foreach ($line in $report) { Write-Output $line }
if ($LogDirectory) {
  # Always written, so a run scheduled in another session can be read back without shell
  # redirection - a scheduled task action cannot redirect the way a shell can.
  $report | Out-File -FilePath (Join-Path $LogDirectory 'report.txt') -Encoding utf8
}

if (-not $LeaveRunning) { Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue }
if ($fatal.Count -gt 0 -or -not $opened) { exit 1 }
exit 0
