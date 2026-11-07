import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { isSea } from 'node:sea';
import { agentHome, loadConfig } from './config.js';
import type { HubConfig } from './config.js';
import { approvalHookTimeout } from './claude-hooks.js';

const events = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Stop', 'SessionEnd'];

function hooksPath(): string {
  const codexHome = process.env.CODEX_HOME || path.join(agentHome(), '.codex');
  return path.join(codexHome, 'hooks.json');
}

function bridgePath(): string {
  const entry = isSea() ? process.execPath : process.argv[1] || process.execPath;
  return path.join(path.dirname(entry), 'hook-bridge.cjs');
}

export function codexHookCommand(bridge: string, standalone = isSea()): string {
  const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`;
  return standalone
    ? `${quote(process.execPath)} hook-bridge codex`
    : `${quote(process.execPath)} ${quote(bridge)} codex`;
}

function isAgentHubHook(hook: any, bridge: string): boolean {
  return hook?.type === 'command' && typeof hook.command === 'string'
    && [codexHookCommand(bridge, false), codexHookCommand(bridge, true)].includes(hook.command);
}

export async function installCodexHooks(
  file = hooksPath(),
  configPromise?: Promise<HubConfig>,
  bridge = bridgePath(),
): Promise<boolean> {
  let directory;
  try { directory = await stat(path.dirname(file)); } catch { return false; }
  if (!directory.isDirectory()) return false;

  let settings: Record<string, any> = {};
  try {
    settings = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
    const backup = `${file}.agent-hub.bak`;
    try { await copyFile(file, backup, constants.COPYFILE_EXCL); } catch { /* Preserve the first backup. */ }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const config = await (configPromise ?? loadConfig());
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  const command = codexHookCommand(bridge);
  for (const event of events) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    const hook: Record<string, unknown> = event === 'PermissionRequest'
      ? { type: 'command', command, timeout: approvalHookTimeout(config) }
      : { type: 'command', command };
    const exists = entries.some((entry: any) => (entry.hooks || []).some((existing: any) => isAgentHubHook(existing, bridge)));
    if (!exists) entries.push({ hooks: [hook] });
    else {
      for (const entry of entries) {
        entry.hooks = (entry.hooks || []).map((existing: any) => (
          isAgentHubHook(existing, bridge) ? hook : existing
        ));
      }
    }
    hooks[event] = entries;
  }
  settings.hooks = hooks;
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return true;
}

export async function uninstallCodexHooks(file = hooksPath(), bridge = bridgePath()): Promise<void> {
  let settings: Record<string, any>;
  try { settings = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>; } catch { return; }
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    hooks[event] = entries.map((entry: any) => ({
      ...entry,
      hooks: (entry.hooks || []).filter((hook: any) => !isAgentHubHook(hook, bridge)),
    })).filter((entry: any) => entry.hooks?.length);
  }
  settings.hooks = hooks;
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export { events as codexHookEvents };
