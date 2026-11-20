import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDirectory, loadConfig } from './config.js';
import type { HubConfig } from './config.js';

const events = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'SubagentStart', 'Notification', 'Stop', 'PermissionRequest', 'StopFailure', 'SessionEnd'];
export const defaultApprovalHoldSeconds = 300;

export function approvalHookTimeout(config: Pick<HubConfig, 'approvals'>): number {
  return Math.max(60, (config.approvals?.holdSeconds ?? defaultApprovalHoldSeconds) + 60);
}

function hooksUrl(config: HubConfig): string {
  return `http://127.0.0.1:${config.port}/hooks/claude?token=${encodeURIComponent(config.token)}`;
}

function userSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

export async function installClaudeHooks(settingsPath = userSettingsPath(), configPromise = loadConfig()): Promise<void> {
  const config = await configPromise;
  await mkdir(path.dirname(settingsPath), { recursive: true });
  let settings: Record<string, any> = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, any>;
    const backup = `${settingsPath}.agent-hub.bak`;
    try { await copyFile(settingsPath, backup, constants.COPYFILE_EXCL); } catch { /* Preserve the first backup. */ }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const url = hooksUrl(config);
  for (const event of events) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    const ours = (hook: any) => hook.type === 'http' && hook.url === url;
    const hook: Record<string, unknown> = event === 'PermissionRequest'
      ? { type: 'http', url, timeout: approvalHookTimeout(config) }
      : { type: 'http', url };
    const exists = entries.some((entry: any) => (entry.hooks || []).some(ours));
    if (!exists) entries.push({ hooks: [hook] });
    else {
      for (const entry of entries) {
        entry.hooks = (entry.hooks || []).map((existing: any) => (ours(existing) ? hook : existing));
      }
    }
    hooks[event] = entries;
  }
  settings.hooks = hooks;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export async function uninstallClaudeHooks(settingsPath = userSettingsPath(), configPromise = loadConfig()): Promise<void> {
  const config = await configPromise;
  let settings: Record<string, any>;
  try { settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, any>; } catch { return; }
  const url = hooksUrl(config);
  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    settings.hooks[event] = entries.map((entry: any) => ({
      ...entry,
      hooks: (entry.hooks || []).filter((hook: any) => !(hook.type === 'http' && hook.url === url)),
    })).filter((entry: any) => entry.hooks?.length);
  }
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export { events as claudeHookEvents };
