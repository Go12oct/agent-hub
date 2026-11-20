import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isSea } from 'node:sea';
import { configDirectory } from './config.js';

interface HookBridgeOptions {
  stdin?: AsyncIterable<string | Uint8Array>;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
  configDir?: string;
  fetchImpl?: typeof fetch;
}

async function readInput(stdin: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function runHookBridge(agent: string, options: HookBridgeOptions = {}): Promise<void> {
  if (agent !== 'codex') return;
  try {
    const payload = await readInput(options.stdin ?? process.stdin);
    if (!payload.trim()) return;
    const configPath = path.join(options.configDir ?? configDirectory(), 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      port?: unknown;
      token?: unknown;
      approvals?: { holdSeconds?: unknown };
    };
    const port = process.env.AGENT_HUB_PORT
      ? Number(process.env.AGENT_HUB_PORT)
      : Number(config.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || typeof config.token !== 'string' || !config.token) return;
    const configuredHold = config.approvals?.holdSeconds;
    const holdSeconds = typeof configuredHold === 'number' && Number.isFinite(configuredHold)
      ? Math.max(1, configuredHold)
      : 300;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (holdSeconds + 30) * 1000);
    timer.unref?.();
    try {
      const response = await (options.fetchImpl ?? globalThis.fetch)(
        `http://127.0.0.1:${port}/hooks/codex`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
          body: payload,
          signal: controller.signal,
        },
      );
      if (response.status !== 200) return;
      const body = await response.text();
      if (!body.trim()) return;
      JSON.parse(body);
      (options.stdout ?? process.stdout).write(body);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return;
  }
}

if (!isSea() && path.basename(process.argv[1] || '').toLowerCase() === 'hook-bridge.cjs') {
  void runHookBridge(process.argv[2] || '');
}
