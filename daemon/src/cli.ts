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
import { lanUrls, startServer } from './server.js';

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
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
    const addresses = new Set(lanUrls(config.port));
    for (const list of Object.values(os.networkInterfaces())) {
      for (const address of list || []) {
        if (address.family === 'IPv4' && /^100\./.test(address.address)) addresses.add(`http://${address.address}:${config.port}`);
      }
    }
    const urls = [...addresses];
    console.log('Agent Hub pairing URLs:');
    urls.forEach((url) => console.log(`  ${url}`));
    const pairing = `agenthub://pair?url=${encodeURIComponent(urls[0] || `http://127.0.0.1:${config.port}`)}&token=${encodeURIComponent(config.token)}`;
    qrcode.generate(pairing, { small: true });
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
    await copyFile(script, destination);
    const publicDir = path.resolve(path.dirname(script), '..', 'public');
    if (existsSync(publicDir)) await cp(publicDir, path.join(installDir, 'public'), { recursive: true, force: true });
    const runtime = isStandalone ? destination : executable;
    const launcher = path.join(installDir, 'start-hidden.vbs');
    const quoteVbs = (value: string) => `"${value.replaceAll('"', '""')}"`;
    await writeFile(launcher, `CreateObject("Wscript.Shell").Run ${quoteVbs(`${quoteVbs(runtime)} ${isStandalone ? 'start' : `${quoteVbs(destination)} start`}`)}, 0, False\r\n`);
    await runProcess('schtasks.exe', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', 'AgentHub', '/TR', `wscript.exe "${launcher}"`, '/RL', 'LIMITED']);
    await runProcess('schtasks.exe', ['/Run', '/TN', 'AgentHub']);
  } else if (command === 'uninstall-service') {
    if (process.platform !== 'win32') console.log('On Windows, run agent-hub uninstall-service to remove the AgentHub Scheduled Task.');
    else await runProcess('schtasks.exe', ['/Delete', '/F', '/TN', 'AgentHub']);
  } else {
    console.log(`Agent Hub CLI
Usage: agent-hub [start|pair|install-claude-hooks|uninstall-claude-hooks|install-service|uninstall-service|config set <key> <value>]
Config directory: ${configDirectory()}`);
  }
}

void run().catch((error: unknown) => {
  console.error(`Agent Hub failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
