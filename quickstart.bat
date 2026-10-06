@echo off
setlocal
cd /d "%~dp0"

echo Starting the Systema teaching suite with LAN access...
echo Windows Firewall may ask for permission. Allow access on private networks only.
echo.

set "CODEX_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%CODEX_PYTHON%" goto run_codex_python

where python >nul 2>nul
if not errorlevel 1 (
    python -c "import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)" >nul 2>nul
    if not errorlevel 1 goto run_python
)

where py >nul 2>nul
if not errorlevel 1 (
    py -3 -c "import sys" >nul 2>nul
    if not errorlevel 1 goto run_py
)

echo Python 3 was not found.
echo Install Python from https://www.python.org/downloads/ and try again.
pause
exit /b 1

:run_codex_python
"%CODEX_PYTHON%" teaching_suite\server.py --lan
goto server_stopped

:run_python
python teaching_suite\server.py --lan
goto server_stopped

:run_py
py -3 teaching_suite\server.py --lan

:server_stopped
if errorlevel 1 (
    echo.
    echo The server stopped because of an error.
    pause
)
