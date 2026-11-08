import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('configuration', () => {
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
