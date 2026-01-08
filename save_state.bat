@echo off
REM -- Check if Git is installed --
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Git is not installed or not in your PATH.
    echo Please install Git for Windows to use this script.
    pause
    exit /b
)

REM -- Initialize Git if it doesn't exist --
if not exist ".git" (
    echo [INFO] No git repository found. Initializing...
    git init
    echo [OK] Repository initialized locally.
)

REM -- Add all current files to the snapshot --
echo [INFO] Adding files to snapshot...
git add .

REM -- Create a commit with a timestamp --
REM Get a formatted timestamp for the commit message
set "currDate=%date%"
set "currTime=%time%"
set "snapshotMsg=Manual Snapshot: %currDate% at %currTime%"

echo [INFO] Saving state: %snapshotMsg%
git commit -m "%snapshotMsg%"

echo.
echo ---------------------------------------------------
echo [OK] State Saved!
echo You can view previous states in VS Code Source Control tab.
echo ---------------------------------------------------
timeout /t 5