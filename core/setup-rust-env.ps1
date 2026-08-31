# Setup Rust build environment for Windows MSVC.
#
# Usage:
#   & .\core\setup-rust-env.ps1              # arm64 (this machine's native host)
#   & .\core\setup-rust-env.ps1 -Target x64  # cross-compile to x86_64 (distribution)
#
# Why this exists: Git ships its own link.exe which shadows MSVC's on PATH, so
# cargo builds fail from an ordinary terminal. This puts the right MSVC linker
# first and points LIB/INCLUDE at the matching architecture.

param(
    [ValidateSet('arm64', 'x64')]
    [string]$Target = 'arm64'
)

$SdkLib   = "C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0"
$SdkInc   = "C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0"
$MsvcRoot = "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.44.35207"

# 1. Configure LIB paths (libraries for the linker) - architecture specific.
# 2. Add the MSVC tools for this TARGET to PATH (for link.exe).
#    Host<host>\<target>: arm64 keeps the historical Hostx64 (x64-hosted, runs
#    under emulation); x64 uses the native HostArm64 cross tools.
if ($Target -eq 'x64') {
    $env:LIB = "$SdkLib\um\x64;$SdkLib\ucrt\x64;$MsvcRoot\lib\x64"
    $env:PATH = "$MsvcRoot\bin\HostArm64\x64;$env:PATH"
} else {
    $env:LIB = "$SdkLib\um\arm64;$SdkLib\ucrt\arm64;$MsvcRoot\lib\arm64"
    $env:PATH = "$MsvcRoot\bin\Hostx64\arm64;$env:PATH"
}

# 3. Configure INCLUDE paths (headers are architecture independent).
$env:INCLUDE = "$SdkInc\um;$SdkInc\ucrt;$SdkInc\shared;$MsvcRoot\include"

# 4. Clear CC/AR/CFLAGS to let the cc crate use MSVC directly.
#    rquickjs-sys sets MSVC-style CFLAGS (/std:c11) which are incompatible with clang.
Remove-Item Env:\CC -ErrorAction SilentlyContinue
Remove-Item Env:\AR -ErrorAction SilentlyContinue
Remove-Item Env:\CFLAGS -ErrorAction SilentlyContinue

# 5. Build OUTSIDE the repository.
#
# Two separate reasons, either one sufficient:
#   * Dropbox syncs the repo, and it locks files under `target/` mid-build
#     (os error 32).
#   * The in-repo tree is corrupt and fails to link `app_lib.dll` with
#     `LNK2019 anon.*.llvm.*` unresolved externals — compiler-generated
#     anonymous constants, i.e. object files from different compilations mixed
#     together. No source change causes or fixes that.
#
# This script used to configure LIB/INCLUDE/PATH and then announce "environment
# configured", which was not true: the one variable CLAUDE.md calls mandatory
# was still unset, so `yarn tauri dev` from a freshly-prepared shell built into
# the corrupt tree and failed at the linker. Setting it here means preparing the
# environment actually prepares the environment.
#
# An explicit CARGO_TARGET_DIR already in the environment wins — someone who
# chose their own location meant it.
if (-not $env:CARGO_TARGET_DIR) {
    $env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA 'calcula-target'
}

Write-Host "Rust $Target build environment configured (LIB + INCLUDE + MSVC)!" -ForegroundColor Green
# Printed, not silent: which binary a build or an E2E run exercises is a
# function of this value, so it should never have to be guessed at.
Write-Host "CARGO_TARGET_DIR = $env:CARGO_TARGET_DIR" -ForegroundColor DarkGray
