# Setup Rust build environment for ARM64 Windows

# 1. Configure LIB paths (Libraries for the Linker)
$env:LIB = "C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\arm64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\arm64;C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.44.35207\lib\arm64"

# 2. Configure INCLUDE paths (Headers for the Compiler)
# These correspond to the LIB paths above but point to the 'Include' directories.
$env:INCLUDE = "C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\um;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\shared;C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.44.35207\include"

# 3. Add MSVC tools to PATH (for link.exe)
$env:PATH = "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\arm64;$env:PATH"

# 4. Clear CC/AR/CFLAGS to let the cc crate use MSVC directly.
#    rquickjs-sys sets MSVC-style CFLAGS (/std:c11) which are incompatible with clang.
Remove-Item Env:\CC -ErrorAction SilentlyContinue
Remove-Item Env:\AR -ErrorAction SilentlyContinue
Remove-Item Env:\CFLAGS -ErrorAction SilentlyContinue

Write-Host "Rust ARM64 build environment configured (LIB + INCLUDE + MSVC)!" -ForegroundColor Green