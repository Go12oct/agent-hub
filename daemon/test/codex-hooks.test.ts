import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexHookCommand, installCodexHooks, uninstallCodexHooks } from '../src/codex-hooks';

const config = {
  token: 'test-token',
  port: 4747,
  host: '127.0.0.1',
  lookbackDays: 7,
  approvals: { holdSeconds: 45 },
  codexCloud: { enabled: false },
};

describe('Codex hook installation', () => {
  it('preserves foreign hooks, backs up the first config, and installs idempotently', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-codex-hooks-'));
    const codexDir = path.join(dir, '.codex');
    await mkdir(codexDir);
    const file = path.join(codexDir, 'hooks.json');
    const bridge = path.join(dir, 'Agent Hub', 'hook-bridge.cjs');
    const original = {
      other: 'preserved',
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'coucou hook' }] }],
        Stop: [{ hooks: [{ type: 'mcp_tool', name: 'foreign-tool' }] }],
      },
    };
    await writeFile(file, JSON.stringify(original));
    try {
      expect(await installCodexHooks(file, Promise.resolve(config), bridge)).toBe(true);
      const first = await readFile(file, 'utf8');
      expect(await installCodexHooks(file, Promise.resolve(config), bridge)).toBe(true);
      const second = await readFile(file, 'utf8');
      const settings = JSON.parse(second);
      const expectedCommand = `"${process.execPath}" "${bridge}" codex`;
      expect(second).toBe(first);
      expect(settings.other).toBe('preserved');
      expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
      expect(settings.hooks.UserPromptSubmit[0]).toEqual(original.hooks.UserPromptSubmit[0]);
      expect(settings.hooks.PermissionRequest[0].hooks[0]).toEqual({
        type: 'command',
        command: expectedCommand,
        timeout: 105,
      });
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(expectedCommand);
      expect(JSON.parse(await readFile(`${file}.agent-hub.bak`, 'utf8'))).toEqual(original);

      await uninstallCodexHooks(file, bridge);
      const removed = JSON.parse(await readFile(file, 'utf8'));
      expect(removed.hooks.UserPromptSubmit).toEqual(original.hooks.UserPromptSubmit);
      expect(removed.hooks.Stop).toEqual(original.hooks.Stop);
      expect(removed.hooks.PermissionRequest).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips installation when the Codex directory does not exist', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-codex-hooks-missing-'));
    const file = path.join(dir, '.codex', 'hooks.json');
    try {
      expect(await installCodexHooks(file, Promise.resolve(config), path.join(dir, 'hook-bridge.cjs'))).toBe(false);
      await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recognizes and replaces the standalone bridge subcommand during reinstall', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-codex-hooks-sea-'));
    const file = path.join(dir, 'hooks.json');
    const bridge = path.join(dir, 'hook-bridge.cjs');
    await writeFile(file, JSON.stringify({
      hooks: {
        PermissionRequest: [{
          hooks: [{ type: 'command', command: codexHookCommand(bridge, true), timeout: 60 }],
        }],
      },
    }));
    try {
      expect(codexHookCommand(bridge, true)).toBe(`"${process.execPath}" hook-bridge codex`);
      expect(await installCodexHooks(file, Promise.resolve(config), bridge)).toBe(true);
      const settings = JSON.parse(await readFile(file, 'utf8'));
      expect(settings.hooks.PermissionRequest).toHaveLength(1);
      expect(settings.hooks.PermissionRequest[0].hooks).toEqual([{
        type: 'command',
        command: codexHookCommand(bridge, false),
        timeout: 105,
      }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
