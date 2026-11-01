import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentLabels, type AgentSession, type SessionMessage } from '@agent-hub/shared';
import type { Collector } from './collectors/types.js';
import { ClaudeCollector, type ClaudeHookPayload } from './collectors/claude.js';
import { CodexCollector } from './collectors/codex.js';
import { AntigravityCollector } from './collectors/antigravity.js';
import { DevinCollector } from './collectors/devin.js';
import { CodexCloudCollector } from './collectors/codex-cloud.js';
import type { HubConfig } from './config.js';
import { LocalReplyRunner, ReplyBusyError, ReplyFailedError, type ReplyAgent, type ReplyRunner } from './local-replies.js';
import { NtfyNotifier } from './notifications.js';

export interface HubRuntime {
  app: FastifyInstance;
  sessions: Map<string, AgentSession>;
  collectors: Collector[];
  ready: Promise<void>;
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

export function lanUrls(port: number, networkInterfaces = os.networkInterfaces()): string[] {
  const priorities = new Map<string, { priority: number; order: number }>();
  let order = 0;
  for (const [name, interfaces] of Object.entries(networkInterfaces)) {
    for (const address of interfaces || []) {
      if (address.family !== 'IPv4' || address.internal || address.address.startsWith('169.254.')) continue;
      const [first, second] = address.address.split('.').map(Number);
      const tailscale = first === 100 && second !== undefined && second >= 64 && second <= 127;
      const virtualAdapter = /vethernet|virtual|vmware|vbox|virtualbox|hyper-v|wsl|docker|bluetooth|loopback|local area connection\*/i.test(name);
      const hotspotAddress = address.address.startsWith('192.168.137.');
      const preferredAdapter = /wi-?fi|wlan|wireless|^en|^eth|ethernet/i.test(name);
      const priority = tailscale ? 0 : virtualAdapter || hotspotAddress ? 3 : preferredAdapter ? 1 : 2;
      const previous = priorities.get(address.address);
      if (!previous || priority < previous.priority) priorities.set(address.address, { priority, order });
      order += 1;
    }
  }
  return [...priorities.entries()]
    .sort(([, left], [, right]) => left.priority - right.priority || left.order - right.order)
    .map(([address]) => `http://${address}:${port}`);
}

function isReplyAgent(agent: AgentSession['agent']): agent is ReplyAgent {
  return agent === 'codex' || agent === 'claude-code' || agent === 'antigravity';
}

export function createHub(
  config: HubConfig,
  options: { collectors?: Collector[]; staticDir?: string; replyRunner?: ReplyRunner } = {},
): HubRuntime {
  const app = Fastify({ logger: false });
  const sessions = new Map<string, AgentSession>();
  const claude = new ClaudeCollector(config.lookbackDays);
  const collectors: Collector[] = options.collectors || [
    new CodexCollector(config.lookbackDays),
    claude,
    new AntigravityCollector(config.lookbackDays),
    ...(config.devinApiKey ? [new DevinCollector(config.devinApiKey)] : []),
    ...(config.codexCloud?.enabled ? [new CodexCloudCollector()] : []),
  ];
  const replyRunner = options.replyRunner ?? (config.localReplies?.enabled === false ? undefined : new LocalReplyRunner({
    commands: {
      codex: config.localReplies?.codex,
      'claude-code': config.localReplies?.claude,
      antigravity: config.localReplies?.agy,
    },
  }));
  const notifier = new NtfyNotifier(config.ntfy?.topic ? config.ntfy : undefined);
  const eventClients = new Set<{ write: (data: string) => void }>();

  const present = (session: AgentSession): AgentSession => ({
    ...session,
    canReply: session.agent === 'devin'
      ? Boolean(collectors.find((collector) => collector.name === 'devin')?.sendMessage)
      : isReplyAgent(session.agent) && Boolean(replyRunner?.supports(session.agent)),
    status: replyRunner?.isRunning(session.id) ? 'working' : session.status,
  });
  const broadcast = (session: AgentSession) => {
    const data = JSON.stringify(present(session));
    for (const client of eventClients) client.write(`event: upsert\ndata: ${data}\n\n`);
  };
  const emit: import('./collectors/types.js').EmitSession = (session) => {
    sessions.set(session.id, session);
    void notifier.update(session);
    broadcast(session);
  };
  emit.remove = (id) => {
    sessions.delete(id);
    for (const client of eventClients) client.write(`event: remove\ndata: ${JSON.stringify({ id })}\n\n`);
  };
  if (replyRunner) {
    const previousOnChange = replyRunner.onChange;
    replyRunner.onChange = (id) => {
      previousOnChange?.(id);
      const session = sessions.get(id);
      if (session) broadcast(session);
    };
  }
  for (const collector of collectors) {
    collector.start(emit);
  }
  console.log(`Collectors started: ${collectors.map((collector) => collector.name).join(', ')}`);
  const ready = replyRunner?.init
    ? replyRunner.init().then(() => {
      for (const session of sessions.values()) broadcast(session);
    })
    : Promise.resolve();

  app.register(cors, { origin: true, credentials: false });
  app.get<{ Querystring: { nonce?: string } }>('/health', async (request, reply) => {
    const nonce = request.query.nonce;
    if (nonce === undefined) return { ok: true, service: 'agent-hub' };
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(nonce)) {
      return reply.code(400).send({ error: 'Invalid nonce' });
    }
    const proof = createHmac('sha256', config.token).update(nonce).digest('hex');
    return { ok: true, service: 'agent-hub', proof };
  });
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/api/') && !authorized(request, config.token)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    if (request.url.startsWith('/hooks/claude') && !authorized(request, config.token)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });
  app.get('/api/sessions', async () => [...sessions.values()].map(present).sort((a, b) => {
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
  app.post<{ Params: { id: string }; Body: { text?: unknown } }>('/api/sessions/:id/messages', async (request, reply) => {
    const session = sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const collector = collectors.find((item) => item.name === session.agent);
    const isDevinReply = session.agent === 'devin' && Boolean(collector?.sendMessage);
    const isLocalReply = isReplyAgent(session.agent) && Boolean(replyRunner?.supports(session.agent));
    if (!isDevinReply && !isLocalReply) {
      return reply.code(405).send({ error: 'Replies are not supported for this agent' });
    }
    const text = request.body?.text;
    if (typeof text !== 'string' || text.length < 1 || text.length > 10_000) {
      return reply.code(400).send({ error: 'text must be between 1 and 10000 characters' });
    }
    try {
      if (isDevinReply) {
        await collector!.sendMessage!(session.nativeId, text);
        return reply.code(204).send();
      }
      await replyRunner!.send(session, text);
      return reply.code(202).send({ ok: true });
    } catch (error) {
      if (error instanceof ReplyBusyError) {
        return reply.code(409).send({ error: 'That agent is still working on your last message' });
      }
      if (isDevinReply) return reply.code(502).send({ error: 'Failed to send reply' });
      const tail = error instanceof ReplyFailedError ? error.stderrTail : '';
      return reply.code(502).send({ error: tail || `Failed to start ${agentLabels[session.agent]}` });
    }
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
    client.write(`event: snapshot\ndata: ${JSON.stringify([...sessions.values()].map(present))}\n\n`);
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
    ready,
    async close() {
      await Promise.all(collectors.map((collector) => Promise.resolve(collector.stop())));
      await app.close();
    },
  };
}

export async function startServer(config: HubConfig): Promise<HubRuntime> {
  if (!config.devinApiKey) console.warn('Devin: no API key; run agent-hub config set devinApiKey <key>');
  const runtime = createHub(config);
  await runtime.ready;
  await runtime.app.listen({ host: config.host, port: config.port });
  console.log(`Agent Hub listening on ${config.host}:${config.port}`);
  return runtime;
}
