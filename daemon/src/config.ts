import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import type { RelayConfig } from './relay.js';

declare const __DEFAULT_RELAY_URL__: string | undefined;

export interface HubConfig {
  token: string;
  port: number;
  host: string;
  lookbackDays: number;
  devinApiKey?: string;
  devinPat?: string;
  devinOrgId?: string;
  ntfy?: { server?: string; topic: string };
  approvals?: { enabled?: boolean; holdSeconds?: number };
  codexCloud: { enabled: boolean };
  localReplies?: { enabled?: boolean; codex?: string; claude?: string; agy?: string };
  relayUrl?: string | false;
  relay?: RelayConfig;
}

export function configDirectory(): string {
  if (process.env.AGENT_HUB_CONFIG_DIR) return process.env.AGENT_HUB_CONFIG_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || homedir(), 'agent-hub');
  return path.join(homedir(), '.config', 'agent-hub');
}

export function agentHome(): string {
  return process.env.AGENT_HUB_HOME || homedir();
}

async function relaySecret(dir: string): Promise<string> {
  const file = path.join(dir, 'relay-key');
  try { return (await readFile(file, 'utf8')).trim(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const secret = randomBytes(32).toString('hex');
  const temporary = `${file}.${randomBytes(8).toString('hex')}`;
  await writeFile(temporary, secret, { mode: 0o600, flag: 'wx' });
  try { await link(temporary, file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return (await readFile(file, 'utf8')).trim();
  } finally { await unlink(temporary); }
  return secret;
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
      localReplies: { enabled: true },
    };
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
  if (process.env.DEVIN_API_KEY) config.devinApiKey = process.env.DEVIN_API_KEY;
  if (process.env.DEVIN_PAT) config.devinPat = process.env.DEVIN_PAT;
  if (process.env.DEVIN_ORG_ID) config.devinOrgId = process.env.DEVIN_ORG_ID;
  if (process.env.AGENT_HUB_PORT) config.port = Number(process.env.AGENT_HUB_PORT);
  delete config.relay;
  const defaultRelayUrl = typeof __DEFAULT_RELAY_URL__ === 'string' ? __DEFAULT_RELAY_URL__ : undefined;
  const relayUrl = process.env.AGENT_HUB_RELAY_URL ?? config.relayUrl ?? defaultRelayUrl;
  if (relayUrl && relayUrl !== 'false') {
    const url = URL.parse(String(relayUrl));
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('The relay URL must be an HTTPS origin (for example, https://relay.example.com).');
    }
    const secret = await relaySecret(dir);
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid relay-key in the Agent Hub configuration directory.');
    config.relay = { origin: url.origin, secret };
  }
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
    delete config.relay;
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
