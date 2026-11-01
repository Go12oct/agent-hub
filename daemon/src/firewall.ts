export function firewallRuleScript(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Firewall port must be an integer between 1 and 65535.');
  }

  return `$ErrorActionPreference = 'Stop'
$port = ${port}
$rules = @(Get-NetFirewallRule -DisplayName 'Agent Hub' -ErrorAction SilentlyContinue)
$matchingRule = $rules | Where-Object {
  $portFilter = $_ | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
  $addressFilter = $_ | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue
  $remoteAddresses = @($addressFilter.RemoteAddress)
  $_.Enabled -eq 'True' -and
    $_.Direction -eq 'Inbound' -and
    $_.Action -eq 'Allow' -and
    $portFilter.Protocol -eq 'TCP' -and
    @($portFilter.LocalPort) -contains "$port" -and
    $remoteAddresses.Count -eq 2 -and
    $remoteAddresses -contains 'LocalSubnet' -and
    ($remoteAddresses -contains '100.64.0.0/10' -or
      $remoteAddresses -contains '100.64.0.0/255.192.0.0')
} | Select-Object -First 1
if ($matchingRule) {
  exit 0
}
$elevatedScript = @'
$ErrorActionPreference = 'Stop'
Remove-NetFirewallRule -DisplayName 'Agent Hub' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'Agent Hub' -Direction Inbound -Action Allow -Enabled True -Protocol TCP -LocalPort ${port} -Profile Any -RemoteAddress @('LocalSubnet', '100.64.0.0/10') -ErrorAction Stop | Out-Null
'@
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object -TypeName Security.Principal.WindowsPrincipal -ArgumentList $identity
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Invoke-Expression $elevatedScript
  exit 0
}
$encodedScript = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($elevatedScript))
$process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encodedScript)
if ($process.ExitCode -ne 0) {
  exit $process.ExitCode
}
exit 0
`;
}
