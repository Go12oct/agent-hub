$ErrorActionPreference = "Stop"
$installDir = Join-Path $env:LOCALAPPDATA "agent-hub"
$shim = Join-Path $installDir "agent-hub.cmd"
$trayScript = Join-Path $installDir "tray.ps1"
$configDirectory = if ($env:AGENT_HUB_CONFIG_DIR) {
  $env:AGENT_HUB_CONFIG_DIR
} elseif ($env:APPDATA) {
  Join-Path $env:APPDATA "agent-hub"
} else {
  Join-Path $env:USERPROFILE "AppData\Roaming\agent-hub"
}
$configPath = Join-Path $configDirectory "config.json"

if (Test-Path $shim) {
  & $shim uninstall-claude-hooks
  & $shim uninstall-codex-hooks
}

try {
  Get-ScheduledTask -TaskName AgentHub -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
} catch {
  Write-Warning "Could not remove the AgentHub Scheduled Task: $($_.Exception.Message)"
}
$startupLauncher = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\AgentHub.vbs"
if (Test-Path $startupLauncher) {
  Remove-Item -LiteralPath $startupLauncher -Force
}
try {
  Get-NetFirewallRule -DisplayName 'Agent Hub' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
} catch {
  Write-Warning "Could not remove the Windows Firewall rule; ask an administrator to remove it: $($_.Exception.Message)"
}

try {
  $config = Get-Content -Raw -Path $configPath | ConvertFrom-Json
  $port = if ($env:AGENT_HUB_PORT -match '^\d+$') { [int]$env:AGENT_HUB_PORT } else { [int]$config.port }
  if ($port -ge 1 -and $port -le 65535 -and $config.token) {
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/api/shutdown")
    $request.Method = "POST"
    $request.Headers.Add("Authorization", "Bearer $($config.token)")
    $request.ContentLength = 0
    $request.Timeout = 2000
    $response = $request.GetResponse()
    $response.Close()
  }
} catch {
  if ($_.Exception.Response) { $_.Exception.Response.Close() }
}

if (Test-Path $trayScript) {
  & powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File $trayScript -Quit
  Start-Sleep -Seconds 2
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath) {
  $remainingPath = ($userPath -split ';' | Where-Object {
    $_.TrimEnd('\') -ine $installDir.TrimEnd('\')
  }) -join ';'
  [Environment]::SetEnvironmentVariable("Path", $remainingPath, "User")
}

if (Test-Path $installDir) {
  Remove-Item -Path $installDir -Recurse -Force
}
Write-Host "Agent Hub has been removed. Configuration and agent transcripts were left untouched."
