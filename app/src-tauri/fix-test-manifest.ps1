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
# USAGE:  cargo test --no-run ; ./fix-test-manifest.ps1 ; cargo test
#         (idempotent - exes that already have a resource section are skipped;
#          pass -TargetDir to point at a non-default CARGO_TARGET_DIR)

param(
    [string]$TargetDir = (Join-Path $PSScriptRoot "target")
)

$ErrorActionPreference = "Stop"

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
