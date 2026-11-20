import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, setConfigValue } from '../src/config';

describe('configuration', () => {
  it('keeps the relay identity across loads and accepts HTTPS only', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-relay-config-'));
    vi.stubEnv('AGENT_HUB_CONFIG_DIR', directory);
    vi.stubEnv('AGENT_HUB_RELAY_URL', undefined);
    try {
      expect((await loadConfig()).relay).toBeUndefined();
      await setConfigValue('relayUrl', 'https://relay.example.test');
      const [first, second] = await Promise.all([loadConfig(), loadConfig()]);
      expect(first.relay).toEqual({ origin: 'https://relay.example.test', secret: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(second.relay).toEqual(first.relay);
      vi.stubEnv('AGENT_HUB_RELAY_URL', 'http://relay.example.test');
      await expect(loadConfig()).rejects.toThrow('HTTPS origin');
      vi.stubEnv('AGENT_HUB_RELAY_URL', 'false');
      expect((await loadConfig()).relay).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('loads Devin v3 credentials from environment overrides', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-config-'));
    const previous = {
      configDir: process.env.AGENT_HUB_CONFIG_DIR,
      devinPat: process.env.DEVIN_PAT,
      devinOrgId: process.env.DEVIN_ORG_ID,
    };
    process.env.AGENT_HUB_CONFIG_DIR = directory;
    process.env.DEVIN_PAT = 'fake-pat';
    process.env.DEVIN_ORG_ID = 'fake-org';
    try {
      await expect(loadConfig()).resolves.toMatchObject({
        devinPat: 'fake-pat',
        devinOrgId: 'fake-org',
      });
    } finally {
      if (previous.configDir === undefined) delete process.env.AGENT_HUB_CONFIG_DIR;
      else process.env.AGENT_HUB_CONFIG_DIR = previous.configDir;
      if (previous.devinPat === undefined) delete process.env.DEVIN_PAT;
      else process.env.DEVIN_PAT = previous.devinPat;
      if (previous.devinOrgId === undefined) delete process.env.DEVIN_ORG_ID;
      else process.env.DEVIN_ORG_ID = previous.devinOrgId;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
