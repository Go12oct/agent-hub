import os from 'node:os';
import path from 'node:path';
import type { AgentSession, SessionMessage } from '@agent-hub/shared';
import type { Collector, EmitSession } from './types.js';

interface MessageNode {
  node_id: number | string;
  parent_node_id: number | string | null;
  chat_message: string | Record<string, unknown> | null;
  created_at: number | null;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  metadata?: { telemetry?: { source?: unknown } };
}

interface SessionRow {
  id: string;
  working_directory: string | null;
  created_at: number | null;
  last_activity_at: number | null;
  title: string | null;
  main_chain_id: number | string | null;
  head_node_id: number | string | null;
  head_parent_node_id: number | string | null;
  head_chat_message: string | Record<string, unknown> | null;
  head_created_at: number | null;
}

function defaultDatabasePath(): string {
  return path.join(process.env.APPDATA ?? path.join(os.homedir(), '.config'), 'devin', 'cli', 'sessions.db');
}

function isoFromUnixSeconds(value: unknown): string | undefined {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseChatMessage(value: MessageNode['chat_message']): ChatMessage | undefined {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed as ChatMessage : undefined;
    } catch {
      return undefined;
    }
  }
  return value && typeof value === 'object' ? value as ChatMessage : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: string; text: string } => Boolean(part)
      && typeof part === 'object'
      && (part as Record<string, unknown>).type === 'text'
      && typeof (part as Record<string, unknown>).text === 'string')
    .map((part) => part.text)
    .join('');
}

function isKeepalive(message: ChatMessage): boolean {
  return message.role === 'user' && message.metadata?.telemetry?.source === 'cache_keepalive';
}

function sessionMessage(node: MessageNode): SessionMessage | undefined {
  const message = parseChatMessage(node.chat_message);
  if (!message || !['user', 'assistant'].includes(String(message.role)) || isKeepalive(message)) return undefined;
  const text = textFromContent(message.content);
  if (!text.trim()) return undefined;
  const role = message.role as 'user' | 'assistant';
  const at = isoFromUnixSeconds(node.created_at);
  return { role, text, ...(at ? { at } : {}) };
}

function projectName(directory: string | null): string | undefined {
  if (!directory) return undefined;
  const normalized = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized ? path.posix.basename(normalized) : undefined;
}

export class DevinLocalCollector implements Collector {
  name = 'devin-local';
  private emit?: EmitSession;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private warned = false;
  private sessions = new Set<string>();

  constructor(private dbPath = defaultDatabasePath()) {}

  start(emit: EmitSession): void {
    this.emit = emit;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async getMessages(nativeId: string, limit: number): Promise<SessionMessage[]> {
    let database: any;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      database = new DatabaseSync(this.dbPath, { readOnly: true });
      const getNode = database.prepare(
        'SELECT node_id, parent_node_id, chat_message, created_at FROM message_nodes WHERE session_id = ? AND node_id = ?',
      );
      const messages: SessionMessage[] = [];
      let node: MessageNode | undefined = getNode.get(nativeId, this.headNodeId(database, nativeId)) as MessageNode | undefined;
      const visited = new Set<string>();
      for (let count = 0; node && count < 2_000; count++) {
        const nodeId = String(node.node_id);
        if (visited.has(nodeId)) break;
        visited.add(nodeId);
        const message = sessionMessage(node);
        if (message) messages.push(message);
        if (node.parent_node_id == null) break;
        node = getNode.get(nativeId, node.parent_node_id) as MessageNode | undefined;
      }
      return messages.slice(0, Math.max(1, limit)).reverse();
    } catch (error) {
      this.warn(error);
      return [];
    } finally {
      try {
        database?.close();
      } catch (error) {
        this.warn(error);
      }
    }
  }

  protected async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    let database: any;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      database = new DatabaseSync(this.dbPath, { readOnly: true });
      const rows = database.prepare(`
        SELECT
          s.id,
          s.working_directory,
          s.created_at,
          s.last_activity_at,
          s.title,
          s.main_chain_id,
          n.node_id AS head_node_id,
          n.parent_node_id AS head_parent_node_id,
          n.chat_message AS head_chat_message,
          n.created_at AS head_created_at
        FROM sessions AS s
        LEFT JOIN message_nodes AS n
          ON n.session_id = s.id AND n.node_id = s.main_chain_id
        WHERE s.hidden = 0
        ORDER BY s.last_activity_at DESC
        LIMIT 200
      `).all() as SessionRow[];
      const getNode = database.prepare(
        'SELECT node_id, parent_node_id, chat_message, created_at FROM message_nodes WHERE session_id = ? AND node_id = ?',
      );
      const now = Date.now() / 1000;
      const nextSessions = rows.map((row): AgentSession => {
        const head: MessageNode | undefined = row.head_node_id == null ? undefined : {
          node_id: row.head_node_id,
          parent_node_id: row.head_parent_node_id,
          chat_message: row.head_chat_message,
          created_at: row.head_created_at,
        };
        const headMessage = head ? parseChatMessage(head.chat_message) : undefined;
        const age = now - Number(row.last_activity_at);
        const hasToolCalls = Array.isArray(headMessage?.tool_calls) && headMessage.tool_calls.length > 0;
        const status: AgentSession['status'] = headMessage?.role === 'assistant' && !hasToolCalls
          ? 'done'
          : age < 300 ? 'working' : 'idle';
        let lastMessage: SessionMessage | undefined;
        let node = head;
        const visited = new Set<string>();
        for (let count = 0; node && count < 400; count++) {
          const nodeId = String(node.node_id);
          if (visited.has(nodeId)) break;
          visited.add(nodeId);
          lastMessage = sessionMessage(node);
          if (lastMessage) break;
          if (node.parent_node_id == null) break;
          node = getNode.get(row.id, node.parent_node_id) as MessageNode | undefined;
        }
        const startedAt = isoFromUnixSeconds(row.created_at);
        const updatedAt = isoFromUnixSeconds(row.last_activity_at) || startedAt || new Date().toISOString();
        const project = projectName(row.working_directory);
        return {
          id: `devin-local:${row.id}`,
          agent: 'devin',
          nativeId: row.id,
          title: row.title || 'Devin Local session',
          ...(project ? { project } : {}),
          ...(row.working_directory ? { cwd: row.working_directory } : {}),
          status,
          canReply: false,
          ...(lastMessage ? { lastMessage: lastMessage.text.slice(0, 280), lastRole: lastMessage.role } : {}),
          ...(startedAt ? { startedAt } : {}),
          updatedAt,
          machine: os.hostname(),
        };
      });
      database.close();
      database = undefined;
      const active = new Set(nextSessions.map((session) => session.id));
      for (const session of nextSessions) this.emit?.(session);
      for (const id of this.sessions) {
        if (!active.has(id)) this.emit?.remove?.(id);
      }
      this.sessions = active;
    } catch (error) {
      this.warn(error);
    } finally {
      try {
        database?.close();
      } catch (error) {
        this.warn(error);
      }
      this.polling = false;
    }
  }

  private headNodeId(database: any, nativeId: string): number | string | null {
    const row = database.prepare('SELECT main_chain_id FROM sessions WHERE id = ? AND hidden = 0').get(nativeId) as
      | { main_chain_id: number | string | null }
      | undefined;
    return row?.main_chain_id ?? null;
  }

  private warn(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[devin-local] polling unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
