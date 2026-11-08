import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@agent-hub/shared';
import type { EmitSession } from '../src/collectors/types';
import { DevinLocalCollector } from '../src/collectors/devin-local';
import { createHub } from '../src/server';

interface NodeFixture {
  id: number;
  parent?: number;
  createdAt?: number;
  message: Record<string, unknown>;
}

interface SessionFixture {
  id: string;
  title?: string | null;
  workingDirectory?: string;
  createdAt?: number;
  lastActivityAt?: number;
  hidden?: number;
  headId?: number;
  nodes: NodeFixture[];
}

async function makeDatabase(): Promise<{ directory: string; dbPath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-devin-local-'));
  const dbPath = path.join(directory, 'sessions.db');
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      working_directory TEXT,
      backend_type TEXT,
      model TEXT,
      agent_mode TEXT,
      created_at INTEGER,
      last_activity_at INTEGER,
      title TEXT,
      main_chain_id INTEGER,
      hidden INTEGER DEFAULT 0,
      metadata TEXT
    );
    CREATE INDEX sessions_activity_idx ON sessions(last_activity_at DESC);
    CREATE TABLE message_nodes (
      row_id INTEGER PRIMARY KEY,
      session_id TEXT,
      node_id INTEGER,
      parent_node_id INTEGER NULL,
      chat_message TEXT,
      created_at INTEGER,
      metadata TEXT,
      UNIQUE(session_id, node_id)
    );
  `);
  database.close();
  return { directory, dbPath };
}

function insertSession(database: DatabaseSync, fixture: SessionFixture): void {
  const now = Math.floor(Date.now() / 1000);
  const head = fixture.nodes.at(-1);
  database.prepare(`
    INSERT INTO sessions (
      id, working_directory, backend_type, model, agent_mode, created_at,
      last_activity_at, title, main_chain_id, hidden, metadata
    ) VALUES (?, ?, 'local', 'test', 'chat', ?, ?, ?, ?, ?, '{}')
  `).run(
    fixture.id,
    fixture.workingDirectory ?? '/home/devin/project',
    fixture.createdAt ?? now - 3600,
    fixture.lastActivityAt ?? now,
    fixture.title === undefined ? 'Local chat' : fixture.title,
    fixture.headId ?? head?.id ?? null,
    fixture.hidden ?? 0,
  );
  const addNode = database.prepare(`
    INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, '{}')
  `);
  for (const node of fixture.nodes) {
    addNode.run(
      fixture.id,
      node.id,
      node.parent ?? null,
      JSON.stringify(node.message),
      node.createdAt ?? now,
    );
  }
}

class TestDevinLocalCollector extends DevinLocalCollector {
  refresh(): Promise<void> { return this.poll(); }
}

function makeEmitter(sessions: AgentSession[], removed: string[] = []): EmitSession {
  const emit = ((session: AgentSession) => sessions.push(session)) as EmitSession;
  emit.remove = (id) => removed.push(id);
  return emit;
}

const userMessage = (content: unknown, metadata?: Record<string, unknown>) => ({
  role: 'user',
  content,
  ...(metadata ? { metadata } : {}),
});

const assistantMessage = (content: unknown, extra: Record<string, unknown> = {}) => ({
  role: 'assistant',
  content,
  ...extra,
});

describe('Devin Local collector', () => {
  it('maps active and completed sessions, excludes hidden sessions, and remains view-only', async () => {
    const fixture = await makeDatabase();
    const database = new DatabaseSync(fixture.dbPath);
    const now = Math.floor(Date.now() / 1000);
    insertSession(database, {
      id: 'recent-tool',
      workingDirectory: 'C:\\Users\\devin\\repo',
      lastActivityAt: now - 20,
      nodes: [{ id: 1, message: { role: 'tool', content: 'Running tests' } }],
    });
    insertSession(database, {
      id: 'final',
      lastActivityAt: now - 900,
      nodes: [{ id: 1, message: assistantMessage('Finished') }],
    });
    insertSession(database, {
      id: 'stale-tool',
      lastActivityAt: now - 301,
      nodes: [{ id: 1, message: { role: 'tool', content: 'Old tool result' } }],
    });
    insertSession(database, {
      id: 'hidden',
      hidden: 1,
      nodes: [{ id: 1, message: { role: 'tool', content: 'Hidden' } }],
    });
    database.close();

    const collector = new TestDevinLocalCollector(fixture.dbPath);
    const emitted: AgentSession[] = [];
    collector.start(makeEmitter(emitted));
    try {
      await vi.waitFor(() => expect(emitted).toHaveLength(3));
      const byId = new Map(emitted.map((session) => [session.id, session]));
      expect(byId.get('devin-local:recent-tool')).toMatchObject({
        agent: 'devin',
        nativeId: 'recent-tool',
        title: 'Local chat',
        project: 'repo',
        cwd: 'C:\\Users\\devin\\repo',
        status: 'working',
        canReply: false,
      });
      expect(byId.get('devin-local:final')?.status).toBe('done');
      expect(byId.get('devin-local:stale-tool')?.status).toBe('idle');
      expect(byId.has('devin-local:hidden')).toBe(false);
      expect(emitted.every((session) => session.status !== 'needs_input')).toBe(true);
      expect(emitted.every((session) => session.url === undefined)).toBe(true);
    } finally {
      collector.stop();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('skips keepalives and returns only the main chain in chronological order', async () => {
    const fixture = await makeDatabase();
    const database = new DatabaseSync(fixture.dbPath);
    const now = Math.floor(Date.now() / 1000);
    insertSession(database, {
      id: 'chain',
      title: null,
      workingDirectory: 'C:\\Users\\devin\\Projects\\comparison',
      lastActivityAt: now - 20,
      headId: 5,
      nodes: [
        { id: 1, createdAt: now - 50, message: userMessage([{ type: 'text', text: 'Compare ' }, { type: 'text', text: 'these files' }]) },
        { id: 2, parent: 1, createdAt: now - 40, message: assistantMessage('The comparison is complete.') },
        {
          id: 3,
          parent: 2,
          createdAt: now - 30,
          message: userMessage('continue', { telemetry: { source: 'cache_keepalive' } }),
        },
        { id: 4, parent: 3, createdAt: now - 25, message: { role: 'tool', content: 'Tool result' } },
        { id: 5, parent: 4, createdAt: now - 20, message: assistantMessage('', { tool_calls: [{ id: 'tool-1' }] }) },
        { id: 6, parent: 2, createdAt: now - 10, message: userMessage('Branch not on the main chain') },
      ],
    });
    database.close();

    const collector = new TestDevinLocalCollector(fixture.dbPath);
    const emitted: AgentSession[] = [];
    collector.start(makeEmitter(emitted));
    try {
      await vi.waitFor(() => expect(emitted).toHaveLength(1));
      const session = emitted[0]!;
      expect(session).toMatchObject({
        id: 'devin-local:chain',
        title: 'Devin Local session',
        project: 'comparison',
        status: 'working',
        lastMessage: 'The comparison is complete.',
        lastRole: 'assistant',
      });
      await expect(collector.getMessages('chain', 100)).resolves.toEqual([
        { role: 'user', text: 'Compare these files', at: new Date((now - 50) * 1000).toISOString() },
        { role: 'assistant', text: 'The comparison is complete.', at: new Date((now - 40) * 1000).toISOString() },
      ]);
    } finally {
      collector.stop();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('removes a session when it becomes hidden', async () => {
    const fixture = await makeDatabase();
    const database = new DatabaseSync(fixture.dbPath);
    insertSession(database, {
      id: 'hide-me',
      nodes: [{ id: 1, message: assistantMessage('Done') }],
    });
    database.close();

    const collector = new TestDevinLocalCollector(fixture.dbPath);
    const emitted: AgentSession[] = [];
    const removed: string[] = [];
    collector.start(makeEmitter(emitted, removed));
    try {
      await vi.waitFor(() => expect(emitted).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const update = new DatabaseSync(fixture.dbPath);
      update.prepare('UPDATE sessions SET hidden = 1 WHERE id = ?').run('hide-me');
      update.close();
      await collector.refresh();
      expect(removed).toEqual(['devin-local:hide-me']);
    } finally {
      collector.stop();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('logs a missing database once and emits no sessions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-devin-local-missing-'));
    const collector = new TestDevinLocalCollector(path.join(directory, 'missing.db'));
    const emitted: AgentSession[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    collector.start(makeEmitter(emitted));
    try {
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      await expect(collector.refresh()).resolves.toBeUndefined();
      expect(emitted).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      collector.stop();
      warn.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('routes local Devin chats to their collector and keeps them view-only', async () => {
    const fixture = await makeDatabase();
    const database = new DatabaseSync(fixture.dbPath);
    insertSession(database, {
      id: 'route-me',
      nodes: [
        { id: 1, message: userMessage('Question') },
        { id: 2, parent: 1, message: assistantMessage('Answer') },
      ],
    });
    database.close();

    const collector = new TestDevinLocalCollector(fixture.dbPath);
    const runtime = createHub({
      token: 'devin-local-test',
      port: 4747,
      host: '127.0.0.1',
      lookbackDays: 7,
      codexCloud: { enabled: false },
      localReplies: { enabled: false },
      approvals: { enabled: false },
    }, { collectors: [collector], staticDir: '/nonexistent/agent-hub-web' });
    try {
      await vi.waitFor(() => expect(runtime.sessions.has('devin-local:route-me')).toBe(true));
      const headers = { authorization: 'Bearer devin-local-test' };
      const feed = await runtime.app.inject({ method: 'GET', url: '/api/sessions', headers });
      expect(feed.json()[0]).toMatchObject({ id: 'devin-local:route-me', canReply: false });
      const messages = await runtime.app.inject({
        method: 'GET',
        url: `/api/sessions/${encodeURIComponent('devin-local:route-me')}/messages`,
        headers,
      });
      expect(messages.json()).toEqual([
        { role: 'user', text: 'Question', at: expect.any(String) },
        { role: 'assistant', text: 'Answer', at: expect.any(String) },
      ]);
      const reply = await runtime.app.inject({
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent('devin-local:route-me')}/messages`,
        headers,
        payload: { text: 'No reply support' },
      });
      expect(reply.statusCode).toBe(405);
    } finally {
      await runtime.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
