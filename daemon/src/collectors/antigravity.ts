import path from 'node:path';
import type { Dirent, Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { agentHome } from '../config.js';
import { buildSession, inferStatus, isoOrNow, message, parseJsonLines, textFromContent } from './files.js';
import { WatchedCollector } from './watched.js';
import type { ParsedWatchedSession } from './watched.js';
import type { AgentSession, SessionMessage } from '@agent-hub/shared';

function antigravityRoots(): string[] {
  const home = agentHome();
  return [
    path.join(home, '.gemini', 'antigravity-ide'),
    path.join(home, '.gemini', 'antigravity'),
    path.join(home, '.gemini', 'antigravity-cli'),
  ];
}

function normalizeWatchPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function parseAntigravityRecords(records: Record<string, any>[], id: string, modifiedAt: string, now = Date.now()): {
  session: AgentSession;
  messages: SessionMessage[];
  statusFacts: { updatedAt: string; lastRole?: AgentSession['lastRole']; completed: boolean; errored: boolean };
} {
  let title: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  let lastRole: AgentSession['lastRole'];
  let lastMessage: string | undefined;
  let complete = false;
  let lastErrorIndex = -1;
  let lastActivityIndex = -1;
  let updatedAt = modifiedAt;
  const messages: SessionMessage[] = [];
  for (let index = 0; index < records.length; index++) {
    const row = records[index]!;
    const kind = String(row.type || row.role || row.event || '').toLowerCase();
    let text = typeof row.text === 'string' ? row.text : textFromContent(row.content ?? row.message?.content) || row.message?.text;
    if (typeof text === 'string') {
      text = text.replace(/^<USER_REQUEST>\s*/i, '').replace(/\s*<\/USER_REQUEST>$/i, '');
    }
    const roleName = String(row.role || row.source || row.message?.role || kind).toLowerCase();
    const role = roleName.includes('user') || roleName.includes('human') ? 'user'
      : roleName.includes('assistant') || roleName.includes('model') || roleName.includes('agent') ? 'assistant'
        : roleName.includes('system') || roleName.includes('tool') ? 'tool' : undefined;
    if (typeof row.cwd === 'string') cwd = row.cwd;
    if (typeof row.branch === 'string') branch = row.branch;
    if (row.timestamp || row.created_at || row.at) {
      const at = isoOrNow(row.timestamp || row.created_at || row.at);
      if (Date.parse(at) > Date.parse(updatedAt)) updatedAt = at;
    }
    if (role && typeof text === 'string' && text.trim()) {
      messages.push(message(text, role, row.timestamp));
      if (role === 'user' && !title) title = text.trim().slice(0, 180);
      lastRole = role;
      lastMessage = text;
      if (role === 'user' || role === 'assistant') lastActivityIndex = index;
      complete = role === 'assistant' && (row.turnComplete === true || row.completed === true
        || String(row.status || '').toUpperCase() === 'DONE' || kind.includes('complete'));
    }
    if (/error|fail/.test(kind) || ['ERROR', 'FAILED'].includes(String(row.status || '').toUpperCase())) {
      lastErrorIndex = index;
    }
    if (/turn[_-]?complete|task[_-]?complete/.test(kind)) {
      complete = true;
      lastRole = 'assistant';
      lastActivityIndex = index;
    }
  }
  const error = lastErrorIndex > lastActivityIndex;
  const session = buildSession({
    agent: 'antigravity',
    nativeId: id,
    title: title || `Antigravity conversation ${id.slice(0, 8)}`,
    cwd,
    branch,
    updatedAt,
    status: inferStatus(updatedAt, lastRole, complete, error, now),
    lastMessage: lastMessage?.slice(-280),
    lastRole,
  });
  return { session, messages, statusFacts: { updatedAt, lastRole, completed: complete, errored: error } };
}

export class AntigravityCollector extends WatchedCollector {
  name = 'antigravity';
  private messagesByFile = new Map<string, SessionMessage[]>();
  private transcriptById = new Map<string, string>();
  protected roots(): string[] { return antigravityRoots(); }
  protected watchTargets(): {
    paths: string[];
    depth: number;
    ignored: (path: string, stats?: Stats) => boolean;
  } {
    const roots = this.roots();
    const brainRoots = roots.map((root) => normalizeWatchPath(path.join(root, 'brain')));
    return {
      paths: [
        ...roots.map((root) => path.join(root, 'conversations')),
        ...roots.map((root) => path.join(root, 'brain')),
      ],
      depth: 3,
      ignored: (targetPath: string, _stats?: Stats) => {
        const normalizedPath = normalizeWatchPath(targetPath);
        for (const brainRoot of brainRoots) {
          if (normalizedPath === brainRoot) return false;
          if (!normalizedPath.startsWith(`${brainRoot}/`)) continue;
          const parts = normalizedPath.slice(brainRoot.length + 1).split('/');
          const allowed = parts.length === 1
            || (parts.length === 2 && parts[1] === '.system_generated')
            || (parts.length === 3 && parts[1] === '.system_generated' && parts[2] === 'logs')
            || (parts.length === 4 && parts[1] === '.system_generated' && parts[2] === 'logs' && parts[3] === 'transcript.jsonl');
          return !allowed;
        }
        return false;
      },
    };
  }
  constructor(private days = 7) { super(); }
  protected async findFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const root of this.roots()) {
      const conversations = path.join(root, 'conversations');
      let conversationEntries: Dirent[];
      try { conversationEntries = await readdir(conversations, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        conversationEntries = [];
      }
      for (const entry of conversationEntries) {
        if (entry.isFile() && (entry.name.endsWith('.db') || entry.name.endsWith('.pb'))) {
          files.push(path.join(conversations, entry.name));
        }
      }

      const brain = path.join(root, 'brain');
      let brainEntries: Dirent[];
      try { brainEntries = await readdir(brain, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        brainEntries = [];
      }
      for (const entry of brainEntries) {
        if (!entry.isDirectory()) continue;
        const transcript = path.join(brain, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        try {
          if ((await stat(transcript)).isFile()) files.push(transcript);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    const recent = new Set(await this.recentFiles(files, this.days));
    const idOf = (file: string) => file.endsWith('transcript.jsonl')
      ? path.basename(path.dirname(path.dirname(path.dirname(file))))
      : path.basename(file, path.extname(file));
    const recentDatabaseIds = new Set(files.filter((file) =>
      ['.db', '.pb'].includes(path.extname(file)) && recent.has(file)).map(idOf));
    const transcripts = files.filter((file) => file.endsWith('transcript.jsonl')
      && (recent.has(file) || recentDatabaseIds.has(idOf(file))));
    const transcriptIds = new Set(transcripts.map(idOf));
    const databases = files.filter((file) => ['.db', '.pb'].includes(path.extname(file))
      && recent.has(file) && !transcriptIds.has(idOf(file)));
    return [...transcripts, ...databases];
  }
  protected async fileCacheKey(file: string, mtimeMs: number, size: number): Promise<string> {
    if (!file.endsWith('transcript.jsonl')) return `${mtimeMs}:${size}`;
    const id = path.basename(path.dirname(path.dirname(path.dirname(file))));
    const companionStats: string[] = [];
    for (const root of this.roots()) {
      for (const extension of ['.db', '.pb']) {
        try {
          const info = await stat(path.join(root, 'conversations', `${id}${extension}`));
          companionStats.push(`${info.mtimeMs}:${info.size}`);
        } catch { /* Optional sibling file. */ }
      }
    }
    return `${mtimeMs}:${size}:${companionStats.join(',')}`;
  }
  protected async parse(file: string): Promise<ParsedWatchedSession | undefined> {
    const isTranscript = file.endsWith('transcript.jsonl');
    const id = isTranscript
      ? path.basename(path.dirname(path.dirname(path.dirname(file))))
      : path.basename(file, path.extname(file));
    const activityFiles = [file];
    if (isTranscript) {
      activityFiles.push(
        ...this.roots().flatMap((root) => [
          path.join(root, 'conversations', `${id}.db`),
          path.join(root, 'conversations', `${id}.pb`),
        ]),
      );
    }
    let activityTime = 0;
    for (const candidate of activityFiles) {
      try { activityTime = Math.max(activityTime, (await stat(candidate)).mtimeMs); } catch { /* Optional sibling file. */ }
    }
    const modifiedAt = new Date(activityTime || Date.now()).toISOString();
    const records = isTranscript ? await parseJsonLines(file) : [];
    const parsed = parseAntigravityRecords(records, id, modifiedAt);
    this.messagesByFile.set(file, parsed.messages);
    if (isTranscript) this.transcriptById.set(id, file);
    return { session: parsed.session, statusFacts: parsed.statusFacts };
  }
  protected async messages(file: string, limit: number): Promise<SessionMessage[]> {
    if (!this.messagesByFile.has(file)) await this.parse(file);
    return (this.messagesByFile.get(file) || []).slice(-limit);
  }
  async getMessages(nativeId: string, limit: number): Promise<SessionMessage[]> {
    const file = this.transcriptById.get(nativeId);
    return file ? this.messages(file, limit) : [];
  }
}
