@echo off
echo Starting AI Patch Application...
echo ---------------------------------------------------

:: Check if python is installed/accessible
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not found. Please install Python or add it to your PATH.
    pause
    exit /b
)

:: Check if the python script exists
if not exist "apply_multipatch.py" (
    echo [ERROR] apply_multipatch.py not found in this folder.
    pause
    exit /b
)

:: Run the script
python apply_multipatch.py changes.patch

echo.
echo ---------------------------------------------------
echo Process Finished.
pause