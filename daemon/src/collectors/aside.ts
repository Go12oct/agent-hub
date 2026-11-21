import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { AgentSession, PendingApproval, SessionMessage } from '@agent-hub/shared';
import type { Collector, EmitSession } from './types.js';

const execFileAsync = promisify(execFile);

export interface AsidePrompt {
  hwnd: string;
  summary: string;
  detail?: string;
  buttons: string[];
}

export type AsideScriptRunner = (script: string) => Promise<string>;

export interface AsideWatcherProcess {
  onLine(cb: (line: string) => void): void;
  onExit(cb: () => void): void;
  kill(): void;
}

export type AsideWatcherSpawner = (script: string) => AsideWatcherProcess;

const ALLOW_BUTTON_PRIORITY = [
  'Allow once',
  'Allow this conversation',
  'Always allow',
  'Allow for all sites',
];

const SCAN_BODY = `
$pids = @(Get-Process -Name 'Aside' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if ($pids.Count -eq 0) {
  '[]'
} else {
  $root = $uia::RootElement
  $topWindows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $results = @()
  for ($w = 0; $w -lt $topWindows.Count; $w++) {
    $win = $topWindows.Item($w)
    if ($pids -notcontains $win.Current.ProcessId) { continue }
    $hwnd = $win.Current.NativeWindowHandle
    if (-not $hwnd) { continue }
    $buttons = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    $seenContainers = @{}
    for ($i = 0; $i -lt $buttons.Count; $i++) {
      $btn = $buttons.Item($i)
      $name = ($btn.Current.Name | Out-String).Trim()
      if ($name -ne 'Deny') { continue }
      $container = $walker.GetParent($btn)
      for ($depth = 0; $depth -lt 4 -and $container; $depth++) {
        $sibButtons = $container.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
        $names = @()
        for ($j = 0; $j -lt $sibButtons.Count; $j++) {
          $bName = ($sibButtons.Item($j).Current.Name | Out-String).Trim()
          if ($bName) { $names += $bName }
        }
        $hasAllow = $false
        foreach ($a in $allowNames) { if ($names -contains $a) { $hasAllow = $true; break } }
        if ($hasAllow) {
          $texts = $container.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCond)
          $lines = @()
          for ($t = 0; $t -lt $texts.Count; $t++) {
            $txt = ($texts.Item($t).Current.Name | Out-String).Trim()
            if ($txt -and ($names -notcontains $txt) -and ($lines -notcontains $txt)) { $lines += $txt }
          }
          $key = ($lines -join '|') + '|' + ($names -join ',')
          if (-not $seenContainers.ContainsKey($key) -and $lines.Count -gt 0) {
            $seenContainers[$key] = $true
            $results += [PSCustomObject]@{
              hwnd = $hwnd.ToString()
              summary = ($lines -join ' — ')
              buttons = $names
            }
          }
          break
        }
        $container = $walker.GetParent($container)
      }
    }
  }
  if ($results.Count -eq 0) { '[]' } else { $results | ConvertTo-Json -Compress -AsArray }
}
`;

const UIA_PREAMBLE = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$uia = [System.Windows.Automation.AutomationElement]
$ct = [System.Windows.Automation.ControlType]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$btnCond = New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty, $ct::Button)
$textCond = New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty, $ct::Text)
$allowNames = @('Allow once', 'Allow this conversation', 'Always allow', 'Allow for all sites')
`;

export const SCAN_SCRIPT = `${UIA_PREAMBLE}
${SCAN_BODY}
`;

const WATCH_SCRIPT = `${UIA_PREAMBLE}
$lastJson = ''
$lastEmit = [DateTime]::UtcNow
while ($true) {
  $json = & { ${SCAN_BODY} } | Out-String
  $json = $json.Trim()
  if (-not $json) { $json = '[]' }
  $now = [DateTime]::UtcNow
  if ($json -ne $lastJson) {
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
    $lastJson = $json
    $lastEmit = $now
  } elseif (($now - $lastEmit).TotalSeconds -ge 30) {
    [Console]::Out.WriteLine('{"hb":1}')
    [Console]::Out.Flush()
    $lastEmit = $now
  }
  Start-Sleep -Milliseconds 2000
}
`;

function clickScript(hwnd: string, buttonNames: string[]): string {
  const escaped = buttonNames.map((name) => `'${name.replaceAll("'", "''")}'`).join(', ');
  const safeHwnd = hwnd.replace(/[^0-9-]/g, '');
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$uia = [System.Windows.Automation.AutomationElement]
$ct = [System.Windows.Automation.ControlType]
$root = $uia::FromHandle([IntPtr]::new([long]'${safeHwnd}'))
if (-not $root) { 'none'; exit 0 }
$btnCond = New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty, $ct::Button)
$buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
$targets = @(${escaped})
foreach ($targetName in $targets) {
  for ($i = 0; $i -lt $buttons.Count; $i++) {
    $btn = $buttons.Item($i)
    $name = ($btn.Current.Name | Out-String).Trim()
    if ($name -eq $targetName) {
      $pattern = $null
      if ($btn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke()
        'ok'
        exit 0
      }
    }
  }
}
'none'
`;
}

async function defaultRunPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { timeout: 4000, windowsHide: true },
  );
  return stdout.trim();
}

function defaultSpawnWatcher(script: string): AsideWatcherProcess {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const rl = createInterface({ input: child.stdout });
  return {
    onLine: (cb) => { rl.on('line', cb); },
    onExit: (cb) => { child.on('exit', () => cb()); },
    kill: () => {
      rl.close();
      child.kill();
    },
  };
}

export function parseAsidePrompts(raw: string): AsidePrompt[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const item = row as Record<string, unknown>;
      const hwnd = typeof item.hwnd === 'string' || typeof item.hwnd === 'number' ? String(item.hwnd) : '';
      const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
      const buttons = Array.isArray(item.buttons)
        ? item.buttons.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];
      if (!hwnd || !summary || !buttons.length) return [];
      return [{ hwnd, summary: summary.slice(0, 280), buttons }];
    });
  } catch {
    return [];
  }
}

export function promptNativeId(prompt: AsidePrompt): string {
  return createHash('sha1').update(`${prompt.hwnd}:${prompt.summary}`).digest('hex').slice(0, 12);
}

export class AsideCollector implements Collector {
  name = 'aside';
  private emit?: EmitSession;
  private active = new Map<string, { session: AgentSession; prompt: AsidePrompt }>();
  private watcher?: AsideWatcherProcess;
  private restartTimer?: NodeJS.Timeout;
  private stopped = false;
  private polling = false;
  private backoffMs = 2000;

  constructor(
    private readonly maxBackoffMs = 60_000,
    private readonly runner: AsideScriptRunner = defaultRunPowerShell,
    private readonly platform: string = process.platform,
    private readonly now: () => number = Date.now,
    private readonly spawnWatcher: AsideWatcherSpawner = defaultSpawnWatcher,
  ) {}

  start(emit: EmitSession): void {
    this.emit = emit;
    this.stopped = false;
    this.backoffMs = 2000;
    if (this.platform !== 'win32') return;
    this.launchWatcher();
  }

  private launchWatcher(): void {
    if (this.stopped || this.platform !== 'win32') return;
    const proc = this.spawnWatcher(WATCH_SCRIPT);
    this.watcher = proc;
    proc.onLine((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.includes('"hb"')) return;
      this.backoffMs = 2000;
      this.applyPrompts(parseAsidePrompts(trimmed));
    });
    proc.onExit(() => {
      if (this.watcher === proc) this.watcher = undefined;
      if (this.stopped) return;
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs * 2);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        this.launchWatcher();
      }, delay);
      this.restartTimer.unref?.();
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.watcher?.kill();
    this.watcher = undefined;
  }

  async getMessages(): Promise<SessionMessage[]> {
    return [];
  }

  private applyPrompts(prompts: AsidePrompt[]): void {
    const nextIds = new Set<string>();
    const timestamp = new Date(this.now()).toISOString();

    for (const prompt of prompts) {
      const nativeId = promptNativeId(prompt);
      const id = `aside:${nativeId}`;
      nextIds.add(id);
      const existing = this.active.get(id);
      const approval: PendingApproval = existing?.session.approval ?? {
        id: `aside-${nativeId}`,
        toolName: 'Aside',
        summary: prompt.summary,
        detail: `Options: ${prompt.buttons.join(' · ')}`,
        requestedAt: timestamp,
      };
      const session: AgentSession = {
        id,
        agent: 'codex',
        nativeId,
        title: 'ChatGPT (Aside)',
        project: 'Aside',
        status: 'needs_input',
        canReply: false,
        approval,
        approvals: [approval],
        lastMessage: prompt.summary,
        startedAt: existing?.session.startedAt ?? timestamp,
        updatedAt: existing?.session.updatedAt ?? timestamp,
        machine: os.hostname(),
      };
      this.active.set(id, { session, prompt });
      if (!existing) this.emit?.(session);
    }

    for (const id of [...this.active.keys()]) {
      if (!nextIds.has(id)) {
        this.active.delete(id);
        this.emit?.remove?.(id);
      }
    }
  }

  async poll(): Promise<void> {
    if (this.platform !== 'win32' || this.polling) return;
    this.polling = true;
    try {
      const output = await this.runner(SCAN_SCRIPT);
      this.applyPrompts(parseAsidePrompts(output));
    } catch {
      // Aside may not be running or UIA may be temporarily busy.
    } finally {
      this.polling = false;
    }
  }

  async decideApproval(nativeId: string, _approvalId: string | undefined, decision: 'allow' | 'deny'): Promise<'ok' | 'none'> {
    const id = `aside:${nativeId}`;
    const entry = this.active.get(id);
    if (!entry) return 'none';
    const buttonNames = decision === 'deny'
      ? ['Deny']
      : ALLOW_BUTTON_PRIORITY.filter((name) => entry.prompt.buttons.includes(name));
    if (!buttonNames.length) return 'none';
    const result = await this.runner(clickScript(entry.prompt.hwnd, buttonNames));
    if (result.trim() !== 'ok') return 'none';
    this.active.delete(id);
    this.emit?.remove?.(id);
    return 'ok';
  }
}
