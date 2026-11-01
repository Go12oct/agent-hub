import { describe, expect, it } from 'vitest';
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

class FakeLocalReplyRunner implements ReplyRunner {
  onChange?: (sessionId: string) => void;
  running = new Set<string>();
  failures = new Map<string, { error: string; at: string }>();
  sent: Array<{ sessionId: string; text: string }> = [];
  sendError?: Error;
  supports(agent: ReplyAgent): boolean { return agent === 'codex'; }
  isRunning(sessionId: string): boolean { return this.running.has(sessionId); }
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

describe('authenticated HTTP API', () => {
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
    const runtime = createHub(config, { collectors: [collector], staticDir: '/nonexistent/agent-hub-web' });
    collector.emit?.(testSession('devin', 'session-123'));
    try {
      const response = await runtime.app.inject({
        method: 'POST', url: '/api/sessions/devin:session-123/messages',
        headers: { authorization: 'Bearer test-token' }, payload: { text: 'Please add a test' },
      });
      expect(response.statusCode).toBe(204);
      expect(collector.sent).toEqual([{ nativeId: 'session-123', text: 'Please add a test' }]);
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
