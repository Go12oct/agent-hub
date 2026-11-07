import path from 'node:path';
import { readdir } from 'node:fs/promises';
import type { AgentSession, SessionMessage, SessionStatus } from '@agent-hub/shared';
import { agentHome } from '../config.js';
import { buildSession, inferStatus, isoOrNow, message, parseJsonLines, textFromContent } from './files.js';
import { WatchedCollector } from './watched.js';
import type { ParsedWatchedSession } from './watched.js';
import type { EmitSession } from './types.js';
import { activeHookOverride, hookOverrideForFile, type HookOverride } from './hook-overrides.js';

export interface CodexHookPayload {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
  message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export function mapCodexHook(event: string): SessionStatus | undefined {
  if (event === 'UserPromptSubmit' || event === 'PreToolUse') return 'working';
  if (event === 'PermissionRequest') return 'needs_input';
  if (event === 'Stop' || event === 'SessionEnd') return 'done';
  return undefined;
}

function codexRoot(): string {
  return process.env.CODEX_HOME || path.join(agentHome(), '.codex');
}

function formatErrorMessage(text?: string): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? `Error: ${trimmed}`.slice(0, 280) : undefined;
}

async function jsonlFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [dir];
  while (queue.length) {
    const current = queue.pop()!;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
  }
  return files;
}

export function parseCodexRecords(records: Record<string, any>[], fileId = 'unknown', now = Date.now()): {
  session: AgentSession;
  messages: SessionMessage[];
  statusFacts: {
    updatedAt: string;
    lastRole?: AgentSession['lastRole'];
    completed: boolean;
    errored: boolean;
    explicitStatus?: SessionStatus;
    approvalRequested?: boolean;
    approvalRequestedAt?: string;
  };
} {
  const sessionMeta = records.find((record) => record.type === 'session_meta')?.payload || {};
  const meta = sessionMeta.meta || sessionMeta;
  const nativeId = String(meta.id || meta.session_id || fileId);
  const cwd = typeof meta.cwd === 'string' ? meta.cwd : undefined;
  const output: SessionMessage[] = [];
  let title: string | undefined;
  let lastRole: AgentSession['lastRole'];
  let lastMessage: string | undefined;
  let completed = false;
  let lastErrorIndex = -1;
  let lastErrorMessage: string | undefined;
  let lastActivityIndex = -1;
  let approvalRequested = false;
  let timestamp = meta.timestamp;
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    timestamp = record.timestamp || timestamp;
    const payload = record.payload || {};
    if (record.type === 'response_item') approvalRequested = false;
    if (record.type === 'response_item' && payload.type === 'message') {
      const role = payload.role;
      if (role === 'user' || role === 'assistant') lastActivityIndex = index;
      const text = textFromContent(payload.content);
      if (!text) continue;
      if (role === 'user') {
        output.push(message(text, 'user', record.timestamp));
        if (!title && !/<environment_context>|<instructions>|<system-reminder>/i.test(text)) {
          title = text.trim().slice(0, 180);
        }
        lastRole = 'user';
        lastMessage = text;
        completed = false;
      } else if (role === 'assistant') {
        output.push(message(text, 'assistant', record.timestamp));
        lastRole = 'assistant';
        lastMessage = text;
        completed = payload.phase === 'final' || payload.phase === 'complete';
      }
    }
    if (record.type === 'event_msg') {
      const kind = String(payload.type || '');
      approvalRequested = /approval_request$/.test(kind);
      const text = String(payload.message || payload.text || payload.content || '');
      if (kind === 'user_message' || kind === 'agent_message') {
        const role = kind === 'user_message' ? 'user' : 'assistant';
        lastActivityIndex = index;
        if (text) output.push(message(text, role, record.timestamp));
        if (role === 'user') {
          if (!title && text && !/<environment_context>|<instructions>/i.test(text)) title = text.trim().slice(0, 180);
          completed = false;
        } else completed = false;
        lastRole = role;
        lastMessage = text || lastMessage;
      } else if (kind === 'task_complete' || kind === 'turn_complete') {
        completed = true;
        lastRole = 'assistant';
        lastActivityIndex = index;
      } else if (kind === 'task_started') {
        completed = false;
        lastActivityIndex = index;
      } else if (kind === 'turn_aborted') {
        completed = true;
      } else if (kind === 'error') {
        lastErrorIndex = index;
        lastErrorMessage = typeof payload.message === 'string' ? payload.message : undefined;
      }
    }
  }
  const error = lastErrorIndex > lastActivityIndex;
  const updatedAt = isoOrNow(timestamp);
  const approvalTimestamp = typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp || ''));
  const approvalRequestedAt = Number.isFinite(approvalTimestamp) ? new Date(approvalTimestamp).toISOString() : undefined;
  const recentApproval = approvalRequested && approvalRequestedAt !== undefined
    && approvalTimestamp <= now && now - approvalTimestamp <= 30 * 60_000;
  const explicitStatus: SessionStatus | undefined = recentApproval ? 'needs_input' : undefined;
  const statusFacts = {
    updatedAt, lastRole, completed, errored: error, explicitStatus,
    ...(approvalRequested ? { approvalRequested: true, ...(approvalRequestedAt ? { approvalRequestedAt } : {}) } : {}),
  };
  return {
    session: buildSession({
      agent: 'codex', nativeId, title, cwd,
      branch: typeof sessionMeta.git?.branch === 'string' ? sessionMeta.git.branch
        : typeof meta.git_branch === 'string' ? meta.git_branch : undefined,
      updatedAt, startedAt: meta.timestamp,
      status: explicitStatus || inferStatus(updatedAt, lastRole, completed, error, now),
      lastMessage: error ? formatErrorMessage(lastErrorMessage)
        : explicitStatus && !lastMessage ? 'Waiting for approval' : lastMessage?.slice(-280),
      lastRole,
    }),
    messages: output,
    statusFacts,
  };
}

export class CodexCollector extends WatchedCollector {
  name = 'codex';
  private hookOverrides = new Map<string, HookOverride>();
  private approvalsClearedAt = new Map<string, number>();
  private readonly now: () => number;
  protected roots(): string[] { return [path.join(codexRoot(), 'sessions'), path.join(codexRoot(), 'archived_sessions')]; }
  protected watchTargets(): { paths: string[]; depth: number } { return { paths: this.roots(), depth: 3 }; }
  protected async findFiles(): Promise<string[]> {
    const files = [...await jsonlFiles(this.roots()[0]!), ...await jsonlFiles(this.roots()[1]!)];
    return this.recentFiles(files, this.days);
  }
  constructor(private days = 7, private readonly approvalHoldMs = 300_000, now: () => number = Date.now) {
    super();
    this.now = now;
  }
  private activeHookOverride(nativeId: string, now = this.now()): HookOverride | undefined {
    return activeHookOverride(this.hookOverrides, nativeId, now, this.approvalHoldMs);
  }
  protected shouldRetain(session: AgentSession): boolean {
    return Boolean(this.activeHookOverride(session.nativeId));
  }
  async applyHook(payload: CodexHookPayload, emit: EmitSession | undefined = this.emit): Promise<void> {
    if (!payload.session_id || !payload.hook_event_name) return;
    const status = mapCodexHook(payload.hook_event_name);
    if (!status) return;
    const now = this.now();
    const lastMessage = status === 'needs_input' ? payload.message || 'Waiting for approval' : undefined;
    this.hookOverrides.set(payload.session_id, {
      status,
      at: now,
      event: payload.hook_event_name,
      ...(lastMessage ? { message: lastMessage } : {}),
    });
    const id = `codex:${payload.session_id}`;
    const existing = this.sessions.get(id);
    const updated = existing
      ? {
        ...existing,
        status,
        updatedAt: new Date(now).toISOString(),
        lastMessage,
      }
      : buildSession({
        agent: 'codex',
        nativeId: payload.session_id,
        cwd: payload.cwd,
        title: 'Codex session',
        status,
        updatedAt: new Date(now).toISOString(),
        lastMessage,
      });
    this.sessions.set(updated.id, updated);
    emit?.(updated);
  }
  async clearNeedsInput(sessionId: string, emit: EmitSession | undefined = this.emit): Promise<void> {
    const nativeId = sessionId.startsWith('codex:') ? sessionId.slice('codex:'.length) : sessionId;
    const now = this.now();
    this.approvalsClearedAt.set(nativeId, now);
    const hook = this.activeHookOverride(nativeId, now);
    if (hook?.status === 'needs_input') this.hookOverrides.delete(nativeId);
    if (this.fileById.has(nativeId)) {
      await this.rescan();
      return;
    }
    if (!hook || hook.status !== 'needs_input') return;
    const existing = this.sessions.get(`codex:${nativeId}`);
    if (!existing) return;
    const updated = {
      ...existing,
      status: inferStatus(existing.updatedAt, existing.lastRole, false, false, now),
      updatedAt: new Date(now).toISOString(),
      lastMessage: undefined,
    };
    this.sessions.set(updated.id, updated);
    emit?.(updated);
  }
  protected refreshSession(parsed: ParsedWatchedSession, mtimeMs: number, now: number): AgentSession {
    const session = super.refreshSession(parsed, mtimeMs, now);
    const hook = this.activeHookOverride(session.nativeId, now);
    if (hook) {
      const override = hookOverrideForFile(mtimeMs, hook, now, this.approvalHoldMs);
      if (!override) {
        this.hookOverrides.delete(session.nativeId);
        return session;
      }
      return {
        ...session,
        status: override.status,
        lastMessage: override.message ?? session.lastMessage,
        updatedAt: new Date(Math.max(Date.parse(session.updatedAt), hook.at)).toISOString(),
      };
    }
    const facts = parsed.statusFacts;
    if (!facts?.approvalRequested) return session;
    const timestamp = Date.parse(facts.approvalRequestedAt || '');
    const clearedAt = this.approvalsClearedAt.get(session.nativeId);
    const clearedRequest = clearedAt !== undefined && timestamp <= clearedAt;
    const recent = !clearedRequest && Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= 30 * 60_000;
    if (recent) return { ...session, status: 'needs_input', lastMessage: parsed.session.lastMessage || 'Waiting for approval' };
    return {
      ...session,
      status: inferStatus(facts.updatedAt, facts.lastRole, facts.completed, facts.errored, now),
      lastMessage: parsed.session.lastMessage === 'Waiting for approval' ? undefined : parsed.session.lastMessage,
    };
  }
  protected async parse(file: string): Promise<ParsedWatchedSession | undefined> {
    const parsed = parseCodexRecords(await parseJsonLines(file), path.basename(file, '.jsonl'));
    return { session: parsed.session, statusFacts: parsed.statusFacts };
  }
  protected async messages(file: string, limit: number): Promise<SessionMessage[]> {
    return parseCodexRecords(await parseJsonLines(file), path.basename(file, '.jsonl')).messages.slice(-limit);
  }
}
