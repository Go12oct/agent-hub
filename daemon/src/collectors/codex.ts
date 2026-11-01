import path from 'node:path';
import { readdir } from 'node:fs/promises';
import type { AgentSession, SessionMessage } from '@agent-hub/shared';
import { agentHome } from '../config.js';
import { buildSession, inferStatus, isoOrNow, message, parseJsonLines, textFromContent } from './files.js';
import { WatchedCollector } from './watched.js';

function codexRoot(): string {
  return process.env.CODEX_HOME || path.join(agentHome(), '.codex');
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

export function parseCodexRecords(records: Record<string, any>[], fileId = 'unknown', now = Date.now()): { session: AgentSession; messages: SessionMessage[] } {
  const sessionMeta = records.find((record) => record.type === 'session_meta')?.payload || {};
  const meta = sessionMeta.meta || sessionMeta;
  const nativeId = String(meta.id || meta.session_id || fileId);
  const cwd = typeof meta.cwd === 'string' ? meta.cwd : undefined;
  const output: SessionMessage[] = [];
  let title: string | undefined;
  let lastRole: AgentSession['lastRole'];
  let lastMessage: string | undefined;
  let completed = false;
  let error = false;
  let timestamp = meta.timestamp;
  for (const record of records) {
    timestamp = record.timestamp || timestamp;
    const payload = record.payload || {};
    if (record.type === 'response_item' && payload.type === 'message') {
      const role = payload.role;
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
      const kind = payload.type;
      const text = String(payload.message || payload.text || payload.content || '');
      if (kind === 'user_message' || kind === 'agent_message') {
        const role = kind === 'user_message' ? 'user' : 'assistant';
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
      } else if (kind === 'turn_aborted' || kind === 'error') error = true;
    }
  }
  const updatedAt = isoOrNow(timestamp);
  return {
    session: buildSession({
      agent: 'codex', nativeId, title, cwd,
      branch: typeof sessionMeta.git?.branch === 'string' ? sessionMeta.git.branch
        : typeof meta.git_branch === 'string' ? meta.git_branch : undefined,
      updatedAt, startedAt: meta.timestamp, status: inferStatus(updatedAt, lastRole, completed, error, now),
      lastMessage: lastMessage?.slice(-280), lastRole,
    }),
    messages: output,
  };
}

export class CodexCollector extends WatchedCollector {
  name = 'codex';
  protected roots(): string[] { return [path.join(codexRoot(), 'sessions'), path.join(codexRoot(), 'archived_sessions')]; }
  protected async findFiles(): Promise<string[]> {
    const files = [...await jsonlFiles(this.roots()[0]!), ...await jsonlFiles(this.roots()[1]!)];
    return this.recentFiles(files, this.days);
  }
  constructor(private days = 7) { super(); }
  protected async parse(file: string): Promise<AgentSession | undefined> {
    const parsed = parseCodexRecords(await parseJsonLines(file), path.basename(file, '.jsonl'));
    return parsed.session;
  }
  protected async messages(file: string, limit: number): Promise<SessionMessage[]> {
    return parseCodexRecords(await parseJsonLines(file), path.basename(file, '.jsonl')).messages.slice(-limit);
  }
}
