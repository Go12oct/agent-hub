import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession } from '@agent-hub/shared';
import type { Collector, EmitSession } from '../src/collectors/types';
import {
  LocalReplyRunner, ReplyBusyError, ReplyFailedError, type ReplyAgent, type ReplyRunner,
} from '../src/local-replies';
import { createHub } from '../src/server';

class FakeCollector implements Collector {
  name = 'codex';
  emit?: EmitSession;
  start(emit: EmitSession): void { this.emit = emit; }
  stop(): void {}
  async getMessages(): Promise<[]> { return []; }
}

class ReplyCollector extends FakeCollector {
  name = 'devin';
  sent: Array<{ nativeId: string; text: string }> = [];
  async sendMessage(nativeId: string, text: string): Promise<void> {
    this.sent.push({ nativeId, text });
  }
}

class FailingReplyCollector extends ReplyCollector {
  async sendMessage(_nativeId: string, _text: string): Promise<void> {
    throw new Error('Devin unavailable');
  }
}

class DevinLocalReplyCollector extends FakeCollector {
  name = 'devin-local';
}

class FakeLocalReplyRunner implements ReplyRunner {
  onChange?: (sessionId: string) => void;
  running = new Set<string>();
  failures = new Map<string, { error: string; at: string }>();
  sent: Array<{ sessionId: string; text: string }> = [];
  sendError?: Error;
  supports(agent: ReplyAgent): boolean { return agent === 'codex' || agent === 'devin'; }
  canReplyTo(session: AgentSession): boolean {
    return session.agent === 'devin'
      ? session.id.startsWith('devin-local:') && this.supports('devin')
      : session.agent === 'codex' && this.supports('codex');
  }
  isRunning(sessionId: string): boolean { return this.running.has(sessionId); }
  canStop(sessionId: string): boolean { return this.running.has(sessionId); }
  stop(sessionId: string): boolean { return this.running.delete(sessionId); }
  failure(sessionId: string): { error: string; at: string } | undefined { return this.failures.get(sessionId); }
  async send(session: AgentSession, text: string): Promise<void> {
    if (this.running.has(session.id)) throw new ReplyBusyError();
    if (this.sendError) throw this.sendError;
    this.failures.delete(session.id);
    this.sent.push({ sessionId: session.id, text });
    this.running.add(session.id);
    this.onChange?.(session.id);
  }
}

const config = {
  token: 'test-token',
  port: 4747,
  host: '127.0.0.1',
  lookbackDays: 7,
  codexCloud: { enabled: false },
  localReplies: { enabled: false },
};

function testSession(agent: AgentSession['agent'], nativeId: string): AgentSession {
  return {
    id: `${agent}:${nativeId}`, agent, nativeId, title: 'Test', status: 'working',
    canReply: agent === 'devin', updatedAt: new Date().toISOString(), machine: 'test',
  };
}

function devinLocalSession(nativeId: string): AgentSession {
  return {
    ...testSession('devin', nativeId),
    id: `devin-local:${nativeId}`,
    cwd: process.cwd(),
    status: 'done',
    canReply: false,
  };
}

describe('authenticated HTTP API', () => {
  it('starts Devin v3 listing from PAT and organization credentials without a v1 API key', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({
        items: [{
          session_id: 'devin-abc123',
          title: 'PAT-only session',
          status: 'running',
          status_detail: 'working',
        }],
        end_cursor: null,
        has_next_page: false,
        total: 1,
      }));
    };
    vi.stubGlobal('fetch', fetcher);
    const runtime = createHub({
      ...config,
      devinPat: 'fake-pat',
      devinOrgId: 'org-123',
    }, { staticDir: '/nonexistent/agent-hub-web' });
    try {
      expect(runtime.collectors.some((collector) => collector.name === 'devin')).toBe(true);
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]?.url).toBe('https://api.devin.ai/v3/organizations/org-123/sessions?first=100');
      expect(requests[0]?.init?.headers).toMatchObject({ Authorization: 'Bearer fake-pat' });
      await vi.waitFor(async () => {
        const response = await runtime.app.inject({
          url: '/api/sessions',
          headers: { authorization: 'Bearer test-token' },
        });
        expect(response.json()).toContainEqual(expect.objectContaining({
          id: 'devin:devin-abc123',
          canReply: false,
        }));
      });
      const reply = await runtime.app.inject({
        method: 'POST',
        url: '/api/sessions/devin:devin-abc123/messages',
        headers: { authorization: 'Bearer test-token' },
        payload: { text: 'Reply' },
      });
      expect(reply.statusCode).toBe(405);
      expect(requests.map((request) => request.url)).toEqual([
        'https://api.devin.ai/v3/organizations/org-123/sessions?first=100',
      ]);
    } finally {
      await runtime.close();
      vi.unstubAllGlobals();
    }
  });

  it('proves hub identity with a nonce and rejects invalid nonces', async () => {
    const runtime = createHub(config, { collectors: [new FakeCollector()], staticDir: '/nonexistent/agent-hub-web' });
    try {
      const nonce = 'pairing_nonce-123';
      const response = await runtime.app.inject(`/health?nonce=${nonce}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        service: 'agent-hub',
        proof: createHmac('sha256', config.token).update(nonce).digest('hex'),
      });
      expect((await runtime.app.inject('/health?nonce=not%20valid')).statusCode).toBe(400);
    } finally { await runtime.close(); }
  });

  it('rejects missing auth and accepts Bearer and query-token auth', async () => {
    const runtime = createHub(config, { collectors: [new FakeCollector()], staticDir: '/nonexistent/agent-hub-web' });
    try {
      expect((await runtime.app.inject('/api/sessions')).statusCode).toBe(401);
      expect((await runtime.app.inject({
        method: 'POST', url: '/api/sessions/missing/messages', payload: { text: 'Reply' },
      })).statusCode).toBe(401);
      expect((await runtime.app.inject({ url: '/api/sessions', headers: { authorization: 'Bearer test-token' } })).statusCode).toBe(200);
      expect((await runtime.app.inject('/api/sessions?token=test-token')).statusCode).toBe(200);
    } finally { await runtime.close(); }
  });

  it('requires authentication to shut down the daemon', async () => {
    const runtime = createHub(config, { collectors: [new FakeCollector()], staticDir: '/nonexistent/agent-hub-web' });
    try {
      expect((await runtime.app.inject({ method: 'POST', url: '/api/shutdown' })).statusCode).toBe(401);
      const remote = await runtime.app.inject({
        method: 'POST',
        url: '/api/shutdown',
        headers: { authorization: 'Bearer test-token' },
        remoteAddress: '192.0.2.10',
      });
      expect(remote.statusCode).toBe(403);
      const response = await runtime.app.inject({
        method: 'POST',
        url: '/api/shutdown',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ ok: true });
    } finally { await runtime.close(); }
  });

  it('closes open SSE clients before closing the server', async () => {
    const runtime = createHub(config, { collectors: [new FakeCollector()], staticDir: '/nonexistent/agent-hub-web' });
    const address = await runtime.app.listen({ host: '127.0.0.1', port: 0 });
    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await fetch(`${address}/api/events?token=test-token`, { signal: abort.signal });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: snapshot');
      await Promise.race([
        runtime.close(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('runtime close timed out with an open SSE client')), 2_000);
        }),
      ]);
      expect((await reader.read()).done).toBe(true);
    } finally {
      if (timeout) clearTimeout(timeout);
      abort.abort();
      await runtime.close();
    }
  });

  it('returns 404 for unknown sessions and 405 when replies are unsupported', async () => {
    const collector = new FakeCollector();
    const runtime = createHub(config, { collectors: [collector], staticDir: '/nonexistent/agent-hub-web' });
    collector.emit?.(testSession('codex', 'existing'));
    try {
      const unknown = await runtime.app.inject({
        method: 'POST', url: '/api/sessions/codex:unknown/messages',
        headers: { authorization: 'Bearer test-token' }, payload: { text: 'Reply' },
      });
      const unsupported = await runtime.app.inject({
        method: 'POST', url: '/api/sessions/codex:existing/messages',
        headers: { authorization: 'Bearer test-token' }, payload: { text: 'Reply' },
      });
      expect(unknown.statusCode).toBe(404);
      expect(unsupported.statusCode).toBe(405);
      expect(unsupported.json()).toEqual({ error: 'Replies are not supported for this agent' });
    } finally { await runtime.close(); }
  });

  it('only allows Antigravity replies for chats in the agy CLI store', async () => {
    const previousHome = process.env.AGENT_HUB_HOME;
    const home = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-antigravity-api-'));
    process.env.AGENT_HUB_HOME = home;
    const cliHome = path.join(home, '.gemini', 'antigravity-cli');
    const collector = new FakeCollector();
    const replyRunner = new LocalReplyRunner({
      commands: { antigravity: 'agy' },
      resolve: async () => undefined,
    });
    let runtime: ReturnType<typeof createHub> | undefined;

    try {
      await mkdir(path.join(cliHome, 'conversations'), { recursive: true });
      await writeFile(path.join(cliHome, 'conversations', 'cli-created.db'), '');
      await mkdir(path.join(home, '.gemini', 'antigravity', 'conversations'), { recursive: true });
      await writeFile(path.join(home, '.gemini', 'antigravity', 'conversations', 'ide-only.db'), '');

      runtime = createHub(config, {
        collectors: [collector],
        replyRunner,
        staticDir: '/nonexistent/agent-hub-web',
      });
      collector.emit?.(testSession('antigravity', 'cli-created'));
      collector.emit?.(testSession('antigravity', 'ide-only'));
      await runtime.ready;

      const sessions = await runtime.app.inject({
        url: '/api/sessions',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(sessions.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'antigravity:cli-created', canReply: true }),
        expect.objectContaining({ id: 'antigravity:ide-only', canReply: false }),
      ]));

      const response = await runtime.app.inject({
        method: 'POST',
        url: '/api/sessions/antigravity:ide-only/messages',
        headers: { authorization: 'Bearer test-token' },
        payload: { text: 'Continue this chat' },
      });
      expect(response.statusCode).toBe(405);
      expect(response.json()).toEqual({
        error: 'Antigravity can only continue chats started with the agy CLI',
      });
      await expect(replyRunner.send(testSession('antigravity', 'ide-only'), 'Continue this chat'))
        .rejects.toMatchObject({
          name: 'ReplyFailedError',
          message: 'Antigravity can only continue chats started with the agy CLI',
        });
    } finally {
      if (runtime) await runtime.close();
      if (previousHome === undefined) delete process.env.AGENT_HUB_HOME;
      else process.env.AGENT_HUB_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('sends a supported reply and returns 204', async () => {
    const collector = new ReplyCollector();
    const replyRunner = new FakeLocalReplyRunner();
    const runtime = createHub(config, {
      collectors: [collector],
      replyRunner,
      staticDir: '/nonexistent/agent-hub-web',
    });
    collector.emit?.(testSession('devin', 'session-123'));
    try {
      const sessions = await runtime.app.inject({
        url: '/api/sessions',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(sessions.json()).toEqual([
        expect.objectContaining({ id: 'devin:session-123', canReply: true }),
      ]);
      const response = await runtime.app.inject({
        method: 'POST', url: '/api/sessions/devin:session-123/messages',
        headers: { authorization: 'Bearer test-token' }, payload: { text: 'Please add a test' },
      });
      expect(response.statusCode).toBe(204);
      expect(collector.sent).toEqual([{ nativeId: 'session-123', text: 'Please add a test' }]);
      expect(replyRunner.sent).toEqual([]);
    } finally { await runtime.close(); }
  });

  it('presents Devin Local reply capability, routes replies locally, and stops them', async () => {
    const collector = new DevinLocalReplyCollector();
    const replyRunner = new FakeLocalReplyRunner();
    const runtime = createHub(config, {
      collectors: [collector],
      replyRunner,
      staticDir: '/nonexistent/agent-hub-web',
    });
    collector.emit?.({ ...devinLocalSession('glaze-spark'), replyRunning: true });
    try {
      const headers = { authorization: 'Bearer test-token' };
      const sessions = await runtime.app.inject({ url: '/api/sessions', headers });
      expect(sessions.json()).toEqual([
        expect.objectContaining({ id: 'devin-local:glaze-spark', canReply: true }),
      ]);
      expect(sessions.json()[0]).not.toHaveProperty('replyRunning');
      const response = await runtime.app.inject({
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent('devin-local:glaze-spark')}/messages`,
        headers,
        payload: { text: 'Please add a test' },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ ok: true });
      expect(replyRunner.sent).toEqual([
        { sessionId: 'devin-local:glaze-spark', text: 'Please add a test' },
      ]);
      const running = await runtime.app.inject({ url: '/api/sessions', headers });
      expect(running.json()).toEqual([
        expect.objectContaining({
          id: 'devin-local:glaze-spark',
          canReply: true,
          replyRunning: true,
          status: 'working',
        }),
      ]);
      const stopped = await runtime.app.inject({
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent('devin-local:glaze-spark')}/reply/stop`,
        headers,
      });
      expect(stopped.statusCode).toBe(200);
      expect(stopped.json()).toEqual({ stopped: true });
      const noLongerRunning = await runtime.app.inject({ url: '/api/sessions', headers });
      expect(noLongerRunning.json()[0]).not.toHaveProperty('replyRunning');
      const nothingRunning = await runtime.app.inject({
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent('devin-local:glaze-spark')}/reply/stop`,
        headers,
      });
      expect(nothingRunning.statusCode).toBe(409);
      expect(nothingRunning.json()).toEqual({ error: 'Nothing is running in this chat' });
      const unknown = await runtime.app.inject({
        method: 'POST',
        url: '/api/sessions/devin-local%3Aunknown/reply/stop',
        headers,
      });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toEqual({ error: 'Session not found' });
    } finally { await runtime.close(); }
  });

  it('returns 409 when a session has no reply runner to stop', async () => {
    const collector = new DevinLocalReplyCollector();
    const runtime = createHub(config, {
      collectors: [collector],
      staticDir: '/nonexistent/agent-hub-web',
    });
    collector.emit?.(devinLocalSession('glaze-spark'));
    try {
      const response = await runtime.app.inject({
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent('devin-local:glaze-spark')}/reply/stop`,
        headers: { authorization: 'Bearer test-token' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'Nothing is running in this chat' });
    } finally { await runtime.close(); }
  });

  it('starts local replies with 202 and presents their capability and running status', async () => {
    const collector = new FakeCollector();
    const replyRunner = new FakeLocalReplyRunner();
    const runtime = createHub(config, {
      collectors: [collector],
      replyRunner,
      staticDir: '/nonexistent/agent-hub-web',
    });
    collector.emit?.({ ...testSession('codex', 'session-123'), status: 'done' });
    try {
      const response = await runtime.app.inject({
        method: 'POST',
        url: '/api/sessions/codex:session-123/messages',
        headers: { authorization: 'Bearer test-token' },
        payload: { text: 'Run the tests' },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ ok: true });
      expect(replyRunner.sent).toEqual([{ sessionId: 'codex:session-123', text: 'Run the tests' }]);

      const sessions = await runtime.app.inject({
        url: '/api/sessions',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(sessions.json()).toEqual([
        expect.objectContaining({ id: 'codex:session-123', canReply: true, status: 'working' }),
      ]);

      const busy = await runtime.app.inject({
        method: 'POST',
        url: '/api/sessions/codex:session-123/messages',
        headers: { authorization: 'Bearer test-token' },
        payload: { text: 'Another prompt' },
      });
      expect(busy.statusCode).toBe(409);
      expect(busy.json()).toEqual({ error: 'That agent is still working on your last message' });

      replyRunner.running.delete('codex:session-123');
      replyRunner.failures.set('codex:session-123', {
        error: 'Codex stopped with exit code 7',
        at: new Date().toISOString(),
      });
      replyRunner.onChange?.('codex:session-123');
      const failedSessions = await runtime.app.inject({
        url: '/api/sessions',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(failedSessions.json()).toEqual([
        expect.objectContaining({ id: 'codex:session-123', replyError: 'Codex stopped with exit code 7' }),
      ]);
    } finally { await runtime.close(); }
  });

  it('returns the project-folder error from a local reply failure', async () => {
    const collector = new FakeCollector();
    const replyRunner = new FakeLocalReplyRunner();
    replyRunner.sendError = new ReplyFailedError('', "Couldn't find this chat's project folder");
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createHub(config, {
      collectors: [collector],
      replyRunner,
      staticDir: '/nonexistent/agent-hub-web',
    });
    collector.emit?.(testSession('codex', 'session-123'));
    try {
      const response = await runtime.app.inject({
        method: 'POST',
        url: '/api/sessions/codex:session-123/messages',
        headers: { authorization: 'Bearer test-token' },
        payload: { text: 'Run the tests' },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: "Couldn't find this chat's project folder" });
      expect(warn).toHaveBeenCalledWith("Local reply failed: codex codex:session-123: Couldn't find this chat's project folder");
    } finally { await runtime.close(); warn.mockRestore(); }
  });

  it('cleans hook failure noise from local reply errors returned to the phone', async () => {
    const collector = new FakeCollector();
    const replyRunner = new FakeLocalReplyRunner();
    replyRunner.sendError = new ReplyFailedError(
      '',
      'Error: That session is running in the background (b1c5c281).\nSessionEnd hook [python3 /hook.py] failed: Python was not found',
    );
    const runtime = createHub(config, { collectors: [collector], replyRunner, staticDir: '/nonexistent/agent-hub-web' });
    collector.emit?.(testSession('codex', 'session-123'));
    try {
      const response = await runtime.app.inject({
        method: 'POST',
        url: '/api/sessions/codex:session-123/messages',
        headers: { authorization: 'Bearer test-token' },
        payload: { text: 'Run the tests' },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: 'That session is running in the background (b1c5c281).' });
    } finally { await runtime.close(); }
  });

  it('returns the custom busy message for a background Claude reply as 409', async () => {
    const collector = new FakeCollector();
    const replyRunner: ReplyRunner = {
      supports: (agent) => agent === 'claude-code',
      isRunning: () => false,
      failure: () => undefined,
      send: async () => { throw new ReplyBusyError('Claude is still working on this chat in the background. Send again when it finishes.'); },
    };
    const runtime = createHub(config, {
      collectors: [collector],
      replyRunner,
      staticDir: '/nonexistent/agent-hub-web',
    });
    collector.emit?.(testSession('claude-code', 'claude-session'));
    try {
      const response = await runtime.app.inject({
        method: 'POST',
        url: '/api/sessions/claude-code:claude-session/messages',
        headers: { authorization: 'Bearer test-token' },
        payload: { text: 'Continue' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'Claude is still working on this chat in the background. Send again when it finishes.',
      });
    } finally { await runtime.close(); }
  });

  it('presents background Claude work as working without advertising Stop', async () => {
    const collector = new FakeCollector();
    const replyRunner: ReplyRunner = {
      supports: (agent) => agent === 'claude-code',
      isRunning: () => true,
      canStop: () => false,
      failure: () => undefined,
      send: async () => {},
    };
    const runtime = createHub(config, {
      collectors: [collector],
      replyRunner,
      staticDir: '/nonexistent/agent-hub-web',
    });
    collector.emit?.({ ...testSession('claude-code', 'background-session'), status: 'done' });
    try {
      const sessions = await runtime.app.inject({
        url: '/api/sessions',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(sessions.json()[0]).toMatchObject({
        id: 'claude-code:background-session',
        status: 'working',
      });
      expect(sessions.json()[0]).not.toHaveProperty('replyRunning');
    } finally { await runtime.close(); }
  });

  it('hides a reply failure after newer collector activity', async () => {
    const collector = new FakeCollector();
    const replyRunner = new FakeLocalReplyRunner();
    const runtime = createHub(config, {
      collectors: [collector],
      replyRunner,
      staticDir: '/nonexistent/agent-hub-web',
    });
    collector.emit?.({
      ...testSession('codex', 'session-123'),
      updatedAt: '2025-01-02T00:00:00.000Z',
    });
    replyRunner.failures.set('codex:session-123', {
      error: 'Codex stopped with exit code 7',
      at: '2025-01-01T00:00:00.000Z',
    });
    try {
      const response = await runtime.app.inject({
        url: '/api/sessions',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(response.json()).toHaveLength(1);
      expect(response.json()[0]).not.toHaveProperty('replyError');
    } finally { await runtime.close(); }
  });

  it('returns 400 for invalid reply text and 502 for an upstream failure', async () => {
    const collector = new FailingReplyCollector();
    const runtime = createHub(config, { collectors: [collector], staticDir: '/nonexistent/agent-hub-web' });
    collector.emit?.(testSession('devin', 'session-123'));
    try {
      const invalid = await runtime.app.inject({
        method: 'POST', url: '/api/sessions/devin:session-123/messages',
        headers: { authorization: 'Bearer test-token' }, payload: { text: '' },
      });
      const oversized = await runtime.app.inject({
        method: 'POST', url: '/api/sessions/devin:session-123/messages',
        headers: { authorization: 'Bearer test-token' }, payload: { text: 'x'.repeat(10_001) },
      });
      const failed = await runtime.app.inject({
        method: 'POST', url: '/api/sessions/devin:session-123/messages',
        headers: { authorization: 'Bearer test-token' }, payload: { text: 'Reply' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(oversized.statusCode).toBe(400);
      expect(failed.statusCode).toBe(502);
    } finally { await runtime.close(); }
  });

  it('applies an authenticated Claude Notification hook to the feed', async () => {
    const runtime = createHub(config, { collectors: [new FakeCollector()], staticDir: '/nonexistent/agent-hub-web' });
    try {
      const response = await runtime.app.inject({
        method: 'POST',
        url: '/hooks/claude?token=test-token',
        payload: { session_id: 'hook-test', hook_event_name: 'Notification', cwd: '/tmp/project', message: 'Permission needed' },
      });
      expect(response.statusCode).toBe(200);
      expect(runtime.sessions.get('claude-code:hook-test')).toMatchObject({ status: 'needs_input', project: 'project' });
    } finally { await runtime.close(); }
  });

  it('rejects unauthenticated Claude hooks without changing or creating sessions', async () => {
    const runtime = createHub(config, { collectors: [new FakeCollector()], staticDir: '/nonexistent/agent-hub-web' });
    try {
      const existing = await runtime.app.inject({
        method: 'POST',
        url: '/hooks/claude?token=test-token',
        payload: { session_id: 'existing-hook-test', hook_event_name: 'UserPromptSubmit', cwd: '/tmp/project' },
      });
      expect(existing.statusCode).toBe(200);
      expect(runtime.sessions.get('claude-code:existing-hook-test')?.status).toBe('working');

      const rejectedExisting = await runtime.app.inject({
        method: 'POST',
        url: '/hooks/claude',
        payload: { session_id: 'existing-hook-test', hook_event_name: 'Notification', cwd: '/tmp/project' },
      });
      const rejectedNew = await runtime.app.inject({
        method: 'POST',
        url: '/hooks/claude',
        payload: { session_id: 'new-hook-test', hook_event_name: 'Notification', cwd: '/tmp/project' },
      });

      expect(rejectedExisting.statusCode).toBe(401);
      expect(rejectedNew.statusCode).toBe(401);
      expect(runtime.sessions.get('claude-code:existing-hook-test')?.status).toBe('working');
      expect(runtime.sessions.has('claude-code:new-hook-test')).toBe(false);
      expect(runtime.sessions.size).toBe(1);
    } finally { await runtime.close(); }
  });

  it('streams a snapshot followed by upsert events', async () => {
    const collector = new FakeCollector();
    const runtime = createHub(config, { collectors: [collector], staticDir: '/nonexistent/agent-hub-web' });
    const address = await runtime.app.listen({ host: '127.0.0.1', port: 0 });
    const abort = new AbortController();
    try {
      const response = await fetch(`${address}/api/events?token=test-token`, { signal: abort.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const initial = decoder.decode((await reader.read()).value);
      expect(initial).toContain('event: snapshot');
      const session: AgentSession = {
        id: 'codex:test', agent: 'codex', nativeId: 'test', title: 'Test', status: 'working',
        canReply: false, updatedAt: new Date().toISOString(), machine: 'test',
      };
      collector.emit?.(session);
      const update = decoder.decode((await reader.read()).value);
      expect(update).toContain('event: upsert');
      expect(update).toContain('"id":"codex:test"');
      collector.emit?.remove?.('codex:test');
      const removed = decoder.decode((await reader.read()).value);
      expect(removed).toContain('event: remove');
      expect(removed).toContain('"id":"codex:test"');
      await reader.cancel();
      abort.abort();
    } finally {
      abort.abort();
      await runtime.close();
    }
  });
});
