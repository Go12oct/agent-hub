import os from 'node:os';
import type { AgentSession, SessionMessage, SessionStatus } from '@agent-hub/shared';
import type { Collector, EmitSession } from './types.js';
import { projectName } from './files.js';

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
  private messagesById = new Map<string, SessionMessage[]>();
  private sessions = new Map<string, AgentSession>();
  constructor(private apiKey: string, private fetcher: typeof fetch = fetch) {}
  start(emit: EmitSession): void {
    this.emit = emit;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 30_000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }
  async getMessages(nativeId: string, limit: number): Promise<SessionMessage[]> {
    const cached = this.messagesById.get(nativeId);
    if (cached) return cached.slice(-limit);
    try {
      const response = await this.fetcher(`https://api.devin.ai/v1/sessions/${encodeURIComponent(nativeId)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!response.ok) return [];
      const data = await response.json() as any;
      const rows = Array.isArray(data.messages) ? data.messages : [];
      const messages = rows.map((row: any) => ({
        role: row.role === 'user' ? 'user' : row.role === 'tool' ? 'tool' : 'assistant',
        text: String(row.message || row.content || row.text || '').slice(0, 20_000),
        at: row.created_at,
      }));
      this.messagesById.set(nativeId, messages);
      return messages.slice(-limit);
    } catch { return []; }
  }
  private async poll(): Promise<void> {
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
        const project = typeof row.structured_output?.repo === 'string' ? projectName(row.structured_output.repo) : undefined;
        const session: AgentSession = {
          id: `devin:${id}`, agent: 'devin', nativeId: id,
          title: String(row.title || row.name || 'Devin session'),
          ...(project ? { project } : {}),
          status, ...(status === 'needs_input' ? { lastMessage: 'Waiting for your input' } : {}),
          updatedAt, ...(row.created_at ? { startedAt: String(row.created_at) } : {}),
          url: `https://app.devin.ai/sessions/${encodeURIComponent(urlId)}`, machine: os.hostname(),
        };
        this.sessions.set(session.id, session);
        this.emit?.(session);
      }
      for (const id of this.sessions.keys()) {
        if (active.has(id)) continue;
        this.sessions.delete(id);
        this.emit?.remove?.(id);
      }
    } catch (error) {
      console.warn(`[devin] polling failed: ${(error as Error).message}`);
    }
  }
}
