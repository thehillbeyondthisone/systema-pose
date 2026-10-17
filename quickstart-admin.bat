@echo off
setlocal
cd /d "%~dp0"
set "SYSTEMA_ADMIN_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%SYSTEMA_ADMIN_PYTHON%" (
  "%SYSTEMA_ADMIN_PYTHON%" teaching_suite\server.py --host 127.0.0.1 --port 8771 --admin
) else (
  where py >nul 2>nul
  if not errorlevel 1 (py -3 teaching_suite\server.py --host 127.0.0.1 --port 8771 --admin) else (python teaching_suite\server.py --host 127.0.0.1 --port 8771 --admin)
)
if errorlevel 1 pause
