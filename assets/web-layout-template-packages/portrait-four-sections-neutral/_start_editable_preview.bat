@echo off
setlocal
set "PREVIEW_SCRIPT=%~dp0preview-server.py"

where pythonw >nul 2>&1
if not errorlevel 1 (
  start "" /b pythonw "%PREVIEW_SCRIPT%" %*
  exit /b 0
)

where python >nul 2>&1
if not errorlevel 1 (
  start "Editable Media Preview" /min python "%PREVIEW_SCRIPT%" %*
  exit /b 0
)

echo Python was not found. Install Python or add it to PATH, then run this file again.
pause
exit /b 1
