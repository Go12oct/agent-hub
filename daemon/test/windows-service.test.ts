import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWindowsService, uninstallWindowsService } from '../src/windows-service.js';

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-service-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Windows service installation', () => {
  it('copies the launcher to Startup and starts it when scheduled-task creation fails', async () => {
    const root = await createTempDirectory();
    const launcher = path.join(root, 'install', 'start-hidden.vbs');
    const startupDirectory = path.join(root, 'appdata', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const startupLauncher = path.join(startupDirectory, 'AgentHub.vbs');
    await mkdir(path.dirname(launcher), { recursive: true });
    await writeFile(launcher, 'CreateObject("Wscript.Shell")');

    const runProcess = vi.fn(async () => { throw new Error('Access is denied.'); });
    const isHealthy = vi.fn(async () => false);
    const startDetached = vi.fn();
    const log = vi.fn();

    const method = await installWindowsService({
      launcher,
      startupDirectory,
      port: 4747,
      runProcess,
      isHealthy,
      startDetached,
      log,
    });

    expect(method).toBe('startup');
    expect(await readFile(startupLauncher, 'utf8')).toBe('CreateObject("Wscript.Shell")');
    expect(runProcess).toHaveBeenCalledOnce();
    expect(runProcess).toHaveBeenCalledWith('schtasks.exe', expect.arrayContaining(['/Create']));
    expect(startDetached).toHaveBeenCalledWith('wscript.exe', [startupLauncher]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('per-user Startup folder'));
  });

  it('runs the scheduled task when creation succeeds and no daemon is healthy', async () => {
    const runProcess = vi.fn(async () => {});
    const startDetached = vi.fn();

    const method = await installWindowsService({
      launcher: 'C:\\Agent Hub\\start-hidden.vbs',
      startupDirectory: 'C:\\Startup',
      port: 4747,
      runProcess,
      isHealthy: async () => false,
      startDetached,
      log: vi.fn(),
    });

    expect(method).toBe('scheduled-task');
    expect(runProcess).toHaveBeenNthCalledWith(1, 'schtasks.exe', expect.arrayContaining(['/Create']));
    expect(runProcess).toHaveBeenNthCalledWith(2, 'schtasks.exe', ['/Run', '/TN', 'AgentHub']);
    expect(startDetached).not.toHaveBeenCalled();
  });

  it('does not start another daemon when the health endpoint is already OK', async () => {
    const runProcess = vi.fn(async () => {});
    const startDetached = vi.fn();

    await installWindowsService({
      launcher: 'C:\\Agent Hub\\start-hidden.vbs',
      startupDirectory: 'C:\\Startup',
      port: 4747,
      runProcess,
      isHealthy: async () => true,
      startDetached,
      log: vi.fn(),
    });

    expect(runProcess).toHaveBeenCalledOnce();
    expect(startDetached).not.toHaveBeenCalled();
  });

  it('stops a running daemon and starts the new one when a shutdown hook is provided', async () => {
    const root = await createTempDirectory();
    const launcher = path.join(root, 'start-hidden.vbs');
    await writeFile(launcher, 'launcher');
    const startupDirectory = path.join(root, 'Startup');
    let healthy = true;
    const stopRunning = vi.fn(async () => { healthy = false; });
    const startDetached = vi.fn();
    const log = vi.fn();

    await installWindowsService({
      launcher,
      startupDirectory,
      port: 4747,
      runProcess: vi.fn(async () => { throw new Error('Access is denied.'); }),
      isHealthy: async () => healthy,
      stopRunning,
      startDetached,
      log,
    });

    expect(stopRunning).toHaveBeenCalledWith(4747);
    expect(startDetached).toHaveBeenCalledWith('wscript.exe', [path.join(startupDirectory, 'AgentHub.vbs')]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Stopping the running Agent Hub'));
  });

  it('leaves a daemon that refuses to stop in place', async () => {
    vi.useFakeTimers();
    try {
      const startDetached = vi.fn();
      const log = vi.fn();
      const pending = installWindowsService({
        launcher: 'C:\\Agent Hub\\start-hidden.vbs',
        startupDirectory: 'C:\\Startup',
        port: 4747,
        runProcess: vi.fn(async () => {}),
        isHealthy: async () => true,
        stopRunning: async () => {},
        startDetached,
        log,
      });
      await vi.advanceTimersByTimeAsync(11_000);
      await pending;
      expect(startDetached).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('did not stop'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores scheduled-task deletion failures and removes the Startup launcher', async () => {
    const root = await createTempDirectory();
    const startupDirectory = path.join(root, 'Startup');
    const startupLauncher = path.join(startupDirectory, 'AgentHub.vbs');
    await mkdir(startupDirectory, { recursive: true });
    await writeFile(startupLauncher, 'launcher');
    const runProcess = vi.fn(async () => { throw new Error('Access is denied.'); });

    await expect(uninstallWindowsService(startupDirectory, runProcess)).resolves.toBeUndefined();
    await expect(readFile(startupLauncher)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
