param(
  [switch]$SkipPair
)

$ErrorActionPreference = "Stop"
$installDir = Join-Path $env:LOCALAPPDATA "agent-hub"
$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundle = Join-Path $sourceDir "..\daemon\dist\agent-hub.cjs"
$standalone = Join-Path $sourceDir "..\daemon\dist\agent-hub.exe"
$webDir = Join-Path $sourceDir "..\daemon\public"
if (Test-Path $standalone) {
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Copy-Item $standalone (Join-Path $installDir "agent-hub.exe") -Force
  $shim = Join-Path $installDir "agent-hub.cmd"
  Set-Content -Path $shim -Value "@echo off`r`n`"$installDir\agent-hub.exe`" %*"
} else {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Error "Node.js 22 or newer is required. Install the current Node.js LTS and rerun this script."
  }
  $major = [int]((node --version) -replace '^v(\d+).*', '$1')
  if ($major -lt 22) {
    Write-Error "Node.js 22 or newer is required; found $(node --version)."
  }
  if (-not (Test-Path $bundle)) {
    Write-Error "The Agent Hub daemon bundle was not found at $bundle."
  }
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Copy-Item $bundle (Join-Path $installDir "agent-hub.cjs") -Force
  $shim = Join-Path $installDir "agent-hub.cmd"
  Set-Content -Path $shim -Value "@echo off`r`nnode `"$installDir\agent-hub.cjs`" %*"
}
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ';') -notcontains $installDir) {
  $updatedPath = if ($userPath) { "$userPath;$installDir" } else { $installDir }
  [Environment]::SetEnvironmentVariable("Path", $updatedPath, "User")
}
if (Test-Path $webDir) {
  $publicDir = Join-Path $installDir "public"
  New-Item -ItemType Directory -Force -Path $publicDir | Out-Null
  Copy-Item (Join-Path $webDir "*") $publicDir -Recurse -Force
}
$env:PATH = "$installDir;$env:PATH"
& $shim install-service
$firewallRule = Get-NetFirewallRule -DisplayName "Agent Hub" -Direction Inbound -Action Allow -ErrorAction SilentlyContinue
if (-not $firewallRule) {
  $firewallCommand = "try { New-NetFirewallRule -DisplayName 'Agent Hub' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4747 -Profile Any -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }"
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($firewallCommand))
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object -TypeName Security.Principal.WindowsPrincipal -ArgumentList $identity
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    try {
      New-NetFirewallRule -DisplayName "Agent Hub" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4747 -Profile Any -ErrorAction Stop | Out-Null
      Write-Host "Added the Agent Hub Windows Firewall rule for TCP port 4747."
    } catch {
      Write-Warning "Could not add the Agent Hub Windows Firewall rule. Run 'agent-hub firewall' as administrator."
    }
  } else {
    try {
      $elevated = Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -PassThru -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encodedCommand)
      if ($elevated.ExitCode -eq 0) {
        Write-Host "Added the Agent Hub Windows Firewall rule for TCP port 4747."
      } else {
        Write-Warning "The Agent Hub Windows Firewall rule was not added. Run 'agent-hub firewall' as administrator."
      }
    } catch {
      Write-Warning "The firewall UAC prompt was declined; the Agent Hub Windows Firewall rule was not added. Run 'agent-hub firewall' later."
    }
  }
}
& $shim install-claude-hooks
if (-not $SkipPair) {
  & $shim pair
}
Write-Host "Agent Hub installed to $installDir. Without admin rights, a denied Scheduled Task registration uses the per-user Startup folder."
