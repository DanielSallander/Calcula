# Launch Calcula COLD for an E2E batch, with WebView2 remote debugging on CDP 9222
# and the e2e Tauri overlay config (which re-enables `withGlobalTauri`, without
# which every spec that drives the app through `window.__TAURI__` fails).
#
# This is the script the correctness-program briefs name. It had gone missing from
# the tree, which blocked two passes from running anything live; it is checked in
# here so the next pass does not have to reconstruct it.
#
#   Usage:  powershell -ExecutionPolicy Bypass -File scratchpad/launch-vba-batch.ps1
#   Then:   cd app; $env:E2E_MANUAL=1; npx playwright test --project=functional
#
# It does five things global-setup.ts does, because in manual mode nothing else will:
#   1. kills a stale app / anything squatting the Vite port,
#   2. puts MSVC's link.exe ahead of Git's on PATH (Git's shadows it and the
#      Rust link step fails),
#   3. points CARGO_TARGET_DIR outside the Dropbox tree (Dropbox locks target/
#      mid-build -> os error 32),
#   4. sets WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS so the WebView opens a CDP port,
#   5. TEES the app's own stdout/stderr to app/e2e/results/app-dev.log, which is
#      where walker/failureBundle.ts looks for the backend's account of a
#      failure. Without it a walker failure bundle contains the browser console
#      and nothing else, so a failure caused on the Rust side leaves no trace at
#      all -- which is one of the things that made S13 undiagnosable.

param(
    [int]$Port = 9222,
    [int]$VitePort = 5173,
    # Take the machine even though something is already answering on $Port.
    # WITHOUT this the launcher REFUSES rather than stealing another run's app.
    [switch]$TakeOver
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repoRoot "app"
$lockPath = Join-Path $appDir "e2e\results\.e2e-launch-lock.json"

Write-Host ""
Write-Host "  Calcula E2E batch launcher - CDP $Port" -ForegroundColor Cyan

# --- 0a. DO NOT STEAL A RUNNING APP ------------------------------------------
# This script used to open with `Get-Process -Name app | Stop-Process -Force`:
# a kill BY NAME, of every Calcula on the machine, unconditionally. When two
# agents work on this repo at once -- which is how this program is actually run
# -- whoever launches second silently destroys the other's app mid-suite.
# MEASURED 2026-08-11: a full ordered `--project=functional` pass was killed at
# test 166 of ~550 (40 minutes in) by a second launcher; the remaining ~380
# tests then "failed" in 1 ms each because CDP was gone. `Stop-Process -Force`
# is `TerminateProcess(handle, -1)`, so the victim's log shows exit 0xffffffff
# and no panic -- which this register had already spent a pass diagnosing once
# (S3af). Hundreds of failures that look like product regressions and are not.
#
# The fix is to make the collision LOUD instead of silent. A launcher that finds
# CDP answering says whose it is and stops.
$existing = $null
try {
    $existing = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
} catch { $existing = $null }
if ($existing -and -not $TakeOver) {
    $holders = @(Get-Process -Name app -ErrorAction SilentlyContinue |
        ForEach-Object { "pid $($_.Id) started $($_.StartTime.ToString('HH:mm:ss'))" })
    Write-Host ""
    Write-Host "  REFUSING TO LAUNCH: something is already answering CDP on port $Port." -ForegroundColor Yellow
    if ($holders.Count -gt 0) { Write-Host "  app.exe: $($holders -join '; ')" -ForegroundColor Yellow }
    Write-Host "  Another agent or an earlier run owns this machine. Killing it would turn" -ForegroundColor Yellow
    Write-Host "  its suite into hundreds of 1ms failures that look like product regressions." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Wait for it, or run a SECOND instance on its own ports:" -ForegroundColor Gray
    Write-Host "    -Port 9223 -VitePort 5174   (vite's port must also be free)" -ForegroundColor Gray
    Write-Host "  Only if you are certain the holder is abandoned:  -TakeOver" -ForegroundColor Gray
    Write-Host ""
    exit 2
}
if ($existing -and $TakeOver) {
    Write-Host "  -TakeOver: an app is answering on $Port and will be replaced" -ForegroundColor Yellow
}

# --- 0. kill a PREVIOUS launcher ---------------------------------------------
# A launcher whose app has died keeps running (yarn is still up) and keeps its
# handle on the log file, so the next launch fails to truncate it -- after it
# has already killed the app, which leaves nothing running and nothing
# explaining why.
#
# ANCESTORS ARE EXCLUDED, and that is not a detail: when this script is started
# from a shell, the shell's OWN command line contains "launch-vba-batch", so a
# naive CommandLine match kills the process tree it is running inside. It did.
$allProcs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$byId = @{}
foreach ($p in $allProcs) { $byId[[int]$p.ProcessId] = $p }
$selfAndAncestors = New-Object System.Collections.Generic.HashSet[int]
$walk = $PID
while ($walk -and $byId.ContainsKey([int]$walk)) {
    if (-not $selfAndAncestors.Add([int]$walk)) { break }   # cycle guard
    $walk = [int]$byId[[int]$walk].ParentProcessId
}
foreach ($p in $allProcs) {
    if ($p.Name -ne "powershell.exe" -and $p.Name -ne "pwsh.exe") { continue }
    if ($selfAndAncestors.Contains([int]$p.ProcessId)) { continue }
    if ($p.CommandLine -notlike "*launch-vba-batch*") { continue }
    Write-Host "  killing previous launcher (pid $($p.ProcessId))" -ForegroundColor DarkGray
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

# --- 1. kill OUR OWN stale instance, by recorded PID -------------------------
# Scoped to the process this script started last time, recorded in the lock file
# below -- never `-Name app`, which is every Calcula on the machine including
# another agent's live suite (see 0a). A PID is also re-checked for identity
# before it is killed: PIDs are recycled, and killing a stranger that inherited
# the number is the same defect one level down.
if (Test-Path $lockPath) {
    try {
        $lock = Get-Content $lockPath -Raw | ConvertFrom-Json
        foreach ($stalePid in @($lock.appPid, $lock.launcherPid)) {
            if (-not $stalePid) { continue }
            $proc = Get-Process -Id ([int]$stalePid) -ErrorAction SilentlyContinue
            if (-not $proc) { continue }
            if ($proc.Name -notin @("app", "calcula", "node", "powershell", "pwsh")) { continue }
            if ($lock.startedAt -and $proc.StartTime -and
                ([datetime]$lock.startedAt - $proc.StartTime).Duration().TotalMinutes -gt 5) {
                Write-Host "  pid $stalePid is not ours any more (started $($proc.StartTime)) - leaving it" -ForegroundColor DarkGray
                continue
            }
            Write-Host "  killing our previous $($proc.Name) (pid $stalePid)" -ForegroundColor DarkGray
            Stop-Process -Id ([int]$stalePid) -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Host "  lock file unreadable - not killing anything by guess" -ForegroundColor DarkGray
    }
}
$squatters = @(netstat -ano | Select-String "LISTENING" | Select-String ":$VitePort\s" |
    ForEach-Object { ($_.ToString().Trim() -split '\s+')[-1] } | Sort-Object -Unique)
foreach ($squatPid in $squatters) {
    if ($squatPid -match '^\d+$') {
        Write-Host "  killing pid $squatPid on vite port $VitePort" -ForegroundColor DarkGray
        Stop-Process -Id ([int]$squatPid) -Force -ErrorAction SilentlyContinue
    }
}

# --- 2. MSVC toolchain ahead of Git's link.exe -------------------------------
$msvcRoot = "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.44.35207"
$kitsLib = "C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0"
$kitsInc = "C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0"
$env:PATH = "$msvcRoot\bin\Hostx64\arm64;$env:PATH"
$env:LIB = "$kitsLib\um\arm64;$kitsLib\ucrt\arm64;$msvcRoot\lib\arm64"
$env:INCLUDE = "$kitsInc\um;$kitsInc\ucrt;$kitsInc\shared;$msvcRoot\include"
Remove-Item Env:CC, Env:AR, Env:CFLAGS -ErrorAction SilentlyContinue

# --- 3. target dir outside Dropbox ------------------------------------------
$env:CARGO_TARGET_DIR = "C:\Users\Salle\AppData\Local\calcula-target"

# --- 4. CDP ------------------------------------------------------------------
# The WebView2 arguments are NOT set here any more. They live in ONE module,
# app/e2e/webview2Args.mjs, which launch-app.mjs (below) and global-setup.ts
# both import -- along with the measurements that say why each flag is
# load-bearing for every screenshot golden in the tree.
#
# Setting them here was worse than useless: launch-app.mjs built its own env and
# reassigned WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS to the CDP port alone, so the
# value this line so carefully explained was DISCARDED by the very script this
# line hands off to. Every manual run captured through the display's colour
# profile regardless. Only the port is passed on, and it goes through CDP_PORT.

# --- 5. spawn through the node tee ------------------------------------------
# The spawn AND the log tee both live in app/e2e/launch-app.mjs. PowerShell was
# doing the tee itself and it did not work: measured, the log ended up holding
# exactly two lines -- yarn's banner -- with nothing `tauri dev` printed ever
# reaching the pipeline, through `Tee-Object` and through `ForEach-Object`
# alike. (Tee-Object also writes UTF-16LE in Windows PowerShell 5.1, which is a
# separate defect for any UTF-8 reader.) Node's piped `spawn` is what
# `global-setup.ts` already uses to stream `[tauri] ...` lines, so it is the
# mechanism that is known to work on this machine.
#
# Everything above still matters and is inherited by the child: PATH with
# MSVC's link.exe first, CARGO_TARGET_DIR outside Dropbox, and the CDP port.
$env:CDP_PORT = "$Port"

Set-Location $appDir
Write-Host "  node e2e/launch-app.mjs  (yarn tauri dev --config src-tauri/tauri.e2e.conf.json)" -ForegroundColor DarkGray
Write-Host "  app log -> $(Join-Path $appDir 'e2e\results\app-dev.log')" -ForegroundColor DarkGray
Write-Host ""

# Record what WE started, so the next run of this script can clean up after
# itself by PID instead of by name. Written before the spawn (so a launcher that
# dies mid-start still leaves a trail) and updated with the app's PID once the
# window exists.
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lockPath) | Out-Null
@{ launcherPid = $PID; appPid = $null; cdpPort = $Port; vitePort = $VitePort;
   startedAt = (Get-Date).ToString("o") } | ConvertTo-Json | Set-Content -Path $lockPath -Encoding UTF8

$recorder = Start-Job -ScriptBlock {
    param($lockPath, $port)
    # The app process appears a few seconds after `tauri dev` starts building.
    for ($i = 0; $i -lt 300; $i++) {
        Start-Sleep -Seconds 1
        $app = Get-Process -Name app -ErrorAction SilentlyContinue |
            Sort-Object StartTime -Descending | Select-Object -First 1
        if ($app) {
            $lock = Get-Content $lockPath -Raw | ConvertFrom-Json
            $lock.appPid = $app.Id
            $lock | ConvertTo-Json | Set-Content -Path $lockPath -Encoding UTF8
            return
        }
    }
} -ArgumentList $lockPath, $Port

try {
    node e2e/launch-app.mjs
} finally {
    Stop-Job $recorder -ErrorAction SilentlyContinue | Out-Null
    Remove-Job $recorder -Force -ErrorAction SilentlyContinue | Out-Null
}
