import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export interface HubConfig {
  token: string;
  port: number;
  host: string;
  lookbackDays: number;
  devinApiKey?: string;
  ntfy?: { server: string; topic: string };
  codexCloud: { enabled: boolean };
}

export function configDirectory(): string {
  if (process.env.AGENT_HUB_CONFIG_DIR) return process.env.AGENT_HUB_CONFIG_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || homedir(), 'agent-hub');
  return path.join(homedir(), '.config', 'agent-hub');
}

export function agentHome(): string {
  return process.env.AGENT_HUB_HOME || homedir();
}

export async function loadConfig(): Promise<HubConfig> {
  const dir = configDirectory();
  const file = path.join(dir, 'config.json');
  await mkdir(dir, { recursive: true });
  let config: HubConfig;
  try {
    config = JSON.parse(await readFile(file, 'utf8')) as HubConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    config = {
      token: randomBytes(32).toString('hex'),
      port: 4747,
      host: '0.0.0.0',
      lookbackDays: 7,
      codexCloud: { enabled: false },
    };
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
  if (process.env.DEVIN_API_KEY) config.devinApiKey = process.env.DEVIN_API_KEY;
  if (process.env.AGENT_HUB_PORT) config.port = Number(process.env.AGENT_HUB_PORT);
  return config;
}

export async function setConfigValue(key: string, value: string): Promise<void> {
  const dir = configDirectory();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    config = await loadConfig() as unknown as Record<string, unknown>;
  }
  const segments = key.split('.');
  let current = config;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (child === null || typeof child !== 'object') current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  let parsed: unknown = value;
  if (value === 'true' || value === 'false') parsed = value === 'true';
  else if (value !== '' && Number.isFinite(Number(value))) parsed = Number(value);
  current[segments.at(-1)!] = parsed;
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
