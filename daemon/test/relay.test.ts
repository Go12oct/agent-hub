import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { AgentSession } from '@agent-hub/shared';
import { digest } from '../../relay/src/protocol';
import { createRelay } from '../../relay/src/server';
import type { EmitSession } from '../src/collectors/types';
import { connectRelay, relayBaseUrl } from '../src/relay';
import { createHub } from '../src/server';

it('admits only configured hubs or enforces concurrent registrations per source', async () => {
  const approved = randomBytes(32).toString('hex');
  for (const allowedHubIds of [undefined, new Set([digest(approved)])]) {
    const relay = createRelay({ allowedHubIds, maxHubs: 2, trustProxy: true });
    try {
      relay.server.listen(0, '127.0.0.1');
      await once(relay.server, 'listening');
      const { port } = relay.server.address() as AddressInfo;
      const connect = (key: string, address: string) => new WebSocket(`ws://127.0.0.1:${port}/connect`, { headers: {
        Authorization: `Bearer ${key}`,
        'X-Agent-Hub-Token-Hash': digest('test'),
        'X-Agent-Hub-Client-IP': address,
      } });

      const first = connect(approved, '2001:db8::1');
      await once(first, 'open');
      const otherKey = randomBytes(32).toString('hex');
      const duplicateSource = connect(otherKey, '2001:db8::2');
      const [error] = await once(duplicateSource, 'error');
      expect(error.message).toContain(allowedHubIds ? '403' : '429');
      if (!allowedHubIds) {
        const other = connect(otherKey, '2001:db8:0:1::1');
        await once(other, 'open');
        first.close();
        await once(first, 'close');
        await once(connect(approved, '2001:db8::3'), 'open');
      }
    } finally { await relay.close(); }
  }
});

it('relays authenticated phone requests and live events and reconnects after a restart', async () => {
  let emit: EmitSession | undefined;
  const sendMessage = vi.fn(async () => {});
  const token = randomBytes(32).toString('hex');
  const hub = createHub({
    host: '127.0.0.1', port: 0, token, lookbackDays: 7, codexCloud: { enabled: false }, localReplies: { enabled: false },
  }, {
    staticDir: '/nonexistent/agent-hub-web',
    collectors: [{ name: 'devin', start: (callback) => { emit = callback; }, stop: () => {}, getMessages: async () => [], sendMessage }],
  });
  let relay = createRelay();
  const abortEvents = new AbortController();
  let stop: (() => void) | undefined;
  try {
    const local = await hub.app.listen({ host: '127.0.0.1', port: 0 });
    relay.server.listen(0, '127.0.0.1');
    await once(relay.server, 'listening');
    const port = (relay.server.address() as AddressInfo).port;
    const config = { origin: `http://127.0.0.1:${port}`, secret: randomBytes(32).toString('hex') };
    const base = relayBaseUrl(config);
    const headers = { Authorization: `Bearer ${token}` };
    const health = () => fetch(`${base}/health?nonce=example`, { headers, signal: AbortSignal.timeout(1000) });
    expect((await health()).status).toBe(503);
    stop = connectRelay(config, local, token);
    await vi.waitFor(async () => {
      const response = await health();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        service: 'agent-hub', proof: createHmac('sha256', token).update('example').digest('hex'),
      });
    });

    expect((await fetch(`${base}/api/sessions`, { headers: { Authorization: 'Bearer bogus' } })).status).toBe(401);
    expect((await fetch(`${base}/api/events?token=bogus`)).status).toBe(401);
    expect((await fetch(`${base}/api/shutdown`, { method: 'POST', headers })).status).toBe(404);
    const preflight = await fetch(`${base}/api/sessions`, { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');

    const session: AgentSession = {
      id: 'devin:test', nativeId: 'test', agent: 'devin', title: 'Remote session',
      status: 'working', updatedAt: new Date().toISOString(), machine: 'test', canReply: true,
    };
    emit!(session);
    const sessions = await fetch(`${base}/api/sessions`, { headers });
    expect(await sessions.json()).toMatchObject([{ id: session.id, title: session.title }]);

    const events = await fetch(`${base}/api/events?token=${token}`, { signal: abortEvents.signal });
    expect(events.headers.get('content-type')).toBe('text/event-stream');
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let feed = '';
    async function readEvent(value: string) {
      while (!feed.includes(value)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Event feed closed before ${value}`);
        feed += decoder.decode(chunk.value, { stream: true });
      }
    }
    await readEvent('event: snapshot');
    emit!({ ...session, status: 'needs_input' });
    await readEvent('event: upsert');
    await readEvent('"status":"needs_input"');
    const post = await fetch(`${base}/api/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Continue' }),
    });
    expect(post.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(session.nativeId, 'Continue');
    await reader.cancel();

    await relay.close();
    relay = createRelay();
    relay.server.listen(port, '127.0.0.1');
    await once(relay.server, 'listening');
    await vi.waitFor(async () => {
      const response = await health();
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }, { timeout: 4000 });
  } finally {
    abortEvents.abort();
    stop?.();
    await Promise.all([relay.close(), hub.close()]);
  }
});
