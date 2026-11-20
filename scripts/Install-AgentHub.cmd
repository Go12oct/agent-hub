@echo off
setlocal
if exist "%~dp0install.ps1" goto install
set "AGENT_HUB_ZIP_LAUNCHER=%~dp0"
set "AGENT_HUB_INSTALL_ARGS=%*"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; try { $match = [regex]::Match($env:AGENT_HUB_ZIP_LAUNCHER, '(?i)[0-9a-f-]{36}_(?<zip>[^\\]+\.zip)\.[^\\]+'); if (-not $match.Success) { exit 1 }; foreach ($folder in @((Join-Path $env:USERPROFILE 'Downloads'), [Environment]::GetFolderPath('Desktop'))) { $zip = Join-Path $folder $match.Groups['zip'].Value; if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) { continue }; $destination = Join-Path $folder (([IO.Path]::GetFileNameWithoutExtension($zip)) + '-extracted-' + [guid]::NewGuid()); Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Archive\Microsoft.PowerShell.Archive.psd1') -Force; Expand-Archive -LiteralPath $zip -DestinationPath $destination; Get-ChildItem -LiteralPath $destination -Recurse -File -Force | Unblock-File; $launcher = Join-Path $destination 'agent-hub\Install-AgentHub.cmd'; if (-not (Test-Path -LiteralPath $launcher)) { exit 1 }; $quote = [char]34; $process = Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /s /c ' + $quote + $quote + $launcher + $quote + ' ' + $env:AGENT_HUB_INSTALL_ARGS + $quote) -NoNewWindow -PassThru; $null = $process.Handle; $process.WaitForExit(); exit $process.ExitCode }; exit 1 } catch { Write-Host $_.Exception.Message; exit 1 }"
if "%ERRORLEVEL%"=="0" exit /b 0
echo Right-click agent-hub-windows.zip ^> Extract All, open the extracted folder, then double-click Install-AgentHub.cmd
pause
exit /b 1
:install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "result=%ERRORLEVEL%"
echo.
if "%result%"=="0" (
  echo Agent Hub installation finished.
) else (
  echo Agent Hub installation failed with exit code %result%.
  echo Review the error and log location above before closing this window.
)
pause
exit /b %result%
