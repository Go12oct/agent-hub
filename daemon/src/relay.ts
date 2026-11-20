import { timingSafeEqual } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  digest, hubRoute, maxBody, maxBuffered, maxChunk, maxFrame, maxRequests, registrationPath, routePrefix,
  type ToDaemon, type ToRelay,
} from '../../relay/src/protocol.js';

export interface RelayConfig {
  origin: string;
  secret: string;
}

export function relayBaseUrl(relay: RelayConfig): string {
  return `${relay.origin}${routePrefix}${digest(relay.secret)}`;
}

export function connectRelay(relay: RelayConfig, localOrigin: string, token: string) {
  const endpoint = new URL(registrationPath, relay.origin);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  const tokenHash = Buffer.from(digest(token), 'hex');
  let socket: WebSocket | undefined;
  let retry: NodeJS.Timeout | undefined;
  let closed = false;
  let delay = 1000;

  function connect() {
    const ws = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${relay.secret}`, 'X-Agent-Hub-Token-Hash': tokenHash.toString('hex') },
      handshakeTimeout: 10_000, maxPayload: maxFrame, perMessageDeflate: false,
    });
    socket = ws;
    const requests = new Map<string, AbortController>();
    let heartbeat: NodeJS.Timeout | undefined;
    const send = (frame: ToRelay) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > maxBuffered) ws.terminate();
      else ws.send(JSON.stringify(frame));
    };
    async function forward(frame: Extract<ToDaemon, { type: 'request' }>, route: URL, controller: AbortController) {
      try {
        const response = await fetch(localOrigin + route.pathname + route.search, {
          method: frame.method,
          headers: {
            Authorization: `Bearer ${frame.token}`,
            ...(frame.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: frame.body,
          redirect: 'error',
          signal: controller.signal,
        });
        send({ type: 'start', id: frame.id, status: response.status });
        if (response.body) {
          const reader = response.body.getReader();
          let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (route.pathname !== '/api/events' && total > 8 * 1024 * 1024) throw new Error('Response too large');
            for (let offset = 0; offset < value.length; offset += maxChunk) {
              const data = Buffer.from(value.subarray(offset, offset + maxChunk)).toString('base64');
              send({ type: 'chunk', id: frame.id, data });
            }
          }
        }
        send({ type: 'end', id: frame.id });
      } catch {
        if (!controller.signal.aborted) send({ type: 'error', id: frame.id });
      } finally {
        controller.abort();
        requests.delete(frame.id);
      }
    }
    ws.on('open', () => {
      heartbeat = setTimeout(() => ws.terminate(), 40_000).unref();
      delay = 1000;
    });
    ws.on('ping', () => heartbeat?.refresh());
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      clearTimeout(heartbeat);
      for (const controller of requests.values()) controller.abort();
      if (closed) return;
      retry = setTimeout(connect, delay + Math.random() * delay / 4).unref();
      delay = Math.min(delay * 2, 30_000);
    });
    ws.on('message', (raw) => {
      let frame: ToDaemon;
      try { frame = JSON.parse(raw.toString()); } catch { return ws.terminate(); }
      if (!frame || typeof frame.id !== 'string' || frame.id.length > 64) return;
      if (frame.type === 'cancel') { requests.get(frame.id)?.abort(); return; }
      if (frame.type !== 'request' || requests.has(frame.id)) return;
      const route = typeof frame.path === 'string' && hubRoute(frame.method, frame.path);
      if (!route || requests.size >= maxRequests || typeof frame.token !== 'string' || frame.token.length > 2048 ||
        !timingSafeEqual(Buffer.from(digest(frame.token), 'hex'), tokenHash) ||
        (frame.body !== undefined && (frame.method !== 'POST' || typeof frame.body !== 'string' || Buffer.byteLength(frame.body) > maxBody))) {
        return send({ type: 'error', id: frame.id });
      }
      const controller = new AbortController();
      requests.set(frame.id, controller);
      void forward(frame, route, controller);
    });
  }
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    socket?.terminate();
  };
}
