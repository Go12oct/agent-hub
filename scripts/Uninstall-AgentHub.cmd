@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
set "result=%ERRORLEVEL%"
echo.
if "%result%"=="0" (
  echo Agent Hub uninstallation finished.
) else (
  echo Agent Hub uninstallation failed with exit code %result%.
)
pause
exit /b %result%
