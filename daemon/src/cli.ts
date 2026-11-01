#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { cp, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import qrcode from 'qrcode-terminal';
import { loadConfig, setConfigValue, configDirectory } from './config.js';
import { installClaudeHooks, uninstallClaudeHooks } from './claude-hooks.js';
import { firewallRuleScript } from './firewall.js';
import { lanUrls, startServer } from './server.js';
import { installWindowsService, isDaemonHealthy, uninstallWindowsService } from './windows-service.js';

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function addWindowsFirewallRule(port: number): Promise<void> {
  const encodedCommand = Buffer.from(firewallRuleScript(port), 'utf16le').toString('base64');
  await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand]);
}

async function run(): Promise<void> {
  const [command = 'start', ...args] = process.argv.slice(2);
  if (command === 'start') {
    const config = await loadConfig();
    const runtime = await startServer(config);
    const close = async () => { await runtime.close(); process.exit(0); };
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
  } else if (command === 'pair') {
    const config = await loadConfig();
    const candidates = lanUrls(config.port);
    const urlOption = args.indexOf('--url');
    const overrideValue = urlOption >= 0 ? args[urlOption + 1] : undefined;
    if (urlOption >= 0 && (!overrideValue || overrideValue.startsWith('--'))) {
      throw new Error('Usage: agent-hub pair [--url <url>]');
    }
    let overrideUrl: string | undefined;
    if (overrideValue) {
      const parsed = new URL(overrideValue);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The --url value must use http or https.');
      overrideUrl = parsed.origin;
    }
    const chosenUrl = overrideUrl || candidates[0] || `http://127.0.0.1:${config.port}`;
    const displayedUrls = candidates.includes(chosenUrl) ? candidates : [...candidates, chosenUrl];
    console.log('Agent Hub pairing URLs (chosen URL marked):');
    displayedUrls.forEach((url) => console.log(`  ${url}${url === chosenUrl ? ' (chosen)' : ''}`));
    console.log("If the phone can't connect, try another URL with: agent-hub pair --url http://<ip>:4747");
    const pairing = `agenthub://pair?url=${encodeURIComponent(chosenUrl)}&token=${encodeURIComponent(config.token)}`;
    qrcode.generate(pairing, { small: true });
  } else if (command === 'firewall') {
    if (process.platform !== 'win32') {
      console.log('The Agent Hub firewall rule can only be configured on Windows.');
      return;
    }
    const port = (await loadConfig()).port;
    try {
      await addWindowsFirewallRule(port);
      console.log(`Windows Firewall allows Agent Hub on TCP port ${port}.`);
    } catch {
      console.warn('Could not add the Windows Firewall rule. Approve the UAC prompt or run agent-hub firewall as administrator.');
      process.exitCode = 1;
    }
  } else if (command === 'config' && args[0] === 'set' && args[1] && args[2] !== undefined) {
    await setConfigValue(args[1], args.slice(2).join(' '));
    console.log(`Updated ${args[1]}`);
  } else if (command === 'install-claude-hooks') {
    await installClaudeHooks();
    console.log('Installed Claude Code hooks.');
  } else if (command === 'uninstall-claude-hooks') {
    await uninstallClaudeHooks();
    console.log('Removed Agent Hub Claude Code hooks.');
  } else if (command === 'install-service') {
    if (process.platform !== 'win32') {
      console.log('On Windows, run agent-hub install-service to register the AgentHub Scheduled Task.');
      return;
    }
    const installDir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'agent-hub');
    await mkdir(installDir, { recursive: true });
    const isStandalone = isSea();
    const executable = process.execPath;
    const script = isStandalone ? executable : path.resolve(process.argv[1]!);
    const destination = path.join(installDir, isStandalone ? 'agent-hub.exe' : 'agent-hub.cjs');
    const samePath = (left: string, right: string) => {
      const resolvedLeft = path.resolve(left);
      const resolvedRight = path.resolve(right);
      return process.platform === 'win32'
        ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
        : resolvedLeft === resolvedRight;
    };
    if (!samePath(script, destination)) await copyFile(script, destination);
    const scriptDir = path.dirname(script);
    const publicDir = [
      path.join(scriptDir, 'public'),
      path.resolve(scriptDir, '..', 'public'),
    ].find(existsSync);
    const installedPublicDir = path.join(installDir, 'public');
    if (publicDir && !samePath(publicDir, installedPublicDir)) {
      await cp(publicDir, installedPublicDir, { recursive: true, force: true });
    }
    const runtime = isStandalone ? destination : executable;
    const launcher = path.join(installDir, 'start-hidden.vbs');
    const quoteVbs = (value: string) => `"${value.replaceAll('"', '""')}"`;
    await writeFile(launcher, `CreateObject("Wscript.Shell").Run ${quoteVbs(`${quoteVbs(runtime)} ${isStandalone ? 'start' : `${quoteVbs(destination)} start`}`)}, 0, False\r\n`);
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const startupDirectory = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const config = await loadConfig();
    await installWindowsService({
      launcher,
      startupDirectory,
      port: config.port,
      runProcess,
      isHealthy: isDaemonHealthy,
      startDetached: (command, childArgs) => {
        const child = spawn(command, childArgs, { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', (error) => console.error(`Could not start Agent Hub: ${(error as Error).message}`));
        child.unref();
      },
      log: (message) => console.log(message),
    });
  } else if (command === 'uninstall-service') {
    if (process.platform !== 'win32') console.log('On Windows, run agent-hub uninstall-service to remove the AgentHub Scheduled Task.');
    else {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      const startupDirectory = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
      await uninstallWindowsService(startupDirectory, runProcess);
      console.log('Removed the AgentHub Scheduled Task and Startup entry, if present.');
    }
  } else {
    console.log(`Agent Hub CLI
Usage: agent-hub [start|pair [--url <url>]|firewall|install-claude-hooks|uninstall-claude-hooks|install-service|uninstall-service|config set <key> <value>]
Config directory: ${configDirectory()}`);
  }
}

void run().catch((error: unknown) => {
  console.error(`Agent Hub failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
