@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "result=%ERRORLEVEL%"
echo.
if "%result%"=="0" (
  echo Agent Hub installation finished.
) else (
  echo Agent Hub installation failed with exit code %result%.
)
pause
exit /b %result%
