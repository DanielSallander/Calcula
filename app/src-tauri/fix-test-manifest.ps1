# FILENAME: app/src-tauri/fix-test-manifest.ps1
# PURPOSE: Make `cargo test` binaries loadable on Windows.
#
# Cargo TEST executables don't get tauri-build's embedded Windows manifest
# (it targets the app bin only). A manifest-less exe binds comctl32 v5 - and
# the app's link graph imports v6-only exports (TaskDialogIndirect, via the
# tauri dialog/menu stack), so the test exe fails to LOAD with
# STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) before running a single test.
#
# Linker-side fixes don't fit: `cargo:rustc-link-arg-tests` skips lib
# unittests, and a global `/MANIFEST:EMBED` needs rc.exe on PATH and collides
# with tauri-build's own manifest on the app bin. So: embed the
# common-controls v6 dependency into the already-linked test exes with mt.exe.
#
# USAGE:  cargo test --no-run --message-format=json > build.json
#         ./fix-test-manifest.ps1 -TargetDir <dir>
#         <run each executable from build.json DIRECTLY>
#
#         (idempotent - exes that already have a resource section are skipped;
#          pass -TargetDir to point at a non-default CARGO_TARGET_DIR)
#
# THE ORDER IS LOAD-BEARING, AND THE OBVIOUS RECIPE IS WRONG once the crate has
# more than one test target. The manifest is embedded into an ALREADY-LINKED
# exe, so ANY subsequent link throws it away:
#
#   cargo test --lib --no-run              builds + links app_lib
#   cargo test --test test_pivot --no-run  re-resolves features, RELINKS app_lib
#   ./fix-test-manifest.ps1                patches the exe
#   cargo test --lib                       re-resolves AGAIN, RELINKS -> patch GONE
#                                          -> 0xC0000139, zero tests run
#
# So: build EVERY target in ONE cargo invocation (one feature resolution), patch
# after that final link, then run the exes yourself - cargo cannot relink what
# it is not invoked for. Measured 2026-08-11; see docs/design/open-decisions-2026-08.md
# section 3cb.4.
#
# TWO TRAPS while doing that. `--message-format=json` lists the APPLICATION
# binary among its `executable` entries; running that launches the real app and
# blocks. And this script reports through Write-Host, so `2>&1 | Out-File`
# captures nothing - use `*>&1`.

# DEFAULTS TO $env:CARGO_TARGET_DIR, which `core/setup-rust-env.ps1` sets to a
# path OUTSIDE the repo (Dropbox locks the in-repo `target/` mid-build). This
# used to default to the in-repo `target/` unconditionally, so with the env var
# set it scanned an empty directory, found nothing to do, and printed
# "Done. 0 exe(s) patched." — a SUCCESS line for a complete no-op, after which
# every app-crate test still died with 0xC0000139.
param(
    [string]$TargetDir = $(
        if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR }
        else { Join-Path $PSScriptRoot "target" }
    )
)

$ErrorActionPreference = "Stop"

$deps0 = Join-Path $TargetDir "debug\deps"
if (-not (Test-Path $deps0)) {
    Write-Error ("no such directory: " + $deps0 +
        " - pass -TargetDir, or source core/setup-rust-env.ps1 so CARGO_TARGET_DIR is set.")
}

# Locate mt.exe in the Windows SDK (prefer the host architecture's bin).
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$kits = "C:\Program Files (x86)\Windows Kits\10\bin"
$mt = Get-ChildItem -Path $kits -Recurse -Filter mt.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.DirectoryName -like ("*\" + $arch) } |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $mt) {
    Write-Error ("mt.exe not found under " + $kits + " - install the Windows SDK.")
}

$manifest = Join-Path $env:TEMP "calcula-test-manifest.xml"
$xml = @(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">',
    '  <dependency>',
    '    <dependentAssembly>',
    '      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls"',
    '        version="6.0.0.0" processorArchitecture="*"',
    '        publicKeyToken="6595b64144ccf1df" language="*" />',
    '    </dependentAssembly>',
    '  </dependency>',
    '</assembly>'
)
Set-Content -Path $manifest -Value ($xml -join "`r`n") -Encoding UTF8

$deps = Join-Path $TargetDir "debug\deps"
$probe = Join-Path $env:TEMP "calcula-manifest-probe.xml"
$patched = 0
foreach ($exe in Get-ChildItem -Path $deps -Filter "*.exe" -ErrorAction SilentlyContinue) {
    # Skip exes that already carry a resource-embedded manifest.
    & $mt.FullName -nologo -inputresource:($exe.FullName + ";#1") -out:$probe *>$null
    if ($LASTEXITCODE -eq 0) { continue }
    & $mt.FullName -nologo -manifest $manifest -outputresource:($exe.FullName + ";#1")
    if ($LASTEXITCODE -eq 0) {
        Write-Host ("[OK] embedded manifest: " + $exe.Name)
        $patched++
    } else {
        Write-Warning ("mt.exe failed on " + $exe.Name)
    }
}
Write-Host ("Done. " + $patched + " exe(s) patched.")
