param(
  [switch]$SkipPair
)

$ErrorActionPreference = "Stop"
$installDir = Join-Path $env:LOCALAPPDATA "agent-hub"
$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundle = Join-Path $sourceDir "..\daemon\dist\agent-hub.cjs"
$standalone = Join-Path $sourceDir "..\daemon\dist\agent-hub.exe"
$hookBridgeSource = Join-Path $sourceDir "..\daemon\dist\hook-bridge.cjs"
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
if (-not (Test-Path $hookBridgeSource)) {
  Write-Error "The Codex hook bridge was not found at $hookBridgeSource."
}
Copy-Item $hookBridgeSource (Join-Path $installDir "hook-bridge.cjs") -Force
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
& $shim firewall
if ($LASTEXITCODE -ne 0) {
  Write-Warning "The Agent Hub Firewall rule was not added. Run 'agent-hub firewall' as administrator."
}
& $shim install-claude-hooks
& $shim install-codex-hooks
if (-not $SkipPair) {
  & $shim pair
}
Write-Host "Agent Hub installed to $installDir. Without admin rights, a denied Scheduled Task registration uses the per-user Startup folder."
