@echo off
set LIB=C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\arm64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\arm64;C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.44.35207\lib\arm64
set INCLUDE=C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\um;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\shared;C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.44.35207\include
rem Location-independent: %~dp0 is this script's own directory.
cd /d "%~dp0"
"cargo" %* 2>&1
