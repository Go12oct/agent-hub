import os from 'node:os';
import type { AgentSession, SessionMessage, SessionStatus } from '@agent-hub/shared';
import type { Collector, EmitSession } from './types.js';
import { projectName } from './files.js';

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

export function mapDevinStatus(value: unknown): SessionStatus {
  switch (String(value || '').toLowerCase()) {
    case 'working': case 'running': return 'working';
    case 'blocked': case 'awaiting_input': case 'waiting_for_user': return 'needs_input';
    case 'finished': case 'completed': return 'done';
    case 'expired': case 'suspended': case 'stopped':
    case 'suspend_requested': case 'suspend_requested_frontend':
    case 'resume_requested_frontend': return 'idle';
    case 'resumed': case 'resume_requested': return 'working';
    case 'error': case 'failed': return 'error';
    default: return 'idle';
  }
}

export class DevinCollector implements Collector {
  name = 'devin';
  private emit?: EmitSession;
  private timer?: NodeJS.Timeout;
  private messagesById = new Map<string, CachedDevinMessages>();
  private sessions = new Map<string, AgentSession>();
  constructor(private apiKey: string, private fetcher: typeof fetch = fetch) {}
  start(emit: EmitSession): void {
    this.emit = emit;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 30_000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }
  async getMessages(nativeId: string, limit: number): Promise<SessionMessage[]> {
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
      const session = this.sessions.get(id);
      if (session && lastMessage) {
        const updated = { ...session, lastMessage: lastMessage.text.slice(0, 280), lastRole: lastMessage.role };
        this.sessions.set(id, updated);
        this.emit?.(updated);
      }
      return messages.slice(-limit);
    } catch { return []; }
  }
  async sendMessage(nativeId: string, text: string): Promise<void> {
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
      const response = await this.fetcher('https://api.devin.ai/v1/sessions?limit=50', {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as any;
      const rows = Array.isArray(data) ? data : data.sessions || [];
      const active = new Set<string>();
      for (const row of rows) {
        const nativeId = String(row.session_id || row.id || '');
        if (!nativeId) continue;
        const id = nativeId.startsWith('devin:') ? nativeId.slice(6) : nativeId;
        const urlId = id.replace(/^devin-/, '');
        const status = mapDevinStatus(row.status_enum || row.status);
        active.add(`devin:${id}`);
        const updatedAt = String(row.updated_at || row.created_at || new Date().toISOString());
        const cached = this.messagesById.get(id);
        if (cached && cached.updatedAt !== updatedAt) this.messagesById.delete(id);
        const cachedMessages = this.messagesById.get(id);
        const lastMessage = cachedMessages?.messages.filter((item) => item.role !== 'tool').at(-1);
        const project = typeof row.structured_output?.repo === 'string' ? projectName(row.structured_output.repo) : undefined;
        const session: AgentSession = {
          id: `devin:${id}`, agent: 'devin', nativeId: id,
          title: String(row.title || row.name || 'Devin session'),
          ...(project ? { project } : {}),
          status,
          ...(lastMessage
            ? { lastMessage: lastMessage.text.slice(0, 280), lastRole: lastMessage.role }
            : status === 'needs_input' ? { lastMessage: 'Waiting for your input' } : {}),
          canReply: true,
          updatedAt, ...(row.created_at ? { startedAt: String(row.created_at) } : {}),
          url: `https://app.devin.ai/sessions/${encodeURIComponent(urlId)}`, machine: os.hostname(),
        };
        this.sessions.set(session.id, session);
        this.emit?.(session);
      }
      for (const id of this.sessions.keys()) {
        if (active.has(id)) continue;
        this.sessions.delete(id);
        this.messagesById.delete(id.slice('devin:'.length));
        this.emit?.remove?.(id);
      }
    } catch (error) {
      console.warn(`[devin] polling failed: ${(error as Error).message}`);
    }
  }
}
