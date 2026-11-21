import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
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

const ALLOW_BUTTON_PRIORITY = [
  'Allow once',
  'Allow this conversation',
  'Always allow',
  'Allow for all sites',
];

const SCAN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$procs = @(Get-Process -Name 'Aside' | Where-Object { $_.MainWindowHandle -ne 0 })
if ($procs.Count -eq 0) { '[]'; exit 0 }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$uia = [System.Windows.Automation.AutomationElement]
$ct = [System.Windows.Automation.ControlType]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$btnCond = New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty, $ct::Button)
$textCond = New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty, $ct::Text)
$allowNames = @('Allow once', 'Allow this conversation', 'Always allow', 'Allow for all sites')
$results = @()
foreach ($proc in $procs) {
  $root = $uia::FromHandle($proc.MainWindowHandle)
  if (-not $root) { continue }
  $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
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
            hwnd = $proc.MainWindowHandle.ToString()
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
  private timer?: NodeJS.Timeout;
  private emit?: EmitSession;
  private active = new Map<string, { session: AgentSession; prompt: AsidePrompt }>();
  private polling = false;

  constructor(
    private readonly pollMs = 3000,
    private readonly runner: AsideScriptRunner = defaultRunPowerShell,
    private readonly platform: string = process.platform,
    private readonly now: () => number = Date.now,
  ) {}

  start(emit: EmitSession): void {
    this.emit = emit;
    if (this.platform !== 'win32') return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async getMessages(): Promise<SessionMessage[]> {
    return [];
  }

  async poll(): Promise<void> {
    if (this.platform !== 'win32' || this.polling) return;
    this.polling = true;
    try {
      const output = await this.runner(SCAN_SCRIPT);
      const prompts = parseAsidePrompts(output);
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
