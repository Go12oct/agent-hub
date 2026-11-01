import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession, SessionMessage } from '@agent-hub/shared';
import type { Collector } from './collectors/types.js';
import { ClaudeCollector, type ClaudeHookPayload } from './collectors/claude.js';
import { CodexCollector } from './collectors/codex.js';
import { AntigravityCollector } from './collectors/antigravity.js';
import { DevinCollector } from './collectors/devin.js';
import { CodexCloudCollector } from './collectors/codex-cloud.js';
import type { HubConfig } from './config.js';
import { NtfyNotifier } from './notifications.js';

export interface HubRuntime {
  app: FastifyInstance;
  sessions: Map<string, AgentSession>;
  collectors: Collector[];
  close(): Promise<void>;
}

function authorized(request: any, token: string): boolean {
  const header = request.headers.authorization;
  const supplied = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice(7)
    : typeof request.query?.token === 'string' ? request.query.token : '';
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function lanUrls(port: number): string[] {
  const addresses = new Set<string>();
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const address of interfaces || []) {
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) addresses.add(address.address);
    }
  }
  return [...addresses].map((address) => `http://${address}:${port}`);
}

export function createHub(config: HubConfig, options: { collectors?: Collector[]; staticDir?: string } = {}): HubRuntime {
  const app = Fastify({ logger: false });
  const sessions = new Map<string, AgentSession>();
  const claude = new ClaudeCollector(config.lookbackDays);
  const collectors = options.collectors || [
    new CodexCollector(config.lookbackDays),
    claude,
    new AntigravityCollector(config.lookbackDays),
    ...(config.devinApiKey ? [new DevinCollector(config.devinApiKey)] : []),
    ...(config.codexCloud?.enabled ? [new CodexCloudCollector()] : []),
  ];
  const notifier = new NtfyNotifier(config.ntfy?.topic ? config.ntfy : undefined);
  const eventClients = new Set<{ write: (data: string) => void }>();

  const emit: import('./collectors/types.js').EmitSession = (session) => {
    sessions.set(session.id, session);
    void notifier.update(session);
    const data = JSON.stringify(session);
    for (const client of eventClients) client.write(`event: upsert\ndata: ${data}\n\n`);
  };
  emit.remove = (id) => {
    sessions.delete(id);
    for (const client of eventClients) client.write(`event: remove\ndata: ${JSON.stringify({ id })}\n\n`);
  };
  for (const collector of collectors) {
    collector.start(emit);
  }

  app.register(cors, { origin: true, credentials: false });
  app.get('/health', async () => ({ ok: true }));
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/api/') && !authorized(request, config.token)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    if (request.url.startsWith('/hooks/claude') && !authorized(request, config.token)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });
  app.get('/api/sessions', async () => [...sessions.values()].sort((a, b) => {
    const rank = (status: AgentSession['status']) => status === 'needs_input' ? 0 : status === 'working' ? 1 : 2;
    return rank(a.status) - rank(b.status) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  }));
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/sessions/:id/messages', async (request, reply) => {
    const id = request.params.id;
    const session = sessions.get(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const collector = collectors.find((item) => item.name === session.agent);
    const limit = Math.max(1, Math.min(100, Number(request.query.limit) || 30));
    const messages: SessionMessage[] = collector ? await collector.getMessages(session.nativeId, limit) : [];
    return messages;
  });
  app.get('/api/pair', async () => ({
    urls: lanUrls(config.port),
    token: config.token,
  }));
  app.get('/api/events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const client = { write: (data: string) => reply.raw.write(data) };
    eventClients.add(client);
    client.write(`event: snapshot\ndata: ${JSON.stringify([...sessions.values()])}\n\n`);
    const heartbeat = setInterval(() => client.write(': heartbeat\n\n'), 20_000);
    reply.raw.on('close', () => {
      clearInterval(heartbeat);
      eventClients.delete(client);
    });
  });
  app.post<{ Body: Record<string, unknown> }>('/hooks/claude', async (request) => {
    await claude.applyHook((request.body || {}) as ClaudeHookPayload, emit);
    return { ok: true };
  });
  const staticCandidates = [
    path.join(path.dirname(path.resolve(process.argv[1] || process.execPath)), 'public'),
    path.join(path.dirname(process.execPath), 'public'),
    path.resolve(process.cwd(), 'daemon', 'public'),
  ];
  const staticDir = options.staticDir || staticCandidates.find((candidate) => existsSync(candidate));
  if (staticDir && existsSync(staticDir)) {
    app.register(fastifyStatic, { root: staticDir, prefix: '/' });
    app.setNotFoundHandler(async (_request, reply) => reply.sendFile('index.html'));
  }
  return {
    app,
    sessions,
    collectors,
    async close() {
      await Promise.all(collectors.map((collector) => Promise.resolve(collector.stop())));
      await app.close();
    },
  };
}

export async function startServer(config: HubConfig): Promise<HubRuntime> {
  const runtime = createHub(config);
  await runtime.app.listen({ host: config.host, port: config.port });
  console.log(`Agent Hub listening on ${config.host}:${config.port}`);
  return runtime;
}

export { lanUrls };
