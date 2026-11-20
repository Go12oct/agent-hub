$ErrorActionPreference = 'Stop'
$packageRoot = Join-Path $env:RUNNER_TEMP 'agent-hub'
if (Test-Path $packageRoot) { Remove-Item $packageRoot -Recurse -Force }
$dist = Join-Path $packageRoot 'daemon\dist'
$public = Join-Path $packageRoot 'daemon\public'
New-Item -ItemType Directory -Force -Path $dist, $public | Out-Null
Copy-Item 'daemon/dist/agent-hub.cjs' $dist -Force
Copy-Item 'daemon/dist/hook-bridge.cjs' $dist -Force
Copy-Item 'daemon/public/*' $public -Recurse -Force
if (Test-Path 'daemon/dist/agent-hub.exe') {
  Copy-Item 'daemon/dist/agent-hub.exe' $dist -Force
}
foreach ($file in @('install.ps1', 'uninstall.ps1', 'tray.ps1', 'Install-AgentHub.cmd', 'Uninstall-AgentHub.cmd')) {
  Copy-Item "scripts/$file" $packageRoot -Force
}
$zipPath = Join-Path $env:GITHUB_WORKSPACE 'agent-hub-windows.zip'
Compress-Archive -Path $packageRoot -DestinationPath $zipPath -Force
