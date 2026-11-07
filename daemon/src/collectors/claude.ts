import path from 'node:path';
import { stat } from 'node:fs/promises';
import { agentHome } from '../config.js';
import { buildSession, inferStatus, isoOrNow, message, parseJsonLines, textFromContent } from './files.js';
import { defaultApprovalHoldSeconds } from '../claude-hooks.js';
import type { EmitSession } from './types.js';
import { WatchedCollector } from './watched.js';
import type { ParsedWatchedSession } from './watched.js';
import type { AgentSession, SessionMessage, SessionStatus } from '@agent-hub/shared';

export function claudeTitle(text: string): string | undefined {
  const clean = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!clean || /^(<environment_context>|<instructions>)/i.test(clean)) return undefined;
  return clean.slice(0, 180);
}

export interface ClaudeHookPayload {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
  transcript_path?: string;
  message?: string;
  error?: string;
  notification_type?: string;
}

export function mapClaudeHook(event: string, payload: ClaudeHookPayload = {}): SessionStatus | undefined {
  if (['UserPromptSubmit', 'PreToolUse', 'SubagentStart'].includes(event)) return 'working';
  if (event === 'PermissionRequest') return 'needs_input';
  if (event === 'Notification') {
    const needsInput = ['permission_prompt', 'elicitation_dialog'].includes(payload.notification_type || '')
      || (!payload.notification_type && /permission|approve|allow/i.test(payload.message || ''));
    return needsInput ? 'needs_input' : 'done';
  }
  if (event === 'Stop') return 'done';
  if (event === 'StopFailure') return 'error';
  if (event === 'SessionEnd') return 'done';
  return undefined;
}

export function claudeHookOverride(
  fileModifiedAt: number,
  status: SessionStatus,
  hookAt: number,
  now = Date.now(),
  approvalHoldMs = defaultApprovalHoldSeconds * 1000,
): SessionStatus | undefined {
  if (status === 'needs_input' && now - hookAt > approvalHoldMs + 60_000) return undefined;
  return fileModifiedAt <= hookAt ? status : undefined;
}

function isApiErrorMessage(text: string): boolean {
  return /^\s*API Error\s*:/i.test(text);
}

function errorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value && typeof value === 'object' && 'message' in value) {
    return errorText((value as { message?: unknown }).message);
  }
  return undefined;
}

function formatErrorMessage(text?: string): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? `Error: ${trimmed}`.slice(0, 280) : undefined;
}

export function parseClaudeRecords(
  records: Record<string, any>[],
  nativeId: string,
  fileModifiedAt: string,
  now = Date.now(),
): { session: AgentSession; messages: SessionMessage[]; statusFacts: { updatedAt: string; lastRole?: AgentSession['lastRole']; completed: boolean; errored: boolean } } {
  const metadata = records.find((record) => record.sessionId || record.session_id);
  const messages: SessionMessage[] = [];
  let title: string | undefined;
  let cwd = typeof metadata?.cwd === 'string' ? metadata.cwd : undefined;
  let branch = typeof metadata?.gitBranch === 'string' ? metadata.gitBranch : undefined;
  let updatedAt = fileModifiedAt;
  let lastRole: AgentSession['lastRole'];
  let lastMessage: string | undefined;
  let lastErrorMessage: string | undefined;
  let complete = false;
  let errored = false;
  for (const row of records) {
    if (typeof row.cwd === 'string') cwd = row.cwd;
    if (typeof row.gitBranch === 'string') branch = row.gitBranch;
    const role = row.type === 'user' || row.type === 'assistant' ? row.type : row.message?.role;
    const content = row.message?.content ?? row.content;
    const text = textFromContent(content);
    const recordError = errorText(row.error) || errorText(row.message?.error)
      || (row.type === 'stop_failure' && typeof row.message === 'string' ? errorText(row.message) : undefined);
    const apiError = role === 'assistant' && Boolean(text) && isApiErrorMessage(text);
    if (role && text) {
      const mappedRole = role === 'assistant' ? 'assistant' : 'user';
      messages.push(message(text, mappedRole, row.timestamp));
      if (mappedRole === 'user' && !title) title = claudeTitle(text);
      lastRole = mappedRole;
      lastMessage = text;
      if (mappedRole === 'user' || (mappedRole === 'assistant' && !apiError && !recordError)) {
        errored = false;
        lastErrorMessage = undefined;
      }
      if (apiError) {
        errored = true;
        lastErrorMessage = text;
      }
      if (mappedRole === 'user') complete = false;
    }
    if (role === 'assistant') {
      lastRole = 'assistant';
      const stopReason = row.stop_reason ?? row.message?.stop_reason;
      const hasToolUse = Array.isArray(content) && content.some((part) => part?.type === 'tool_use');
      complete = stopReason === 'end_turn' || (stopReason !== 'tool_use' && !hasToolUse);
    }
    if (row.type === 'summary' && typeof row.summary === 'string' && !title) title = row.summary.slice(0, 180);
    if (row.type === 'stop_failure' || recordError) {
      errored = true;
      if (recordError) lastErrorMessage = recordError;
    }
    if (row.timestamp) {
      const at = isoOrNow(row.timestamp);
      if (Date.parse(at) > Date.parse(updatedAt)) updatedAt = at;
    }
  }
  updatedAt = isoOrNow(updatedAt);
  const statusFacts = { updatedAt, lastRole, completed: complete, errored };
  return {
    session: buildSession({
      agent: 'claude-code', nativeId, title, cwd, branch, updatedAt, startedAt: records[0]?.timestamp,
      status: inferStatus(updatedAt, lastRole, complete, errored, now),
      lastMessage: errored ? formatErrorMessage(lastErrorMessage) : lastMessage?.slice(-280), lastRole,
    }),
    messages,
    statusFacts,
  };
}

export class ClaudeCollector extends WatchedCollector {
  name = 'claude-code';
  private hookOverrides = new Map<string, { status: SessionStatus; at: number; message?: string }>();
  private readonly days: number;
  private readonly approvalHoldMs: number;
  private readonly now: () => number;
  protected roots(): string[] { return [path.join(agentHome(), '.claude', 'projects')]; }
  protected watchTargets(): { paths: string[]; depth: number } { return { paths: this.roots(), depth: 2 }; }
  protected async findFiles(): Promise<string[]> {
    const { walkFiles } = await import('./files.js');
    return this.recentFiles(await walkFiles(this.roots()[0]!, (file) => file.endsWith('.jsonl')), this.days);
  }
  constructor(options: { days?: number; approvalHoldMs?: number; now?: () => number } = {}) {
    super();
    this.days = options.days ?? 7;
    this.approvalHoldMs = options.approvalHoldMs ?? defaultApprovalHoldSeconds * 1000;
    this.now = options.now ?? Date.now;
  }
  private activeHookOverride(nativeId: string, now = this.now()): { status: SessionStatus; at: number; message?: string } | undefined {
    const hook = this.hookOverrides.get(nativeId);
    if (hook?.status === 'needs_input' && now - hook.at > this.approvalHoldMs + 60_000) {
      this.hookOverrides.delete(nativeId);
      return undefined;
    }
    return hook;
  }
  protected shouldRetain(session: AgentSession): boolean {
    return Boolean(this.activeHookOverride(session.nativeId));
  }
  async applyHook(payload: ClaudeHookPayload, emit: EmitSession | undefined = this.emit): Promise<void> {
    if (!payload.session_id || !payload.hook_event_name) return;
    const status = mapClaudeHook(payload.hook_event_name, payload);
    if (!status) return;
    const now = this.now();
    const failureMessage = formatErrorMessage(errorText(payload.error) || payload.message);
    this.hookOverrides.set(payload.session_id, {
      status,
      at: now,
      message: status === 'error' ? failureMessage : payload.message,
    });
    const existing = this.sessions.get(`claude-code:${payload.session_id}`);
    if (existing) {
      const updated = {
        ...existing,
        status,
        updatedAt: new Date(now).toISOString(),
        ...(status === 'error'
          ? { lastMessage: failureMessage }
          : status === 'needs_input' && payload.message ? { lastMessage: payload.message.slice(0, 280) } : {}),
      };
      this.sessions.set(existing.id, updated);
      emit?.(updated);
    } else if (payload.cwd) {
      const updated = buildSession({
        agent: 'claude-code', nativeId: payload.session_id, cwd: payload.cwd,
        title: payload.message || 'Claude Code session', status, updatedAt: new Date(now).toISOString(),
        ...(status === 'error' ? { lastMessage: failureMessage } : {}),
        ...(status === 'needs_input' && payload.message ? { lastMessage: payload.message.slice(0, 280) } : {}),
      });
      this.sessions.set(updated.id, updated);
      emit?.(updated);
    }
  }
  async clearNeedsInput(sessionId: string, emit: EmitSession | undefined = this.emit): Promise<void> {
    const nativeId = sessionId.startsWith('claude-code:') ? sessionId.slice('claude-code:'.length) : sessionId;
    const hook = this.activeHookOverride(nativeId);
    if (!hook || hook.status !== 'needs_input') return;
    this.hookOverrides.delete(nativeId);
    if (this.fileById.has(nativeId)) {
      await this.rescan();
      return;
    }
    const existing = this.sessions.get(`claude-code:${nativeId}`);
    if (!existing) return;
    const now = this.now();
    const updated = {
      ...existing,
      status: inferStatus(existing.updatedAt, existing.lastRole, false, false, now),
      updatedAt: new Date(now).toISOString(),
      lastMessage: undefined,
    };
    this.sessions.set(updated.id, updated);
    emit?.(updated);
  }
  protected async parse(file: string): Promise<ParsedWatchedSession | undefined> {
    const records = await parseJsonLines(file);
    const metadata = records.find((record) => record.sessionId || record.session_id);
    const nativeId = String(metadata?.sessionId || metadata?.session_id || path.basename(file, '.jsonl'));
    const modifiedAt = new Date((await stat(file)).mtimeMs).toISOString();
    const parsed = parseClaudeRecords(records, nativeId, modifiedAt);
    this.messagesById.set(nativeId, parsed.messages);
    return { session: parsed.session, statusFacts: parsed.statusFacts };
  }
  protected refreshSession(parsed: ParsedWatchedSession, mtimeMs: number, now: number): AgentSession {
    const session = super.refreshSession(parsed, mtimeMs, now);
    const hook = this.activeHookOverride(session.nativeId, now);
    if (!hook) return session;
    const override = claudeHookOverride(mtimeMs, hook.status, hook.at, now, this.approvalHoldMs);
    if (!override) {
      this.hookOverrides.delete(session.nativeId);
      return session;
    }
    return {
      ...session,
      status: override,
      ...(hook.status === 'error' ? { lastMessage: hook.message } : {}),
      updatedAt: new Date(Math.max(Date.parse(session.updatedAt), hook.at)).toISOString(),
    };
  }
  private messagesById = new Map<string, SessionMessage[]>();
  protected async messages(file: string, limit: number): Promise<SessionMessage[]> {
    const id = path.basename(file, '.jsonl');
    if (!this.messagesById.has(id)) await this.parse(file);
    return (this.messagesById.get(id) || []).slice(-limit);
  }
  async getMessages(nativeId: string, limit: number): Promise<SessionMessage[]> {
    const file = this.fileById.get(nativeId);
    if (!file) return [];
    if (!this.messagesById.has(nativeId)) await this.parse(file);
    return (this.messagesById.get(nativeId) || []).slice(-limit);
  }
}
