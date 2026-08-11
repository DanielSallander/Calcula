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
    [int]$VitePort = 5173
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repoRoot "app"

Write-Host ""
Write-Host "  Calcula E2E batch launcher - CDP $Port" -ForegroundColor Cyan

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

# --- 1. kill stale instances -------------------------------------------------
foreach ($name in @("app", "calcula")) {
    Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  killing stale $name (pid $($_.Id))" -ForegroundColor DarkGray
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
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
# `--force-color-profile=sRGB` is NOT cosmetic and NOT optional.
#
# Every screenshot golden in the tree was captured through the DISPLAY's colour
# profile. Measured 2026-08-11: the status bar is a hard-coded `#217346` in
# `StatusBar.tsx`, every committed golden holds `rgb(63,112,75)`, and a capture
# taken the same day holds `rgb(33,115,70)` -- which is `#217346` exactly. So the
# goldens encode a transform that belongs to the monitor, not to the product,
# and the day it changes EVERY screenshot test in both suites fails at once with
# a uniform per-channel delta. That is what happened: 34 functional + 18 visual,
# all of them, hours after the same suites had been green on the same machine.
#
# Forcing the colour profile makes a capture a function of the PAGE and nothing
# else, so a golden means the same thing tomorrow, on another display, and after
# Windows changes a colour setting.
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --force-color-profile=sRGB"

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
node e2e/launch-app.mjs
