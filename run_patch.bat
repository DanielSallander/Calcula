@echo off
echo ==========================================
echo      AI Code Patcher (Rust/TS/Py)
echo ==========================================

if not exist "apply_ai_updates.py" (
    echo [ERROR] apply_ai_updates.py not found in current directory.
    pause
    exit /b
)

if not exist "ai_changes.txt" (
    echo [ERROR] ai_changes.txt not found. Please paste AI output there.
    pause
    exit /b
)

python apply_ai_updates.py
echo.
echo Done.
pause