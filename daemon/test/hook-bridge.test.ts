import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHookBridge } from '../src/hook-bridge';

describe('Codex hook bridge', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    vi.unstubAllEnvs();
  });

  it('forwards the hook with bearer auth and writes a successful JSON response', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-codex-bridge-'));
    await writeFile(path.join(tempDir, 'config.json'), JSON.stringify({
      port: 4747,
      token: 'bridge-token',
      approvals: { holdSeconds: 120 },
    }));
    const payload = JSON.stringify({ session_id: 'codex-session', hook_event_name: 'PermissionRequest' });
    const body = JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    const stdout = { write: vi.fn() };

    await runHookBridge('codex', {
      stdin: Readable.from([payload]),
      stdout,
      configDir: tempDir,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4747/hooks/codex', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer bridge-token', 'Content-Type': 'application/json' },
      body: payload,
      signal: expect.any(AbortSignal),
    }));
    expect(stdout.write).toHaveBeenCalledWith(body);
  });

  it('returns successfully with no output when the daemon is unavailable', async () => {
    vi.stubEnv('AGENT_HUB_PORT', '');
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-codex-bridge-down-'));
    await writeFile(path.join(tempDir, 'config.json'), JSON.stringify({ port: 4747, token: 'bridge-token' }));
    const fetchMock = vi.fn(async () => { throw new Error('connection refused'); });
    const stdout = { write: vi.fn() };

    await expect(runHookBridge('codex', {
      stdin: Readable.from(['{}']),
      stdout,
      configDir: tempDir,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).resolves.toBeUndefined();
    expect(stdout.write).not.toHaveBeenCalled();
  });

  it('prefers a valid AGENT_HUB_PORT over the config file port', async () => {
    vi.stubEnv('AGENT_HUB_PORT', '4750');
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-codex-bridge-port-'));
    await writeFile(path.join(tempDir, 'config.json'), JSON.stringify({ port: 4747, token: 'bridge-token' }));
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));

    await runHookBridge('codex', {
      stdin: Readable.from(['{}']),
      stdout: { write: vi.fn() },
      configDir: tempDir,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4750/hooks/codex', expect.any(Object));
  });

  it('rejects an invalid AGENT_HUB_PORT instead of using the config file port', async () => {
    vi.stubEnv('AGENT_HUB_PORT', '70000');
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-codex-bridge-invalid-port-'));
    await writeFile(path.join(tempDir, 'config.json'), JSON.stringify({ port: 4747, token: 'bridge-token' }));
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const stdout = { write: vi.fn() };

    await runHookBridge('codex', {
      stdin: Readable.from(['{}']),
      stdout,
      configDir: tempDir,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdout.write).not.toHaveBeenCalled();
  });
});
