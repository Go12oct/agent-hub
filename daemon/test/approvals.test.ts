import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession } from '@agent-hub/shared';
import type { Collector, EmitSession } from '../src/collectors/types';
import { ApprovalBroker, hookDecisionBody, summarizeToolRequest } from '../src/approvals';
import { approvalHookTimeout, installClaudeHooks } from '../src/claude-hooks';
import { NtfyNotifier, ntfyMessage, sessionDeepLink } from '../src/notifications';
import { createHub } from '../src/server';

class FakeCollector implements Collector {
  name = 'codex';
  emit?: EmitSession;
  start(emit: EmitSession): void { this.emit = emit; }
  stop(): void {}
  async getMessages(): Promise<[]> { return []; }
}

const config = {
  token: 'test-token', port: 4747, host: '127.0.0.1', lookbackDays: 7,
  codexCloud: { enabled: false }, localReplies: { enabled: false }, approvals: { holdSeconds: 2 },
};
const auth = { authorization: 'Bearer test-token' };
const permissionRequest = {
  session_id: 'perm-1', hook_event_name: 'PermissionRequest', cwd: '/tmp/project',
  tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules', description: 'Remove node_modules' },
};

const session = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: 'claude-code:x', agent: 'claude-code', nativeId: 'x', title: 'Fix tests', project: 'repo', status: 'needs_input',
  canReply: true, updatedAt: new Date().toISOString(), machine: 'pc', ...overrides,
});

describe('approval broker', () => {
  it('summarizes tool requests for the phone', () => {
    expect(summarizeToolRequest('Bash', { command: 'git push', description: 'Push' })).toEqual({ summary: 'Run: git push', detail: 'Push' });
    expect(summarizeToolRequest('Edit', { file_path: '/src/a.ts' }).summary).toBe('Edit /src/a.ts');
    expect(summarizeToolRequest('mcp__db__query', { sql: 'select 1' })).toEqual({ summary: 'Use mcp__db__query', detail: '{"sql":"select 1"}' });
  });

  it('resolves allow and deny, rejects stale ids, holds parallel requests, and times out', async () => {
    vi.useFakeTimers();
    try {
      const broker = new ApprovalBroker();
      const changes: string[] = [];
      broker.onChange = (id) => changes.push(id);
      const first = broker.hold('s1', 'Bash', { command: 'ls' }, 1000);
      expect(broker.pending('s1').map((item) => item.summary)).toEqual(['Run: ls']);
      expect(broker.decide('s1', 'wrong-id', 'allow')).toBe('stale');
      expect(broker.decide('s1', first.approval.id, 'allow')).toBe('ok');
      await expect(first.outcome).resolves.toBe('allow');
      expect(broker.pending('s1')).toEqual([]);
      expect(broker.decide('s1', undefined, 'allow')).toBe('none');

      const bash = broker.hold('s1', 'Bash', { command: 'npm test' }, 1000);
      const write = broker.hold('s1', 'Write', { file_path: 'result.txt' }, 1000);
      expect(broker.pending('s1')).toHaveLength(2);
      expect(broker.decide('s1', write.approval.id, 'deny')).toBe('ok');
      await expect(write.outcome).resolves.toBe('deny');
      expect(broker.pending('s1').map((item) => item.toolName)).toEqual(['Bash']);
      broker.cancelSession('s1', 'Edit');
      expect(broker.pending('s1')).toHaveLength(1);
      broker.cancelSession('s1', 'Bash');
      await expect(bash.outcome).resolves.toBe('cancelled');

      const timed = broker.hold('s2', 'Bash', {}, 1000);
      vi.advanceTimersByTime(1001);
      await expect(timed.outcome).resolves.toBe('timeout');
      expect(changes.filter((id) => id === 's1').length).toBeGreaterThanOrEqual(6);
    } finally { vi.useRealTimers(); }
  });

  it('produces Claude Code decision JSON', () => {
    expect(hookDecisionBody('allow')).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(hookDecisionBody('deny')).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny', message: expect.stringContaining('denied') } } });
    expect(hookDecisionBody('timeout')).toEqual({});
    expect(hookDecisionBody('cancelled')).toEqual({});
  });
});

describe('Claude hook timeout', () => {
  it('gives the PermissionRequest hook more time than the phone hold and upgrades existing entries', async () => {
    expect(approvalHookTimeout({})).toBe(360);
    expect(approvalHookTimeout({ approvals: { holdSeconds: 30 } })).toBe(90);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-hooks-'));
    try {
      const file = path.join(dir, 'settings.json');
      await installClaudeHooks(file, Promise.resolve({ ...config, approvals: undefined }));
      await installClaudeHooks(file, Promise.resolve({ ...config, approvals: { holdSeconds: 120 } }));
      const settings = JSON.parse(await readFile(file, 'utf8'));
      expect(settings.hooks.PermissionRequest).toHaveLength(1);
      expect(settings.hooks.PermissionRequest[0].hooks[0]).toMatchObject({ type: 'http', timeout: 180 });
      expect(settings.hooks.Stop[0].hooks[0].timeout).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('ntfy notifications', () => {
  it('builds a deep link and approval-specific messages', () => {
    expect(sessionDeepLink('claude-code:a/b')).toBe('agenthub://session/claude-code%3Aa%2Fb');
    const approval = { id: 'ap1', toolName: 'Bash', summary: 'Run: rm -rf node_modules', requestedAt: new Date().toISOString() };
    expect(ntfyMessage(session({ approval }))).toMatchObject({ title: 'Claude Code wants permission — repo', priority: 'high' });
    expect(ntfyMessage(session({ approval })).body).not.toContain('rm -rf node_modules');
    expect(ntfyMessage(session({ approval })).body).toContain('Bash');
    expect(ntfyMessage(session({ status: 'done' })).title).toBe('Claude Code finished — repo');
    expect(ntfyMessage(session({ status: 'error' })).title).toBe('Claude Code hit an error — repo');
  });

  it('posts to the topic with a Click header and only on real transitions', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const notifier = new NtfyNotifier({ topic: 'secret topic' }, fetchImpl as unknown as typeof fetch);
    await notifier.update(session({ status: 'working' }));
    await notifier.update(session({ status: 'done' }));
    await notifier.update(session({ status: 'done' }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ntfy.sh/secret%20topic');
    expect(init.headers).toMatchObject({ Click: 'agenthub://session/claude-code%3Ax', Priority: 'default' });
    expect(String((init.headers as Record<string, string>).Title)).toMatch(/^[\x20-\x7E]+$/);

    const approval = { id: 'ap1', toolName: 'Bash', summary: 'Run: ls', requestedAt: new Date().toISOString() };
    await notifier.update(session({ approval }));
    await notifier.update(session({ approval: { ...approval, id: 'ap2' } }));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('Claude approvals over HTTP', () => {
  it('holds the PermissionRequest hook until the phone allows it', async () => {
    const runtime = createHub(config, { collectors: [new FakeCollector()], staticDir: '/nonexistent/agent-hub-web' });
    try {
      const hook = runtime.app.inject({ method: 'POST', url: '/hooks/claude?token=test-token', payload: permissionRequest });
      await vi.waitFor(() => expect(runtime.sessions.get('claude-code:perm-1')?.status).toBe('needs_input'));
      const list = await runtime.app.inject({ url: '/api/sessions', headers: auth });
      const shown = (list.json() as AgentSession[]).find((item) => item.id === 'claude-code:perm-1');
      expect(shown?.approval).toMatchObject({ toolName: 'Bash', summary: 'Run: rm -rf node_modules', detail: 'Remove node_modules' });
      expect(shown?.approvals).toHaveLength(1);
      expect(shown?.lastMessage).toBe('Run: rm -rf node_modules');

      const decided = await runtime.app.inject({
        method: 'POST', url: '/api/sessions/claude-code:perm-1/approval', headers: auth,
        payload: { decision: 'allow', approvalId: shown?.approval?.id },
      });
      expect(decided.statusCode).toBe(204);
      const response = await hook;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
      const after = await runtime.app.inject({ url: '/api/sessions', headers: auth });
      const resumed = (after.json() as AgentSession[]).find((item) => item.id === 'claude-code:perm-1');
      expect(resumed?.approval).toBeUndefined();
      expect(resumed?.status).toBe('working');
    } finally { await runtime.close(); }
  });

  it('returns a deny decision with a message, and 409 once nothing is pending', async () => {
    const runtime = createHub(config, { collectors: [new FakeCollector()], staticDir: '/nonexistent/agent-hub-web' });
    try {
      const hook = runtime.app.inject({ method: 'POST', url: '/hooks/claude?token=test-token', payload: permissionRequest });
      await vi.waitFor(() => expect(runtime.sessions.get('claude-code:perm-1')?.status).toBe('needs_input'));
      const decided = await runtime.app.inject({
        method: 'POST', url: '/api/sessions/claude-code:perm-1/approval', headers: auth, payload: { decision: 'deny' },
      });
      expect(decided.statusCode).toBe(204);
      expect((await hook).json().hookSpecificOutput.decision.behavior).toBe('deny');
      const again = await runtime.app.inject({
        method: 'POST', url: '/api/sessions/claude-code:perm-1/approval', headers: auth, payload: { decision: 'deny' },
      });
      expect(again.statusCode).toBe(409);
    } finally { await runtime.close(); }
  });

  it('validates the decision, requires auth, and falls back to Claude on timeout or a later hook', async () => {
    const runtime = createHub({ ...config, approvals: { holdSeconds: 1 } }, { collectors: [new FakeCollector()], staticDir: '/nonexistent/agent-hub-web' });
    try {
      const hook = runtime.app.inject({ method: 'POST', url: '/hooks/claude?token=test-token', payload: permissionRequest });
      await vi.waitFor(() => expect(runtime.sessions.get('claude-code:perm-1')?.status).toBe('needs_input'));
      expect((await runtime.app.inject({
        method: 'POST', url: '/api/sessions/claude-code:perm-1/approval', payload: { decision: 'allow' },
      })).statusCode).toBe(401);
      expect((await runtime.app.inject({
        method: 'POST', url: '/api/sessions/claude-code:perm-1/approval', headers: auth, payload: { decision: 'maybe' },
      })).statusCode).toBe(400);
      expect((await runtime.app.inject({
        method: 'POST', url: '/api/sessions/claude-code:missing/approval', headers: auth, payload: { decision: 'allow' },
      })).statusCode).toBe(404);
      expect((await hook).json()).toEqual({});

      const held = runtime.app.inject({ method: 'POST', url: '/hooks/claude?token=test-token', payload: permissionRequest });
      await vi.waitFor(() => expect(runtime.sessions.get('claude-code:perm-1')?.status).toBe('needs_input'));
      for (const payload of [
        { session_id: 'perm-1', hook_event_name: 'Notification', cwd: '/tmp/project', notification_type: 'permission_prompt', message: 'Claude needs your permission' },
        { session_id: 'perm-1', hook_event_name: 'SubagentStart', cwd: '/tmp/project' },
        { session_id: 'perm-1', hook_event_name: 'PreToolUse', cwd: '/tmp/project', tool_name: 'Read' },
      ]) {
        await runtime.app.inject({ method: 'POST', url: '/hooks/claude?token=test-token', payload });
      }
      const still = await runtime.app.inject({ url: '/api/sessions', headers: auth });
      expect((still.json() as AgentSession[]).find((item) => item.id === 'claude-code:perm-1')?.approval?.toolName).toBe('Bash');
      await runtime.app.inject({
        method: 'POST', url: '/hooks/claude?token=test-token',
        payload: { session_id: 'perm-1', hook_event_name: 'PreToolUse', cwd: '/tmp/project', tool_name: 'Bash' },
      });
      expect((await held).json()).toEqual({});
      const list = await runtime.app.inject({ url: '/api/sessions', headers: auth });
      expect((list.json() as AgentSession[]).find((item) => item.id === 'claude-code:perm-1')?.approval).toBeUndefined();
    } finally { await runtime.close(); }
  });
});
