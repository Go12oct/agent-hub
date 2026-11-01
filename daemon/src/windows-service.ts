import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

export type ProcessRunner = (command: string, args: string[]) => Promise<void>;

interface InstallWindowsServiceOptions {
  launcher: string;
  startupDirectory: string;
  port: number;
  runProcess: ProcessRunner;
  isHealthy: (port: number) => Promise<boolean>;
  startDetached: (command: string, args: string[]) => void;
  log: (message: string) => void;
}

export async function installWindowsService(options: InstallWindowsServiceOptions): Promise<'scheduled-task' | 'startup'> {
  try {
    await options.runProcess('schtasks.exe', [
      '/Create', '/F', '/SC', 'ONLOGON', '/TN', 'AgentHub',
      '/TR', `wscript.exe "${options.launcher}"`, '/RL', 'LIMITED',
    ]);
  } catch {
    await mkdir(options.startupDirectory, { recursive: true });
    const startupLauncher = path.join(options.startupDirectory, 'AgentHub.vbs');
    await copyFile(options.launcher, startupLauncher);
    options.log(`Scheduled Task unavailable; using the per-user Startup folder (${startupLauncher}).`);
    if (!await options.isHealthy(options.port)) options.startDetached('wscript.exe', [startupLauncher]);
    return 'startup';
  }

  options.log('Using the AgentHub Scheduled Task at logon.');
  if (!await options.isHealthy(options.port)) {
    await options.runProcess('schtasks.exe', ['/Run', '/TN', 'AgentHub']);
  }
  return 'scheduled-task';
}

export async function isDaemonHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const health = await response.json() as { ok?: boolean };
    return health.ok === true;
  } catch {
    return false;
  }
}

export async function uninstallWindowsService(startupDirectory: string, runProcess: ProcessRunner): Promise<void> {
  try {
    await runProcess('schtasks.exe', ['/Delete', '/F', '/TN', 'AgentHub']);
  } catch {}
  await rm(path.join(startupDirectory, 'AgentHub.vbs'), { force: true });
}
