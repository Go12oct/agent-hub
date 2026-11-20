import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installClaudeHooks } from '../src/claude-hooks';

describe('Claude hook installation', () => {
  it('merges with existing hooks idempotently and creates a backup', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-hooks-'));
    const file = path.join(dir, 'settings.json');
    const configDir = path.join(dir, 'config');
    const previousConfigDir = process.env.AGENT_HUB_CONFIG_DIR;
    process.env.AGENT_HUB_CONFIG_DIR = configDir;
    const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo preserve' }] }] } };
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, JSON.stringify(original)));
    try {
      await installClaudeHooks(file);
      const first = await readFile(file, 'utf8');
      await installClaudeHooks(file);
      const second = await readFile(file, 'utf8');
      expect(JSON.parse(second).hooks.Stop).toHaveLength(2);
      expect(JSON.parse(second).hooks.UserPromptSubmit).toHaveLength(1);
      expect(JSON.parse(second).hooks.Stop[0]).toEqual(original.hooks.Stop[0]);
      expect(JSON.parse(second).hooks.PostToolUse).toHaveLength(1);
      expect(JSON.parse(second).hooks.PostToolUseFailure).toHaveLength(1);
      expect(JSON.parse(second).hooks.PermissionDenied).toHaveLength(1);
      expect(first).toBe(second);
      expect(JSON.parse(await readFile(`${file}.agent-hub.bak`, 'utf8'))).toEqual(original);
    } finally {
      if (previousConfigDir === undefined) delete process.env.AGENT_HUB_CONFIG_DIR;
      else process.env.AGENT_HUB_CONFIG_DIR = previousConfigDir;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
