import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession } from '@agent-hub/shared';
import type { Collector, EmitSession } from '../src/collectors/types';
import { ApprovalBroker, hookDecisionBody, summarizeToolRequest } from '../src/approvals';
import { approvalHookTimeout, installClaudeHooks } from '../src/claude-hooks';
import { NtfyNotifier, ntfyMessage, sessionDeepLink, sessionNotificationSequence } from '../src/notifications';
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
    expect(summarizeToolRequest('AskUserQuestion', {
      questions: [{ question: 'Which framework?', header: 'Framework', options: [{ label: 'React', description: 'UI' }] }],
    })).toEqual({
      summary: 'Claude has a question: Which framework?',
      questions: [{ question: 'Which framework?', header: 'Framework', options: [{ label: 'React', description: 'UI' }] }],
    });
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
      await expect(first.outcome).resolves.toMatchObject({ outcome: 'allow', toolName: 'Bash', input: { command: 'ls' } });
      expect(broker.pending('s1')).toEqual([]);
      expect(broker.decide('s1', undefined, 'allow')).toBe('none');

      const bash = broker.hold('s1', 'Bash', { command: 'npm test' }, 1000);
      const write = broker.hold('s1', 'Write', { file_path: 'result.txt' }, 1000);
      expect(broker.pending('s1')).toHaveLength(2);
      expect(broker.decide('s1', write.approval.id, 'deny')).toBe('ok');
      await expect(write.outcome).resolves.toMatchObject({ outcome: 'deny' });
      expect(broker.pending('s1').map((item) => item.toolName)).toEqual(['Bash']);
      broker.cancelSession('s1', { name: 'Edit' });
      expect(broker.pending('s1')).toHaveLength(1);
      const second = broker.hold('s1', 'Bash', { command: 'git status' }, 1000);
      broker.cancelSession('s1', { name: 'Bash', input: { command: 'git status' } });
      await expect(second.outcome).resolves.toMatchObject({ outcome: 'cancelled' });
      expect(broker.pending('s1').map((item) => item.summary)).toEqual(['Run: npm test']);
      const third = broker.hold('s1', 'Bash', { command: 'git log' }, 1000);
      broker.cancelSession('s1', { name: 'Bash' });
      expect(broker.pending('s1')).toHaveLength(2);
      broker.cancelSession('s1', { name: 'Bash', input: { command: 'npm test' } });
      await expect(bash.outcome).resolves.toMatchObject({ outcome: 'cancelled' });
      broker.cancelSession('s1', { name: 'Bash' });
      await expect(third.outcome).resolves.toMatchObject({ outcome: 'cancelled' });

      const timed = broker.hold('s2', 'Bash', {}, 1000);
      vi.advanceTimersByTime(1001);
      await expect(timed.outcome).resolves.toMatchObject({ outcome: 'timeout' });
      const input = { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] };
      const question = broker.hold('s3', 'AskUserQuestion', input, 1000);
      const answers = { 'Which?': 'A, B' };
      broker.decide('s3', question.approval.id, 'allow', answers);
      await expect(question.outcome).resolves.toMatchObject({ outcome: 'allow', toolName: 'AskUserQuestion', input, answers });
      expect(changes.filter((id) => id === 's1').length).toBeGreaterThanOrEqual(6);
    } finally { vi.useRealTimers(); }
  });

  it('produces Claude Code decision JSON', () => {
    expect(hookDecisionBody('allow')).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(hookDecisionBody('deny')).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny', message: expect.stringContaining('denied') } } });
    expect(hookDecisionBody('timeout')).toEqual({});
    expect(hookDecisionBody('cancelled')).toEqual({});
    const questionInput = { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] };
    expect(hookDecisionBody('allow', questionInput, { 'Which?': 'A' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { ...questionInput, answers: { 'Which?': 'A' } } },
      },
    });
    const planInput = { plan: 'Ship it', planFilePath: '/tmp/plan.md' };
    expect(hookDecisionBody('allow', planInput)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: planInput },
      },
    });
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
    expect(ntfyMessage(session({ approval })).body).toContain('Claude Code wants to use');
    const question = {
      ...approval,
      toolName: 'AskUserQuestion',
      questions: [{ question: 'Which framework?', options: [{ label: 'React' }] }],
    };
    expect(ntfyMessage(session({ agent: 'codex', approval: question })).title).toBe('Codex has a question — repo');
    expect(ntfyMessage(session({ approval: question })).body).toBe('Which framework?');
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
    await notifier.update(session({ approval, approvals: [approval] }));
    const write = { ...approval, id: 'ap2', toolName: 'Write' };
    await notifier.update(session({ approval, approvals: [approval, write] }));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String((fetchImpl.mock.calls[2] as unknown as [string, RequestInit])[1].body)).toContain('Write');
    await notifier.update(session({ approval, approvals: [approval, write] }));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('publishes a Devin needs-you transition once and clears it when working resumes', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const notifier = new NtfyNotifier({ topic: 't' }, fetchImpl as unknown as typeof fetch);
    const sessionId = 'devin:waiting-session';
    const waiting = session({
      id: sessionId,
      agent: 'devin',
      nativeId: 'waiting-session',
      title: 'Devin session',
      project: 'repo',
      status: 'needs_input',
      updatedAt: new Date().toISOString(),
      lastMessage: 'Waiting for your reply.',
    });
    expect(ntfyMessage(waiting)).toMatchObject({
      title: 'Devin is waiting on you — repo',
      body: 'Waiting for your reply.',
      priority: 'default',
    });

    await notifier.update({ ...waiting, status: 'working' });
    await notifier.update(waiting);
    await notifier.update(waiting);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [publishUrl, publishInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const sequenceId = sessionNotificationSequence(sessionId);
    expect(publishUrl).toBe('https://ntfy.sh/t');
    expect(publishInit.headers).toMatchObject({ 'X-Sequence-ID': sequenceId, Priority: 'default' });

    await notifier.update({ ...waiting, status: 'working', updatedAt: new Date().toISOString() });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [clearUrl, clearInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(clearUrl).toBe(`https://ntfy.sh/t/${sequenceId}/clear`);
    expect(clearInit.method).toBe('PUT');
  });

  it('uses sequence ids and clears disappeared approvals and needs-you alerts without throttling', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const notifier = new NtfyNotifier({ topic: 't' }, fetchImpl as unknown as typeof fetch);
    const approval = { id: 'ap1', toolName: 'Bash', summary: 'Run: ls', requestedAt: new Date().toISOString() };
    const sessionId = 'claude-code:x';
    await notifier.update(session({ status: 'needs_input', id: sessionId }));
    await notifier.update(session({ status: 'needs_input', id: sessionId, approval, approvals: [approval] }));
    await notifier.update(session({ status: 'working', id: sessionId, approvals: [] }));

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls).toHaveLength(4);
    expect(calls[0]![1].headers).toMatchObject({ 'X-Sequence-ID': sessionNotificationSequence(sessionId) });
    expect(calls[1]![1].headers).toMatchObject({ 'X-Sequence-ID': 'ah-ap1' });
    expect(calls[2]).toEqual([expect.stringMatching(/\/ah-ap1\/clear$/), expect.objectContaining({ method: 'PUT' })]);
    expect(calls[3]).toEqual([expect.stringMatching(/\/ah-s-[a-f0-9]{32}\/clear$/), expect.objectContaining({ method: 'PUT' })]);
    expect(sessionNotificationSequence(sessionId)).toBe(`ah-s-${createHash('sha1').update(sessionId).digest('hex').slice(0, 32)}`);
  });

  it('retries failed ntfy clears on a later update and stops retrying after success', async () => {
    const clearUrls: string[] = [];
    let failNextClear = true;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        clearUrls.push(url);
        if (failNextClear) {
          failNextClear = false;
          return new Response(null, { status: 503 });
        }
      }
      return new Response(null, { status: 200 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const notifier = new NtfyNotifier({ topic: 't' }, fetchImpl as unknown as typeof fetch);
      const approval = { id: 'ap-retry', toolName: 'Bash', summary: 'Run: ls', requestedAt: new Date().toISOString() };
      const sessionId = 'claude-code:clear-retry';
      await notifier.update(session({ id: sessionId, status: 'needs_input', approval, approvals: [approval] }));
      await notifier.update(session({ id: sessionId, status: 'needs_input', approvals: [] }));
      expect(clearUrls).toHaveLength(1);

      await notifier.update(session({ id: 'codex:other', agent: 'codex', status: 'working' }));
      expect(clearUrls).toEqual([clearUrls[0], clearUrls[0]]);
      await notifier.update(session({ id: 'codex:another', agent: 'codex', status: 'working' }));
      expect(clearUrls).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not publish a needs-you alert after a newer working update', async () => {
    let clearCalls = 0;
    let releaseRetry: ((response: Response) => void) | undefined;
    const publishedSequences: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        clearCalls += 1;
        if (clearCalls === 1) return new Response(null, { status: 503 });
        if (clearCalls === 2) return new Promise<Response>((resolve) => { releaseRetry = resolve; });
      }
      if (init?.method === 'POST') {
        const headers = init.headers as Record<string, string>;
        publishedSequences.push(headers['X-Sequence-ID']!);
      }
      return new Response(null, { status: 200 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const notifier = new NtfyNotifier({ topic: 't' }, fetchImpl as unknown as typeof fetch);
      const pendingSessionId = 'claude-code:pending-clear';
      const approval = { id: 'ap-slow', toolName: 'Bash', summary: 'Run: ls', requestedAt: new Date().toISOString() };
      await notifier.update(session({ id: pendingSessionId, status: 'needs_input', approval, approvals: [approval] }));
      await notifier.update(session({ id: pendingSessionId, status: 'needs_input', approvals: [] }));

      const overlappingSessionId = 'claude-code:overlap';
      const needsInputUpdate = notifier.update(session({ id: overlappingSessionId, status: 'needs_input' }));
      await vi.waitFor(() => expect(releaseRetry).toBeTypeOf('function'));
      const workingUpdate = notifier.update(session({ id: overlappingSessionId, status: 'working' }));
      releaseRetry!(new Response(null, { status: 200 }));
      await Promise.all([needsInputUpdate, workingUpdate]);

      expect(publishedSequences).not.toContain(sessionNotificationSequence(overlappingSessionId));
    } finally {
      warn.mockRestore();
    }
  });

  it('drops a queued clear when a needs-you sequence becomes live again', async () => {
    vi.useFakeTimers();
    const clearUrls: string[] = [];
    const publishedSequences: string[] = [];
    let failNextClear = true;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        clearUrls.push(url);
        if (failNextClear) {
          failNextClear = false;
          return new Response(null, { status: 503 });
        }
      } else if (init?.method === 'POST') {
        const headers = init.headers as Record<string, string>;
        publishedSequences.push(headers['X-Sequence-ID']!);
      }
      return new Response(null, { status: 200 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const notifier = new NtfyNotifier({ topic: 't' }, fetchImpl as unknown as typeof fetch);
      const sessionId = 'claude-code:live-again';
      const sequenceId = sessionNotificationSequence(sessionId);
      await notifier.update(session({ id: sessionId, status: 'needs_input' }));
      await notifier.update(session({ id: sessionId, status: 'working' }));
      expect(clearUrls).toEqual([expect.stringMatching(new RegExp(`/${sequenceId}/clear$`))]);

      await vi.advanceTimersByTimeAsync(30_001);
      await notifier.update(session({ id: sessionId, status: 'needs_input' }));
      await notifier.update(session({ id: 'codex:unrelated', agent: 'codex', status: 'working' }));

      expect(publishedSequences.filter((id) => id === sequenceId)).toHaveLength(2);
      expect(clearUrls).toHaveLength(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('suppresses old first-seen sessions unless they have a pending approval', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const oldUpdatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const oldNotifier = new NtfyNotifier({ topic: 't' }, fetchImpl as unknown as typeof fetch);
    await oldNotifier.update(session({ status: 'done', updatedAt: oldUpdatedAt }));
    expect(fetchImpl).not.toHaveBeenCalled();

    const freshNotifier = new NtfyNotifier({ topic: 't' }, fetchImpl as unknown as typeof fetch);
    await freshNotifier.update(session({ status: 'done', updatedAt: new Date().toISOString() }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const approval = { id: 'ap-old', toolName: 'Bash', summary: 'Run: ls', requestedAt: oldUpdatedAt };
    const approvalNotifier = new NtfyNotifier({ topic: 't' }, fetchImpl as unknown as typeof fetch);
    await approvalNotifier.update(session({
      status: 'needs_input',
      updatedAt: oldUpdatedAt,
      approval,
      approvals: [approval],
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(String((init.headers as Record<string, string>).Title)).toContain('wants permission');
  });
});

describe('Claude approvals over HTTP', () => {
  it('sends one permission notification for a new PermissionRequest session', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createHub({ ...config, ntfy: { topic: 't' } }, { collectors: [new FakeCollector()], staticDir: '/nonexistent/agent-hub-web' });
    try {
      const hook = runtime.app.inject({ method: 'POST', url: '/hooks/claude?token=test-token', payload: permissionRequest });
      await vi.waitFor(() => expect(runtime.sessions.get('claude-code:perm-1')?.status).toBe('needs_input'));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String((init.headers as Record<string, string>).Title)).toContain('wants permission');

      const list = await runtime.app.inject({ url: '/api/sessions', headers: auth });
      const shown = (list.json() as AgentSession[]).find((item) => item.id === 'claude-code:perm-1');
      const decided = await runtime.app.inject({
        method: 'POST', url: '/api/sessions/claude-code:perm-1/approval', headers: auth,
        payload: { decision: 'allow', approvalId: shown?.approval?.id },
      });
      expect(decided.statusCode).toBe(204);
      expect((await hook).statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      await runtime.close();
      vi.unstubAllGlobals();
    }
  });

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

  it('validates AskUserQuestion answers and returns them with the original input', async () => {
    const runtime = createHub(config, { collectors: [new FakeCollector()], staticDir: '/nonexistent/agent-hub-web' });
    const toolInput = {
      questions: [
        { question: 'Which framework?', header: 'Framework', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: true },
        { question: 'Ship today?', options: [{ label: 'Yes' }, { label: 'No' }] },
      ],
    };
    try {
      const hook = runtime.app.inject({
        method: 'POST',
        url: '/hooks/claude?token=test-token',
        payload: { ...permissionRequest, tool_name: 'AskUserQuestion', tool_input: toolInput },
      });
      await vi.waitFor(() => expect(runtime.sessions.get('claude-code:perm-1')?.status).toBe('needs_input'));
      const list = await runtime.app.inject({ url: '/api/sessions', headers: auth });
      const shown = (list.json() as AgentSession[]).find((item) => item.id === 'claude-code:perm-1');
      expect(shown?.approval).toMatchObject({
        toolName: 'AskUserQuestion',
        summary: 'Claude has a question: Which framework?',
        questions: toolInput.questions,
      });

      const invalid = await runtime.app.inject({
        method: 'POST',
        url: '/api/sessions/claude-code:perm-1/approval',
        headers: auth,
        payload: { decision: 'allow', approvalId: shown?.approval?.id, answers: { 'Which framework?': 'React' } },
      });
      expect(invalid.statusCode).toBe(400);
      const malformed = await runtime.app.inject({
        method: 'POST',
        url: '/api/sessions/claude-code:perm-1/approval',
        headers: auth,
        payload: { decision: 'allow', approvalId: shown?.approval?.id, answers: { 'Which framework?': ['React'] } },
      });
      expect(malformed.statusCode).toBe(400);

      const answers = { 'Which framework?': 'React, Vue', 'Ship today?': 'Yes' };
      const decided = await runtime.app.inject({
        method: 'POST',
        url: '/api/sessions/claude-code:perm-1/approval',
        headers: auth,
        payload: { decision: 'allow', approvalId: shown?.approval?.id, answers },
      });
      expect(decided.statusCode).toBe(204);
      expect((await hook).json()).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow', updatedInput: { ...toolInput, answers } },
        },
      });
    } finally { await runtime.close(); }
  });

  it('cancels a held approval when Claude reports PostToolUse', async () => {
    const send = vi.fn(async () => {});
    const replyRunner = {
      supports: () => true,
      isRunning: () => false,
      failure: () => undefined,
      send,
    };
    const runtime = createHub(config, { collectors: [new FakeCollector()], replyRunner, staticDir: '/nonexistent/agent-hub-web' });
    try {
      const hook = runtime.app.inject({ method: 'POST', url: '/hooks/claude?token=test-token', payload: permissionRequest });
      await vi.waitFor(() => expect(runtime.sessions.get('claude-code:perm-1')?.status).toBe('needs_input'));
      const blockedReply = await runtime.app.inject({
        method: 'POST',
        url: '/api/sessions/claude-code:perm-1/messages',
        headers: auth,
        payload: { text: 'Continue' },
      });
      expect(blockedReply.statusCode).toBe(409);
      expect(blockedReply.json()).toEqual({ error: 'Answer the request in this chat first.' });
      expect(send).not.toHaveBeenCalled();
      const completed = await runtime.app.inject({
        method: 'POST',
        url: '/hooks/claude?token=test-token',
        payload: {
          session_id: 'perm-1',
          hook_event_name: 'PostToolUse',
          cwd: permissionRequest.cwd,
          tool_name: permissionRequest.tool_name,
          tool_input: permissionRequest.tool_input,
        },
      });
      expect(completed.statusCode).toBe(200);
      expect((await hook).json()).toEqual({});
      const list = await runtime.app.inject({ url: '/api/sessions', headers: auth });
      expect((list.json() as AgentSession[]).find((item) => item.id === 'claude-code:perm-1')?.approval).toBeUndefined();
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
      expect(runtime.sessions.get('claude-code:perm-1')?.status).not.toBe('needs_input');

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
        payload: { session_id: 'perm-1', hook_event_name: 'PreToolUse', cwd: '/tmp/project', tool_name: 'Bash', tool_input: permissionRequest.tool_input },
      });
      expect((await held).json()).toEqual({});
      const list = await runtime.app.inject({ url: '/api/sessions', headers: auth });
      expect((list.json() as AgentSession[]).find((item) => item.id === 'claude-code:perm-1')?.approval).toBeUndefined();
    } finally { await runtime.close(); }
  });
});

describe('Codex approvals over HTTP', () => {
  const codexRequest = (sessionId: string) => ({
    session_id: sessionId,
    hook_event_name: 'PermissionRequest',
    cwd: '/tmp/project',
    tool_name: 'Bash',
    tool_input: { command: 'echo Codex approval' },
  });

  it('requires bearer auth and returns allow, deny, and timeout decision bodies', async () => {
    const runtime = createHub({ ...config, approvals: { holdSeconds: 1 } }, {
      collectors: [new FakeCollector()],
      staticDir: '/nonexistent/agent-hub-web',
    });
    try {
      const unauthorized = await runtime.app.inject({
        method: 'POST',
        url: '/hooks/codex?token=test-token',
        payload: codexRequest('codex-unauthorized'),
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(runtime.sessions.has('codex:codex-unauthorized')).toBe(false);

      for (const decision of ['allow', 'deny'] as const) {
        const sessionId = `codex-${decision}`;
        const hook = runtime.app.inject({
          method: 'POST',
          url: '/hooks/codex',
          headers: auth,
          payload: codexRequest(sessionId),
        });
        await vi.waitFor(() => expect(runtime.sessions.get(`codex:${sessionId}`)?.status).toBe('needs_input'));
        const decided = await runtime.app.inject({
          method: 'POST',
          url: `/api/sessions/codex:${sessionId}/approval`,
          headers: auth,
          payload: { decision },
        });
        expect(decided.statusCode).toBe(204);
        const response = await hook;
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(hookDecisionBody(decision));
        expect(runtime.sessions.get(`codex:${sessionId}`)?.status).toBe('working');
      }

      const timeoutHook = runtime.app.inject({
        method: 'POST',
        url: '/hooks/codex',
        headers: auth,
        payload: codexRequest('codex-timeout'),
      });
      await vi.waitFor(() => expect(runtime.sessions.get('codex:codex-timeout')?.status).toBe('needs_input'));
      expect((await timeoutHook).json()).toEqual(hookDecisionBody('timeout'));
      expect(runtime.sessions.get('codex:codex-timeout')?.status).not.toBe('needs_input');
    } finally {
      await runtime.close();
    }
  });

  it('sends one permission notification for a new Codex PermissionRequest', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createHub({ ...config, ntfy: { topic: 't' } }, {
      collectors: [new FakeCollector()],
      staticDir: '/nonexistent/agent-hub-web',
    });
    try {
      const hook = runtime.app.inject({
        method: 'POST',
        url: '/hooks/codex',
        headers: auth,
        payload: codexRequest('codex-notification'),
      });
      await vi.waitFor(() => expect(runtime.sessions.get('codex:codex-notification')?.status).toBe('needs_input'));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String((init.headers as Record<string, string>).Title)).toContain('wants permission');

      const decided = await runtime.app.inject({
        method: 'POST',
        url: '/api/sessions/codex:codex-notification/approval',
        headers: auth,
        payload: { decision: 'allow' },
      });
      expect(decided.statusCode).toBe(204);
      expect((await hook).json()).toEqual(hookDecisionBody('allow'));
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      await runtime.close();
      vi.unstubAllGlobals();
    }
  });
});
