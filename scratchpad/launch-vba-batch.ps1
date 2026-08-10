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
# It does four things global-setup.ts does, because in manual mode nothing else will:
#   1. kills a stale app / anything squatting the Vite port,
#   2. puts MSVC's link.exe ahead of Git's on PATH (Git's shadows it and the
#      Rust link step fails),
#   3. points CARGO_TARGET_DIR outside the Dropbox tree (Dropbox locks target/
#      mid-build -> os error 32),
#   4. sets WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS so the WebView opens a CDP port.

param(
    [int]$Port = 9222,
    [int]$VitePort = 5173
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repoRoot "app"

Write-Host ""
Write-Host "  Calcula E2E batch launcher - CDP $Port" -ForegroundColor Cyan

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
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"

Set-Location $appDir
Write-Host "  yarn tauri dev --config src-tauri/tauri.e2e.conf.json" -ForegroundColor DarkGray
Write-Host ""
yarn tauri dev --config src-tauri/tauri.e2e.conf.json
