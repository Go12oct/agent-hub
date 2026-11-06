import os from 'node:os';
import type { AgentSession, SessionMessage, SessionStatus } from '@agent-hub/shared';
import type { Collector, EmitSession } from './types.js';
import { projectName } from './files.js';
import { devinSecretRequestMarker } from '../notifications.js';

const credentialWords = /\b(?:secrets?|api[\s-]+keys?|tokens?(?!\s+refresh\b)|keys?|credentials?|passwords?)\b/i;
const askForm = /^\s*(?:please\s+)?(?:provide|paste|enter|add|share|give|generate|create)\b|\b(?:please|can you|could you|would you|you(?:'ll)? need to)\s+(?:provide|paste|enter|add|share|give|generate|create)\b/i;
const sendMe = /\b(?:send|share|give)\s+me\b/i;
const yourSupply = /\byour\b[\s\S]*?\b(?:provide|paste|enter|add|share|give|create|generate|need)\b|\b(?:provide|paste|enter|add|share|give|create|generate|need)\b[\s\S]*?\byour\b/i;
const promptContext = /\bprompts?\b|\bI\s+(?:need|still\s+need)\b|\bI['’]ll\s+need\b|\bwaiting\s+(?:for|on)\b/i;
const devinOffer = /^\s*I(?:'ll| will| can| am going to)\s+(?:send|share|give)\b/i;

export function asksForSecret(text: string): boolean {
  return text.split(/[.!?\r\n]+/).some((sentence) =>
    !devinOffer.test(sentence)
      && credentialWords.test(sentence)
      && (askForm.test(sentence) || sendMe.test(sentence) || yourSupply.test(sentence) || promptContext.test(sentence)));
}

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

function latestMessage(messages: SessionMessage[], role: SessionMessage['role']): { message: SessionMessage; index: number; timestamp?: number } | undefined {
  let latest: { message: SessionMessage; index: number; timestamp?: number } | undefined;
  for (const [index, message] of messages.entries()) {
    if (message.role !== role) continue;
    const parsed = message.at ? Date.parse(message.at) : NaN;
    const timestamp = Number.isFinite(parsed) ? parsed : undefined;
    if (!latest
      || (timestamp !== undefined && latest.timestamp !== undefined
        ? timestamp > latest.timestamp || (timestamp === latest.timestamp && index > latest.index)
        : index > latest.index)) {
      latest = { message, index, ...(timestamp === undefined ? {} : { timestamp }) };
    }
  }
  return latest;
}

function hasOpenSecretRequest(messages: SessionMessage[]): boolean {
  const devinMessage = latestMessage(messages, 'assistant');
  if (!devinMessage || !asksForSecret(devinMessage.message.text)) return false;
  const userMessage = latestMessage(messages, 'user');
  if (!userMessage) return true;
  if (devinMessage.timestamp !== undefined && userMessage.timestamp !== undefined) {
    return devinMessage.timestamp > userMessage.timestamp;
  }
  return devinMessage.index > userMessage.index;
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
    return (await this.fetchMessages(nativeId, updatedAt)).slice(-limit);
  }
  private async fetchMessages(nativeId: string, updatedAt: string): Promise<SessionMessage[]> {
    const id = `devin:${nativeId}`;
    const cached = this.messagesById.get(nativeId);
    if (cached?.updatedAt === updatedAt) return cached.messages;
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
        const secretRequest = session.updatedAt === updatedAt
          && ['working', 'needs_input'].includes(session.status)
          && hasOpenSecretRequest(messages);
        const updated = secretRequest
          ? { ...session, status: 'needs_input' as const, lastMessage: `${devinSecretRequestMarker} — open Devin to add it`, lastRole: 'assistant' as const }
          : { ...session, lastMessage: lastMessage.text.slice(0, 280), lastRole: lastMessage.role };
        this.sessions.set(id, updated);
        this.emit?.(updated);
      }
      return messages;
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
      const detailCandidates: Array<{ nativeId: string; updatedAt: string }> = [];
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
        const secretRequest = (status === 'working' || status === 'needs_input')
          && Boolean(cachedMessages && hasOpenSecretRequest(cachedMessages.messages));
        const project = typeof row.structured_output?.repo === 'string' ? projectName(row.structured_output.repo) : undefined;
        const session: AgentSession = {
          id: `devin:${id}`, agent: 'devin', nativeId: id,
          title: String(row.title || row.name || 'Devin session'),
          ...(project ? { project } : {}),
          status: secretRequest ? 'needs_input' : status,
          ...(secretRequest
            ? { lastMessage: `${devinSecretRequestMarker} — open Devin to add it`, lastRole: 'assistant' as const }
            : lastMessage
            ? { lastMessage: lastMessage.text.slice(0, 280), lastRole: lastMessage.role }
            : status === 'needs_input' ? { lastMessage: 'Waiting for your input' } : {}),
          canReply: true,
          updatedAt, ...(row.created_at ? { startedAt: String(row.created_at) } : {}),
          url: `https://app.devin.ai/sessions/${encodeURIComponent(urlId)}`, machine: os.hostname(),
        };
        this.sessions.set(session.id, session);
        this.emit?.(session);
        if ((status === 'working' || status === 'needs_input') && !cachedMessages) {
          detailCandidates.push({ nativeId: id, updatedAt });
        }
      }
      for (const candidate of detailCandidates
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, 5)) {
        await this.fetchMessages(candidate.nativeId, candidate.updatedAt);
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
