import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession, PendingApproval, SessionMessage, SessionStatus } from '@agent-hub/shared';
import type { Collector, EmitSession } from './types.js';
import { projectName } from './files.js';
import { readDevinDesktopCards } from './devin-desktop-cards.js';

export function parseDevinMessages(rows: unknown): SessionMessage[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((value): SessionMessage[] => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    const text = [row.message, row.content, row.text]
      .find((candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()));
    if (!text) return [];
    const role = row.type === 'user_message' || (row.type !== 'devin_message' && row.role === 'user') ? 'user'
      : row.type === 'devin_message' || (row.type !== 'user_message' && ['assistant', 'devin'].includes(String(row.role))) ? 'assistant'
        : 'tool';
    const timestamp = row.timestamp || row.created_at;
    const at = typeof timestamp === 'string' && timestamp ? timestamp : undefined;
    return [{ role, text: text.slice(0, 20_000), ...(at ? { at } : {}) }];
  });
}

interface CachedDevinMessages {
  updatedAt: string;
  messages: SessionMessage[];
}

interface DevinDesktopCardsOptions {
  dir?: string;
  platform?: NodeJS.Platform;
  readCards?: typeof readDevinDesktopCards;
}

function desktopSessionKeys(session: AgentSession): string[] {
  const keys = new Set<string>();
  const add = (value: string | undefined) => {
    const key = value?.replace(/^devin-/i, '').toLowerCase();
    if (key && /^[a-f\d]+$/.test(key)) keys.add(key);
  };
  add(session.url ? /\/sessions\/([^/?#]+)/i.exec(session.url)?.[1] : undefined);
  add(session.nativeId);
  return [...keys];
}

function cardsForSession(
  session: AgentSession,
  cardsBySession: Map<string, PendingApproval[]>,
): PendingApproval[] {
  const cards = new Map<string, PendingApproval>();
  for (const key of desktopSessionKeys(session)) {
    for (const card of cardsBySession.get(key) ?? []) cards.set(card.id, card);
  }
  return [...cards.values()];
}

function approvalSet(session?: AgentSession): PendingApproval[] {
  return session?.approvals ?? (session?.approval ? [session.approval] : []);
}

export function mapDevinStatus(value: unknown): SessionStatus {
  switch (String(value || '').toLowerCase()) {
    case 'working': case 'running': return 'working';
    case 'blocked': case 'awaiting_input': case 'waiting_for_user': return 'working';
    case 'finished': case 'completed': return 'done';
    case 'expired': case 'suspended': case 'stopped':
    case 'suspend_requested': case 'suspend_requested_frontend':
    case 'resume_requested_frontend': return 'idle';
    case 'resumed': case 'resume_requested': return 'working';
    case 'error': case 'failed': return 'error';
    default: return 'idle';
  }
}

export function mapDevinV3Status(status: unknown, statusDetail: unknown): SessionStatus {
  switch (String(status || '').toLowerCase()) {
    case 'running':
      switch (String(statusDetail || '').toLowerCase()) {
        case 'waiting_for_user':
        case 'waiting_for_approval':
          return 'needs_input';
        case 'finished':
          return 'done';
        default:
          return 'working';
      }
    case 'new':
    case 'claimed':
    case 'resuming':
      return 'working';
    case 'exit':
      return 'done';
    case 'error':
      return 'error';
    case 'suspended':
      return 'idle';
    default:
      return 'idle';
  }
}

function timestampToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const number = Number(value);
  const date = new Date(Number.isFinite(number) ? number * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export class DevinCollector implements Collector {
  name = 'devin';
  private emit?: EmitSession;
  private timer?: NodeJS.Timeout;
  private desktopCardsTimer?: NodeJS.Timeout;
  private messagesById = new Map<string, CachedDevinMessages>();
  private sessions = new Map<string, AgentSession>();
  private apiSessions = new Map<string, AgentSession>();
  private desktopCards = new Map<string, PendingApproval[]>();
  private desktopCardsDir?: string;
  private readonly desktopCardsReader: typeof readDevinDesktopCards;
  constructor(
    private apiKey: string | undefined,
    private fetcher: typeof fetch = fetch,
    private v3?: { pat: string; orgId: string },
    private desktopCardsOptions?: DevinDesktopCardsOptions,
  ) {
    this.desktopCardsReader = desktopCardsOptions?.readCards ?? readDevinDesktopCards;
  }
  start(emit: EmitSession): void {
    this.emit = emit;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 30_000);
    this.desktopCardsDir = this.desktopCardsDirectory();
    if (this.desktopCardsDir) {
      this.pollDesktopCards();
      this.desktopCardsTimer = setInterval(() => this.pollDesktopCards(), 5_000);
    }
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.desktopCardsTimer) clearInterval(this.desktopCardsTimer);
  }
  async getMessages(nativeId: string, limit: number): Promise<SessionMessage[]> {
    if (!this.apiKey) return [];
    const id = `devin:${nativeId}`;
    const updatedAt = this.sessions.get(id)?.updatedAt || '';
    const cached = this.messagesById.get(nativeId);
    if (cached?.updatedAt === updatedAt) return cached.messages.slice(-limit);
    try {
      const response = await this.fetcher(`https://api.devin.ai/v1/sessions/${encodeURIComponent(nativeId)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!response.ok) return [];
      const data = await response.json() as any;
      const messages = parseDevinMessages(data.messages);
      if ((this.sessions.get(id)?.updatedAt || '') === updatedAt) {
        this.messagesById.set(nativeId, { updatedAt, messages });
      }
      const lastMessage = messages.filter((item) => item.role !== 'tool').at(-1);
      const baseSession = this.apiSessions.get(id);
      if (baseSession && lastMessage) {
        const updatedBase = { ...baseSession, lastMessage: lastMessage.text.slice(0, 280), lastRole: lastMessage.role };
        this.apiSessions.set(id, updatedBase);
        const updated = this.withDesktopCards(updatedBase);
        this.sessions.set(id, updated);
        this.emit?.(updated);
      }
      return messages.slice(-limit);
    } catch { return []; }
  }
  async sendMessage(nativeId: string, text: string): Promise<void> {
    if (!this.apiKey) throw new Error('Replying to Devin cloud chats needs devinApiKey');
    const response = await this.fetcher(`https://api.devin.ai/v1/sessions/${encodeURIComponent(nativeId)}/message`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    if (!response.ok) throw new Error(`Devin API returned HTTP ${response.status}`);
    this.messagesById.delete(nativeId);
  }
  protected async poll(): Promise<void> {
    try {
      const rows: any[] = [];
      if (this.v3) {
        let after: string | undefined;
        for (let page = 0; page < 10; page++) {
          const cursor = after === undefined ? '' : `&after=${encodeURIComponent(after)}`;
          const response = await this.fetcher(
            `https://api.devin.ai/v3/organizations/${encodeURIComponent(this.v3.orgId)}/sessions?first=100${cursor}`,
            { headers: { Authorization: `Bearer ${this.v3.pat}` } },
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json() as any;
          if (!Array.isArray(data.items)) throw new Error('Invalid v3 sessions response');
          rows.push(...data.items);
          if (!data.has_next_page || page === 9) break;
          if (typeof data.end_cursor !== 'string' || !data.end_cursor) throw new Error('Invalid v3 sessions cursor');
          after = data.end_cursor;
        }
      } else if (this.apiKey) {
        for (let page = 0; page < 10; page++) {
          const offset = page * 100;
          const response = await this.fetcher(`https://api.devin.ai/v1/sessions?limit=100&offset=${offset}`, {
            headers: { Authorization: `Bearer ${this.apiKey}` },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json() as any;
          const pageRows = Array.isArray(data) ? data : data.sessions;
          if (!Array.isArray(pageRows)) throw new Error('Invalid sessions response');
          rows.push(...pageRows);
          if (pageRows.length < 100) break;
        }
      }
      const active = new Set<string>();
      for (const row of rows) {
        const rowId = String(row.session_id || row.id || '');
        const nativeId = rowId;
        if (!nativeId) continue;
        const id = nativeId.startsWith('devin:') ? nativeId.slice(6) : nativeId;
        const urlId = id.replace(/^devin-/, '');
        const status = this.v3
          ? mapDevinV3Status(row.status, row.status_detail)
          : mapDevinStatus(row.status_enum || row.status);
        active.add(`devin:${id}`);
        const createdAt = this.v3 ? timestampToIso(row.created_at) : row.created_at ? String(row.created_at) : undefined;
        const updatedAt = this.v3
          ? timestampToIso(row.updated_at) || createdAt || new Date().toISOString()
          : String(row.updated_at || row.created_at || new Date().toISOString());
        const cached = this.messagesById.get(id);
        if (cached && cached.updatedAt !== updatedAt) this.messagesById.delete(id);
        const cachedMessages = this.messagesById.get(id);
        const lastMessage = cachedMessages?.messages.filter((item) => item.role !== 'tool').at(-1);
        const repo = this.v3
          ? row.structured_output?.repo ?? row.repo ?? row.repository
          : row.structured_output?.repo;
        const project = typeof repo === 'string' ? projectName(repo) : undefined;
        const session: AgentSession = {
          id: `devin:${id}`, agent: 'devin', nativeId: id,
          title: String(row.title || row.name || 'Devin session'),
          ...(project ? { project } : {}),
          status,
          ...(lastMessage
            ? { lastMessage: lastMessage.text.slice(0, 280), lastRole: lastMessage.role }
            : {}),
          canReply: Boolean(this.apiKey),
          updatedAt, ...(createdAt ? { startedAt: createdAt } : {}),
          url: this.v3 && typeof row.url === 'string'
            ? row.url
            : `https://app.devin.ai/sessions/${encodeURIComponent(urlId)}`,
          machine: os.hostname(),
        };
        this.apiSessions.set(session.id, session);
        const updated = this.withDesktopCards(session);
        this.sessions.set(session.id, updated);
        this.emit?.(updated);
      }
      for (const id of this.apiSessions.keys()) {
        if (active.has(id)) continue;
        this.apiSessions.delete(id);
        this.sessions.delete(id);
        this.messagesById.delete(id.slice('devin:'.length));
        this.emit?.remove?.(id);
      }
    } catch (error) {
      console.warn(`[devin] polling failed: ${(error as Error).message}`);
    }
  }

  protected pollDesktopCards(): void {
    const directory = this.desktopCardsDir;
    if (!directory) return;
    let next = new Map<string, PendingApproval[]>();
    try {
      if (statSync(directory).isDirectory()) next = this.desktopCardsReader(directory);
    } catch { /* The Desktop mirror may be unavailable while the app is closed. */ }
    for (const baseSession of this.apiSessions.values()) {
      const previous = this.sessions.get(baseSession.id);
      const updated = this.withDesktopCards(baseSession, next);
      if (JSON.stringify(approvalSet(previous)) === JSON.stringify(approvalSet(updated))) continue;
      this.sessions.set(updated.id, updated);
      this.emit?.(updated);
    }
    this.desktopCards = next;
  }

  private desktopCardsDirectory(): string | undefined {
    const platform = this.desktopCardsOptions?.platform ?? process.platform;
    if (platform !== 'win32') return undefined;
    if (this.desktopCardsOptions?.dir) return this.desktopCardsOptions.dir;
    const appData = process.env.APPDATA;
    return appData ? path.join(appData, 'Devin', 'User', 'acp-messages') : undefined;
  }

  private withDesktopCards(
    session: AgentSession,
    cardsBySession = this.desktopCards,
  ): AgentSession {
    const cards = cardsForSession(session, cardsBySession);
    if (cards.length) {
      return { ...session, status: 'needs_input', approval: cards[0], approvals: cards };
    }
    const cleared = { ...session };
    delete cleared.approval;
    delete cleared.approvals;
    return cleared;
  }
}
