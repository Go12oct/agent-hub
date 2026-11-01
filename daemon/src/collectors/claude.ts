import path from 'node:path';
import { stat } from 'node:fs/promises';
import { agentHome } from '../config.js';
import { buildSession, inferStatus, isoOrNow, message, parseJsonLines, textFromContent } from './files.js';
import type { EmitSession } from './types.js';
import { WatchedCollector } from './watched.js';
import type { AgentSession, SessionMessage, SessionStatus } from '@agent-hub/shared';

export function claudeTitle(text: string): string | undefined {
  const clean = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!clean || /^(<environment_context>|<instructions>)/i.test(clean)) return undefined;
  return clean.slice(0, 180);
}

export function mapClaudeHook(event: string): SessionStatus | undefined {
  if (['UserPromptSubmit', 'PreToolUse', 'SubagentStart'].includes(event)) return 'working';
  if (['Notification', 'Stop', 'PermissionRequest'].includes(event)) return 'needs_input';
  if (event === 'StopFailure') return 'error';
  if (event === 'SessionEnd') return 'done';
  return undefined;
}

export interface ClaudeHookPayload {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
  transcript_path?: string;
  message?: string;
  notification_type?: string;
}

export function claudeHookOverride(fileModifiedAt: number, status: SessionStatus, hookAt: number): SessionStatus | undefined {
  return fileModifiedAt <= hookAt ? status : undefined;
}

export function parseClaudeRecords(
  records: Record<string, any>[],
  nativeId: string,
  fileModifiedAt: string,
  now = Date.now(),
): { session: AgentSession; messages: SessionMessage[] } {
  const metadata = records.find((record) => record.sessionId || record.session_id);
  const messages: SessionMessage[] = [];
  let title: string | undefined;
  let cwd = typeof metadata?.cwd === 'string' ? metadata.cwd : undefined;
  let branch = typeof metadata?.gitBranch === 'string' ? metadata.gitBranch : undefined;
  let updatedAt = fileModifiedAt;
  let lastRole: AgentSession['lastRole'];
  let lastMessage: string | undefined;
  let complete = false;
  let errored = false;
  for (const row of records) {
    if (typeof row.cwd === 'string') cwd = row.cwd;
    if (typeof row.gitBranch === 'string') branch = row.gitBranch;
    const role = row.type === 'user' || row.type === 'assistant' ? row.type : row.message?.role;
    const text = textFromContent(row.message?.content ?? row.content);
    if (role && text) {
      const mappedRole = role === 'assistant' ? 'assistant' : 'user';
      messages.push(message(text, mappedRole, row.timestamp));
      if (mappedRole === 'user' && !title) title = claudeTitle(text);
      lastRole = mappedRole;
      lastMessage = text;
      complete = mappedRole === 'assistant' && (row.stop_reason != null || row.message?.stop_reason != null);
    }
    if (row.type === 'summary' && typeof row.summary === 'string' && !title) title = row.summary.slice(0, 180);
    if (row.type === 'stop_failure') errored = true;
    if (row.timestamp) {
      const at = isoOrNow(row.timestamp);
      if (Date.parse(at) > Date.parse(updatedAt)) updatedAt = at;
    }
  }
  updatedAt = isoOrNow(updatedAt);
  return {
    session: buildSession({
      agent: 'claude-code', nativeId, title, cwd, branch, updatedAt, startedAt: records[0]?.timestamp,
      status: inferStatus(updatedAt, lastRole, complete, errored, now),
      lastMessage: lastMessage?.slice(-280), lastRole,
    }),
    messages,
  };
}

export class ClaudeCollector extends WatchedCollector {
  name = 'claude-code';
  private hookOverrides = new Map<string, { status: SessionStatus; at: number; message?: string }>();
  protected roots(): string[] { return [path.join(agentHome(), '.claude', 'projects')]; }
  protected async findFiles(): Promise<string[]> {
    const { walkFiles } = await import('./files.js');
    return this.recentFiles(await walkFiles(this.roots()[0]!, (file) => file.endsWith('.jsonl')), this.days);
  }
  constructor(private days = 7) { super(); }
  protected shouldRetain(session: AgentSession): boolean {
    return this.hookOverrides.has(session.nativeId);
  }
  async applyHook(payload: ClaudeHookPayload, emit: EmitSession | undefined = this.emit): Promise<void> {
    if (!payload.session_id || !payload.hook_event_name) return;
    const status = mapClaudeHook(payload.hook_event_name);
    if (!status) return;
    this.hookOverrides.set(payload.session_id, { status, at: Date.now(), message: payload.message });
    const existing = this.sessions.get(`claude-code:${payload.session_id}`);
    if (existing) {
      const updated = { ...existing, status, updatedAt: new Date().toISOString(), ...(payload.message ? { lastMessage: payload.message.slice(0, 280) } : {}) };
      this.sessions.set(existing.id, updated);
      emit?.(updated);
    } else if (payload.cwd) {
      const updated = buildSession({
        agent: 'claude-code', nativeId: payload.session_id, cwd: payload.cwd,
        title: payload.message || 'Claude Code session', status, updatedAt: new Date().toISOString(),
      });
      this.sessions.set(updated.id, updated);
      emit?.(updated);
    }
  }
  protected async parse(file: string): Promise<AgentSession | undefined> {
    const records = await parseJsonLines(file);
    const metadata = records.find((record) => record.sessionId || record.session_id);
    const nativeId = String(metadata?.sessionId || metadata?.session_id || path.basename(file, '.jsonl'));
    const modifiedAt = new Date((await stat(file)).mtimeMs).toISOString();
    const parsed = parseClaudeRecords(records, nativeId, modifiedAt);
    const hook = this.hookOverrides.get(nativeId);
    const override = hook && claudeHookOverride(Date.parse(modifiedAt), hook.status, hook.at);
    if (override) parsed.session.status = override;
    else if (hook) this.hookOverrides.delete(nativeId);
    this.messagesById.set(nativeId, parsed.messages);
    return parsed.session;
  }
  private messagesById = new Map<string, SessionMessage[]>();
  protected async messages(file: string, limit: number): Promise<SessionMessage[]> {
    const id = path.basename(file, '.jsonl');
    if (!this.messagesById.has(id)) await this.parse(file);
    return (this.messagesById.get(id) || []).slice(-limit);
  }
}
