@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -Command "try { $probe=Invoke-RestMethod -Uri 'http://127.0.0.1:8771/api/admin/state' -TimeoutSec 2; if ($probe.token -and $null -ne $probe.lessons) { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  start "" "http://127.0.0.1:8771/admin"
  exit /b 0
)
set "SYSTEMA_ADMIN_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%SYSTEMA_ADMIN_PYTHON%" (
  "%SYSTEMA_ADMIN_PYTHON%" teaching_suite\server.py --host 127.0.0.1 --port 8771 --admin
) else (
  where py >nul 2>nul
  if not errorlevel 1 (py -3 teaching_suite\server.py --host 127.0.0.1 --port 8771 --admin) else (python teaching_suite\server.py --host 127.0.0.1 --port 8771 --admin)
)
if errorlevel 1 pause
