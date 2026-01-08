# Setup Rust build environment for ARM64 Windows

# 1. Configure LIB paths (Libraries for the Linker)
$env:LIB = "C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\arm64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\arm64;C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.44.35207\lib\arm64"

# 2. Configure INCLUDE paths (Headers for the Compiler)
# These correspond to the LIB paths above but point to the 'Include' directories.
$env:INCLUDE = "C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\um;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\shared;C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.44.35207\include"

# 3. Configure LLVM/Clang (Required for the 'ring' crate)
$env:PATH = "$env:PATH;C:\Program Files\LLVM\bin"
$env:CC = "clang"
$env:AR = "llvm-ar"

Write-Host "Rust ARM64 build environment configured (LIB + INCLUDE + Clang)!" -ForegroundColor Green