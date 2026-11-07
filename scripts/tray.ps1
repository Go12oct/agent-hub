param([switch]$Quit)

$mutexName = 'Local\AgentHubTray'
$quitEventName = 'Local\AgentHubTrayQuit'

if ($Quit) {
  try {
    $quitEvent = [System.Threading.EventWaitHandle]::OpenExisting($quitEventName)
    $quitEvent.Set() | Out-Null
    $quitEvent.Dispose()
  } catch {}
  exit 0
}

$createdNew = $false
$mutex = [System.Threading.Mutex]::new($false, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
  $mutex.Dispose()
  exit 0
}

$quitEvent = [System.Threading.EventWaitHandle]::new(
  $false,
  [System.Threading.EventResetMode]::AutoReset,
  $quitEventName
)
$quitEvent.Reset()

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $configDirectory = if ($env:AGENT_HUB_CONFIG_DIR) {
    $env:AGENT_HUB_CONFIG_DIR
  } elseif ($env:APPDATA) {
    Join-Path $env:APPDATA 'agent-hub'
  } else {
    Join-Path $env:USERPROFILE 'AppData\Roaming\agent-hub'
  }
  $script:port = 4747
  $script:token = $null
  try {
    $config = Get-Content -Raw -Path (Join-Path $configDirectory 'config.json') | ConvertFrom-Json
    if ($config.port -ge 1 -and $config.port -le 65535) { $script:port = [int]$config.port }
    $script:token = $config.token
  } catch {}
  if ($env:AGENT_HUB_PORT -match '^\d+$' -and [int]$env:AGENT_HUB_PORT -ge 1 -and [int]$env:AGENT_HUB_PORT -le 65535) {
    $script:port = [int]$env:AGENT_HUB_PORT
  }
  $script:baseUrl = "http://127.0.0.1:$script:port"
  $script:browserUrl = "http://localhost:$script:port"
  $script:installDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
  $script:lastHealthCheck = [DateTime]::MinValue
  $script:isClosing = $false

  function Test-AgentHub {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "$script:baseUrl/health"
      return $response.StatusCode -eq 200 -and ($response.Content | ConvertFrom-Json).ok -eq $true
    } catch {
      return $false
    }
  }

  function Stop-AgentHub {
    if (-not $script:token) { return -not (Test-AgentHub) }
    try {
      $request = [System.Net.HttpWebRequest]::Create("$script:baseUrl/api/shutdown")
      $request.Method = 'POST'
      $request.Headers.Add('Authorization', "Bearer $script:token")
      $request.ContentLength = 0
      $request.Timeout = 2000
      $request.ReadWriteTimeout = 2000
      $response = $request.GetResponse()
      $response.Close()
    } catch {
      if ($_.Exception.Response) { $_.Exception.Response.Close() }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
      if (-not (Test-AgentHub)) { return $true }
      Start-Sleep -Milliseconds 250
    }
    return -not (Test-AgentHub)
  }

  function Start-AgentHub {
    $executable = Join-Path $script:installDirectory 'agent-hub.exe'
    if (Test-Path $executable) {
      Start-Process -FilePath $executable -ArgumentList 'start' -WindowStyle Hidden
      return
    }
    $bundle = Join-Path $script:installDirectory 'agent-hub.cjs'
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node -or -not (Test-Path $bundle)) {
      [System.Windows.Forms.MessageBox]::Show('Agent Hub could not be restarted. Reinstall it from the release ZIP.') | Out-Null
      return
    }
    Start-Process -FilePath $node.Source -ArgumentList @("`"$bundle`"", 'start') -WindowStyle Hidden
  }

  function Update-AgentHubStatus {
    $healthy = Test-AgentHub
    $script:lastHealthCheck = [DateTime]::UtcNow
    if ($healthy) {
      $script:notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
      $script:notifyIcon.Text = 'Agent Hub - Running'
    } else {
      $script:notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
      $script:notifyIcon.Text = 'Agent Hub - Not running'
    }
  }

  function Exit-AgentHubTray {
    if ($script:isClosing) { return }
    $script:isClosing = $true
    [void](Stop-AgentHub)
    $script:timer.Stop()
    $script:notifyIcon.Visible = $false
    $script:notifyIcon.Dispose()
    $script:menu.Dispose()
    [System.Windows.Forms.Application]::ExitThread()
  }

  $script:menu = New-Object System.Windows.Forms.ContextMenuStrip
  $openItem = $script:menu.Items.Add('Open Agent Hub')
  $openItem.add_Click({ Start-Process -FilePath $script:browserUrl })
  $pairItem = $script:menu.Items.Add('Pair phone')
  $pairItem.add_Click({
    $shim = Join-Path $script:installDirectory 'agent-hub.cmd'
    if (Test-Path $shim) {
      Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', "`"$shim`" pair") -WorkingDirectory $script:installDirectory
    }
  })
  $restartItem = $script:menu.Items.Add('Restart Agent Hub')
  $restartItem.add_Click({
    if ((Test-AgentHub) -and -not (Stop-AgentHub)) {
      [System.Windows.Forms.MessageBox]::Show('Agent Hub did not stop. Try again or restart Windows.') | Out-Null
    } else {
      Start-AgentHub
    }
  })
  [void]$script:menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $quitItem = $script:menu.Items.Add('Quit')
  $quitItem.add_Click({ Exit-AgentHubTray })

  $script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon
  $script:notifyIcon.ContextMenuStrip = $script:menu
  $script:notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
  $script:notifyIcon.Text = 'Agent Hub'
  $script:notifyIcon.Visible = $true
  $script:notifyIcon.add_DoubleClick({ Start-Process -FilePath $script:browserUrl })

  $script:timer = New-Object System.Windows.Forms.Timer
  $script:timer.Interval = 1000
  $script:timer.add_Tick({
    if ($quitEvent.WaitOne(0)) {
      Exit-AgentHubTray
      return
    }
    if (([DateTime]::UtcNow - $script:lastHealthCheck).TotalSeconds -ge 10) {
      Update-AgentHubStatus
    }
  })
  Update-AgentHubStatus
  $script:timer.Start()
  [System.Windows.Forms.Application]::Run()
} finally {
  if ($script:timer) { $script:timer.Dispose() }
  if ($script:notifyIcon) {
    $script:notifyIcon.Visible = $false
    $script:notifyIcon.Dispose()
  }
  if ($script:menu) { $script:menu.Dispose() }
  $quitEvent.Dispose()
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
}
