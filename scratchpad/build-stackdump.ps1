# Build the out-of-process stack dumper with MSVC's link.exe ahead of Git's.
$here = $PSScriptRoot
$msvcRoot = "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.44.35207"
$kitsLib = "C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0"
$kitsInc = "C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0"
$env:PATH = "$msvcRoot\bin\Hostx64\arm64;$env:PATH"
$env:LIB = "$kitsLib\um\arm64;$kitsLib\ucrt\arm64;$msvcRoot\lib\arm64"
$env:INCLUDE = "$kitsInc\um;$kitsInc\ucrt;$kitsInc\shared;$msvcRoot\include"
Set-Location $here
rustc -O stackdump.rs -o stackdump.exe
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "[OK] stackdump.exe built"
