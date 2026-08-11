param([string]$CargoArgs)
$ErrorActionPreference = "Stop"
$msvcRoot = "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.44.35207"
$kitsLib  = "C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0"
$kitsInc  = "C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0"
$env:PATH = "$msvcRoot\bin\Hostx64\arm64;$env:PATH"
$env:LIB  = "$kitsLib\um\arm64;$kitsLib\ucrt\arm64;$msvcRoot\lib\arm64"
$env:INCLUDE = "$kitsInc\um;$kitsInc\ucrt;$kitsInc\shared;$msvcRoot\include"
Remove-Item Env:CC, Env:AR, Env:CFLAGS -ErrorAction SilentlyContinue
$env:CARGO_TARGET_DIR = "C:\Users\Salle\AppData\Local\calcula-target"
Set-Location "C:\Dropbox\Projekt\Calcula\app\src-tauri"
Invoke-Expression "cargo $CargoArgs"
exit $LASTEXITCODE
