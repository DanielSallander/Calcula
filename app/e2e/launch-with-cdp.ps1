# Launch Calcula with WebView2 remote debugging, for a MANUAL E2E batch.
#
#   .\e2e\launch-with-cdp.ps1             # default port 9222
#   .\e2e\launch-with-cdp.ps1 -Port 9333  # custom port
#
# Then, in ANOTHER terminal:
#   npm run e2e:manual -- <spec> [--update-snapshots]
#
# ----------------------------------------------------------------------------
# WHY THIS SCRIPT NO LONGER BUILDS ITS OWN WEBVIEW2 ARGUMENT STRING
# ----------------------------------------------------------------------------
# It used to, and it was WRONG in the way that is hardest to notice:
#
#     this script   --remote-debugging-port=N
#     the others    --remote-debugging-port=N --force-color-profile=sRGB
#                                             --disable-accelerated-2d-canvas
#
# `e2e/webview2Args.mjs` exists *because* this drift already "cost the whole
# golden corpus its meaning twice over" — and it names only two launch paths,
# because nobody knew this third one was carrying its own stale copy. Anything
# recorded through it captured through the DISPLAY's colour profile (a
# hard-coded #217346 lands as rgb(63,112,75) instead of rgb(33,115,70)) and with
# an ACCELERATED 2D canvas, which decides whether DOM overlay text rasterizes
# LCD or grayscale — ~2,900 differing pixels against a 200-pixel budget, with
# nothing about the product changed.
#
# So the flags come from ONE definition now: this script sets the port and hands
# off to `e2e/launch-app.mjs`, which imports `webview2Args.mjs` and PRINTS the
# arguments the WebView actually receives. Read that line before recording a
# golden.
#
# ----------------------------------------------------------------------------
# AND WHY IT NOW SETS THE BUILD ENVIRONMENT
# ----------------------------------------------------------------------------
# Nothing here used to. There is no `.cargo/config.toml`, so `CARGO_TARGET_DIR`
# was whatever the invoking shell happened to export — meaning WHICH BINARY a
# manual run exercised was a function of ambient shell state, and two terminals
# built and ran two different apps. Worse, Git's `link.exe` shadows MSVC's on a
# normal PATH, so a launch from a plain prompt fails to link with a message
# about a "missing operand" that has nothing to do with the code.
#
# Both are fixed here by REUSING the repo's own definitions rather than adding a
# fourth copy: `core/setup-rust-env.ps1` for MSVC, and an out-of-repo default for
# the target directory (Dropbox locks the in-repo `target/` mid-build — os error
# 32). An existing `CARGO_TARGET_DIR` is respected, never overwritten.

param(
    [int]$Port = 9222
)

$ErrorActionPreference = "Stop"

$appDir   = Split-Path $PSScriptRoot -Parent
$repoRoot = Split-Path $appDir -Parent

# MSVC ahead of Git on PATH, plus LIB/INCLUDE. Dot-sourced so it edits THIS
# session's environment; the script prints its own confirmation line.
$rustEnv = Join-Path $repoRoot "core\setup-rust-env.ps1"
if (Test-Path $rustEnv) {
    . $rustEnv | Out-Null
} else {
    Write-Warning "core\setup-rust-env.ps1 not found - if the build fails to link, Git's link.exe is probably shadowing MSVC's."
}

# Out of the repo, because Dropbox locks files under it mid-build.
if (-not $env:CARGO_TARGET_DIR) {
    $env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA "calcula-target"
}

$env:CDP_PORT = "$Port"

Write-Host ""
Write-Host "  Calcula E2E - launching with CDP on port $Port" -ForegroundColor Cyan
Write-Host "  CARGO_TARGET_DIR: $env:CARGO_TARGET_DIR" -ForegroundColor DarkGray
Write-Host "  Connect Playwright:  npm run e2e:manual -- <spec>" -ForegroundColor DarkGray
Write-Host "  Connect DevTools:    http://127.0.0.1:$Port" -ForegroundColor DarkGray
Write-Host ""

Set-Location $appDir
node e2e/launch-app.mjs
