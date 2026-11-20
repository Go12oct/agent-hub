import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import {
  digest, hexKey, hubRoute, maxBody, maxBuffered, maxChunk, maxFrame, maxRequests, registrationPath, routePrefix,
  type ToDaemon, type ToRelay,
} from './protocol.js';

type Pending = { response: ServerResponse; sse: boolean; timeout: NodeJS.Timeout };
type Hub = { ws: WebSocket; tokenHash: Buffer; pending: Map<string, Pending>; alive: boolean };

function send(ws: WebSocket, frame: ToDaemon) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > maxBuffered) ws.terminate();
  else ws.send(JSON.stringify(frame));
}

function fail(response: ServerResponse, status: number) {
  if (response.headersSent) response.destroy();
  else response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: status === 503 ? 'PC is offline' : 'Relay request failed' }));
}

function addressGroup(address: string): string {
  if (isIP(address) !== 6) return address;
  const normalized = new URL(`http://[${address.split('%')[0]}]`).hostname.slice(1, -1);
  const [left = '', right] = normalized.split('::');
  const groups = left ? left.split(':') : [];
  if (right !== undefined) {
    const end = right ? right.split(':') : [];
    groups.push(...Array<string>(8 - groups.length - end.length).fill('0'), ...end);
  }
  if (groups[5] === 'ffff' && groups.slice(0, 5).every((part) => part === '0')) {
    return groups.slice(6).flatMap((part) => {
      const value = Number.parseInt(part, 16);
      return [value >>> 8, value & 255];
    }).join('.');
  }
  return groups.slice(0, 4).join(':');
}

export function createRelay({
  trustProxy = false, maxHubs = 128, allowedHubIds,
}: { trustProxy?: boolean; maxHubs?: number; allowedHubIds?: ReadonlySet<string> } = {}) {
  const hubs = new Map<string, Hub>();
  const limits = new Map<string, number>();
  const hubsByAddress = new Map<string, number>();
  const maxHubsPerAddress = Math.min(8, Math.max(1, maxHubs - 1));
  function clientAddress(request: IncomingMessage): string {
    const forwarded = request.headers['x-agent-hub-client-ip'];
    return addressGroup((trustProxy && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : request.socket.remoteAddress) ?? '');
  }
  function allowed(address: string, upgrade: boolean): boolean {
    const key = `${upgrade}:${address}`;
    const count = (limits.get(key) ?? 0) + 1;
    if (count > (upgrade ? 60 : 600) || (!limits.has(key) && limits.size >= 10_000)) return false;
    limits.set(key, count);
    return true;
  }
  const sockets = new WebSocketServer({ noServer: true, maxPayload: maxFrame, perMessageDeflate: false });
  const server = createServer({ headersTimeout: 10_000, requestTimeout: 15_000, maxHeaderSize: 8192 }, async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Cache-Control', 'no-store, no-transform');
    if (!allowed(clientAddress(request), false)) return fail(response, 429);
    if (request.method === 'GET' && request.url === '/health') return response.end('ok');
    const raw = request.url || '';
    const id = raw.slice(routePrefix.length, routePrefix.length + 64);
    const path = raw.slice(routePrefix.length + 64);
    if (!raw.startsWith(routePrefix) || !hexKey.test(id)) return fail(response, 404);
    if (request.method === 'OPTIONS' && hubRoute(request.headers['access-control-request-method'] || '', path)) {
      return response.writeHead(204).end();
    }
    const method = request.method || '';
    const route = hubRoute(method, path);
    if (!route) return fail(response, 404);
    const sse = route.pathname === '/api/events';
    const hub = hubs.get(id);
    if (!hub || hub.ws.readyState !== WebSocket.OPEN) return fail(response, 503);
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : sse ? route.searchParams.get('token') : null;
    if (!token || token.length > 2048 || !timingSafeEqual(Buffer.from(digest(token), 'hex'), hub.tokenHash)) return fail(response, 401);
    if (hub.pending.size >= maxRequests) return fail(response, 429);
    const requestId = randomUUID();
    const timeout = setTimeout(() => fail(response, 504), 40_000);
    hub.pending.set(requestId, { response, timeout, sse });
    response.once('close', () => {
      clearTimeout(timeout);
      if (hub.pending.delete(requestId)) send(hub.ws, { type: 'cancel', id: requestId });
    });
    let body: string | undefined;
    if (method === 'POST') {
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > maxBody) {
            response.setHeader('Connection', 'close');
            return fail(response, 413);
          }
          chunks.push(chunk);
        }
      } catch { return fail(response, 400); }
      if (size) {
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') return fail(response, 415);
        body = Buffer.concat(chunks).toString('utf8');
        try { JSON.parse(body); } catch { return fail(response, 400); }
      }
    }
    if (response.destroyed || response.writableEnded) return;
    route.searchParams.delete('token');
    send(hub.ws, { type: 'request', id: requestId, method, path: route.pathname + route.search, token, body });
  });
  server.maxConnections = 1024;
  server.on('upgrade', (request, socket, head) => {
    const secret = request.headers.authorization?.slice(7) ?? '';
    const tokenHash = request.headers['x-agent-hub-token-hash'];
    const reject = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const address = clientAddress(request);
    if (!allowed(address, true)) return reject('429 Too Many Requests');
    if (request.url !== registrationPath || !request.headers.authorization?.startsWith('Bearer ') ||
      !hexKey.test(secret) || typeof tokenHash !== 'string' || !hexKey.test(tokenHash)) return reject('401 Unauthorized');
    const id = digest(secret);
    if (allowedHubIds && !allowedHubIds.has(id)) return reject('403 Forbidden');
    if (hubs.has(id)) return reject('409 Conflict');
    if (!allowedHubIds && (hubsByAddress.get(address) ?? 0) >= maxHubsPerAddress) return reject('429 Too Many Requests');
    if (hubs.size >= maxHubs) return reject('503 Service Unavailable');
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const hub: Hub = { ws, tokenHash: Buffer.from(tokenHash, 'hex'), pending: new Map(), alive: true };
      hubs.set(id, hub);
      hubsByAddress.set(address, (hubsByAddress.get(address) ?? 0) + 1);
      ws.on('pong', () => { hub.alive = true; });
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        hubs.delete(id);
        const count = (hubsByAddress.get(address) ?? 1) - 1;
        if (count) hubsByAddress.set(address, count);
        else hubsByAddress.delete(address);
        for (const { response } of hub.pending.values()) fail(response, 503);
      });
      ws.on('message', (raw) => {
        let frame: ToRelay;
        try { frame = JSON.parse(raw.toString()); } catch { return ws.terminate(); }
        const pending = frame && hub.pending.get(frame.id);
        if (!pending) return;
        const { response, sse, timeout } = pending;
        if (response.writableEnded || response.destroyed) return;
        timeout.refresh();
        if (frame.type === 'start' && !response.headersSent && Number.isInteger(frame.status) && frame.status >= 200 && frame.status < 600) {
          const streaming = sse && frame.status === 200;
          response.writeHead(frame.status, { 'Content-Type': streaming ? 'text/event-stream' : 'application/json' });
          if (streaming) response.flushHeaders();
        } else if (frame.type === 'chunk' && response.headersSent && typeof frame.data === 'string' && frame.data.length <= Math.ceil(maxChunk / 3) * 4) {
          if (response.writableLength > maxBuffered) response.destroy();
          else response.write(Buffer.from(frame.data, 'base64'));
        } else if (frame.type === 'end' && response.headersSent) {
          hub.pending.delete(frame.id);
          response.end();
        } else {
          fail(response, 502);
        }
      });
    });
  });
  const heartbeat = setInterval(() => {
    for (const hub of hubs.values()) {
      if (!hub.alive) hub.ws.terminate();
      else { hub.alive = false; hub.ws.ping(); }
    }
  }, 15_000).unref();
  const resetLimits = setInterval(() => limits.clear(), 60_000).unref();
  return {
    server,
    close: () => new Promise<void>((resolve, reject) => {
      clearInterval(heartbeat);
      clearInterval(resetLimits);
      for (const { ws } of hubs.values()) ws.terminate();
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
