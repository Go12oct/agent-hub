import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@agent-hub/shared';
import type { Collector, EmitSession } from '../src/collectors/types';
import { createHub } from '../src/server';

class FakeCollector implements Collector {
  name = 'codex';
  emit?: EmitSession;
  start(emit: EmitSession): void { this.emit = emit; }
  stop(): void {}
  async getMessages(): Promise<[]> { return []; }
}

const config = { token: 'test-token', port: 4747, host: '127.0.0.1', lookbackDays: 7, codexCloud: { enabled: false } };

describe('authenticated HTTP API', () => {
  it('rejects missing auth and accepts Bearer and query-token auth', async () => {
    const runtime = createHub(config, { collectors: [new FakeCollector()], staticDir: '/nonexistent/agent-hub-web' });
    try {
      expect((await runtime.app.inject('/api/sessions')).statusCode).toBe(401);
      expect((await runtime.app.inject({ url: '/api/sessions', headers: { authorization: 'Bearer test-token' } })).statusCode).toBe(200);
      expect((await runtime.app.inject('/api/sessions?token=test-token')).statusCode).toBe(200);
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
        updatedAt: new Date().toISOString(), machine: 'test',
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
