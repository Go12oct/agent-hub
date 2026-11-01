import { watch, type FSWatcher } from 'chokidar';
import { setImmediate as yieldToEventLoop, setTimeout as delay } from 'node:timers/promises';
import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { filesModifiedAfter, inferStatus } from './files.js';
import type { Collector, EmitSession } from './types.js';
import type { AgentSession, SessionMessage, SessionStatus } from '@agent-hub/shared';

export interface SessionStatusFacts {
  updatedAt: string;
  lastRole?: AgentSession['lastRole'];
  completed: boolean;
  errored: boolean;
  explicitStatus?: SessionStatus;
}

export interface ParsedWatchedSession {
  session: AgentSession;
  statusFacts?: SessionStatusFacts;
}

interface CachedFile {
  key: string;
  mtimeMs: number;
  parsed: ParsedWatchedSession;
}

export abstract class WatchedCollector implements Collector {
  abstract name: string;
  protected emit?: EmitSession;
  protected watcher?: FSWatcher;
  protected timer?: NodeJS.Timeout;
  protected readonly fileById = new Map<string, string>();
  protected readonly sessions = new Map<string, AgentSession>();
  private readonly parsedFiles = new Map<string, CachedFile>();
  private rescanTimer?: NodeJS.Timeout;
  private scanPromise?: Promise<void>;
  private scanPending = false;
  private stopped = false;

  protected abstract roots(): string[];
  protected abstract findFiles(): Promise<string[]>;
  protected abstract parse(file: string): Promise<ParsedWatchedSession | undefined>;
  protected abstract messages(file: string, limit: number): Promise<SessionMessage[]>;
  protected watchTargets(): {
    paths: string[];
    depth?: number;
    ignored?: (path: string, stats?: Stats) => boolean;
  } { return { paths: this.roots() }; }
  protected shouldRetain(_session: AgentSession): boolean { return false; }
  protected async fileCacheKey(_file: string, mtimeMs: number, size: number): Promise<string> {
    return `${mtimeMs}:${size}`;
  }
  protected refreshSession(parsed: ParsedWatchedSession, _mtimeMs: number, now: number): AgentSession {
    const facts = parsed.statusFacts;
    return facts
      ? { ...parsed.session, status: facts.explicitStatus || inferStatus(facts.updatedAt, facts.lastRole, facts.completed, facts.errored, now) }
      : parsed.session;
  }

  start(emit: EmitSession): void {
    this.emit = emit;
    this.stopped = false;
    const { paths, depth, ignored } = this.watchTargets();
    this.watcher = watch(paths, {
      ignoreInitial: true,
      usePolling: process.env.AGENT_HUB_USE_POLLING === 'true',
      ignored: (targetPath, stats) => {
        const normalizedPath = targetPath.replace(/\\/g, '/');
        return /(^|\/)(node_modules|\.git|worktrees)(\/|$)/i.test(normalizedPath)
          || (ignored?.(normalizedPath, stats) ?? false);
      },
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ...(depth === undefined ? {} : { depth }),
    });
    this.watcher.on('add', () => this.scheduleRescan());
    this.watcher.on('change', () => this.scheduleRescan());
    this.watcher.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[${this.name}] watcher failed: ${message}`);
    });
    this.timer = setInterval(() => this.scheduleRescan(), 15_000);
    this.scheduleRescan();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    await this.watcher?.close();
    await this.scanPromise;
  }

  async getMessages(nativeId: string, limit: number): Promise<SessionMessage[]> {
    const file = this.fileById.get(nativeId);
    return file ? this.messages(file, limit) : [];
  }

  protected async recentFiles(files: string[], days: number): Promise<string[]> {
    return filesModifiedAfter(files, Date.now() - days * 24 * 60 * 60 * 1000);
  }

  protected async rescan(): Promise<void> {
    if (!this.emit || this.stopped) return;
    const startedAt = Date.now();
    let fileCount = 0;
    let parsedCount = 0;
    try {
      const files = await this.findFiles();
      fileCount = files.length;
      const present = new Set(files);
      const active = new Set<string>();
      for (let index = 0; index < files.length; index++) {
        if (index > 0 && index % 20 === 0) await yieldToEventLoop();
        const file = files[index]!;
        let fileStat;
        try { fileStat = await stat(file); } catch { continue; }
        const key = await this.fileCacheKey(file, fileStat.mtimeMs, fileStat.size);
        let cached = this.parsedFiles.get(file);
        if (!cached || cached.key !== key) {
          const parsed = await this.parse(file);
          parsedCount++;
          if (!parsed) {
            this.parsedFiles.delete(file);
            continue;
          }
          cached = { key, mtimeMs: fileStat.mtimeMs, parsed };
          this.parsedFiles.set(file, cached);
        }
        const session = this.refreshSession(cached.parsed, cached.mtimeMs, Date.now());
        active.add(session.id);
        this.fileById.set(session.nativeId, file);
        const old = this.sessions.get(session.id);
        this.sessions.set(session.id, session);
        if (!old || old.updatedAt !== session.updatedAt || old.status !== session.status || old.title !== session.title) {
          this.emit(session);
        }
      }
      for (const file of this.parsedFiles.keys()) {
        if (!present.has(file)) this.parsedFiles.delete(file);
      }
      for (const [id, session] of this.sessions) {
        if (active.has(id) || this.shouldRetain(session)) continue;
        this.sessions.delete(id);
        this.fileById.delete(session.nativeId);
        this.emit.remove?.(id);
      }
      console.log(`[${this.name}] rescan: ${fileCount} files, ${parsedCount} parsed, ${Date.now() - startedAt} ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[${this.name}] rescan failed after ${Date.now() - startedAt} ms: ${message}`);
    }
  }

  private scheduleRescan(): void {
    if (!this.emit || this.stopped) return;
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      void this.runRescan();
    }, 1_000);
  }

  private async runRescan(): Promise<void> {
    if (this.scanPromise) {
      this.scanPending = true;
      return;
    }
    this.scanPending = false;
    const scan = this.rescan();
    this.scanPromise = scan;
    try {
      await scan;
    } finally {
      this.scanPromise = undefined;
      if (this.scanPending && !this.rescanTimer && !this.stopped) {
        this.scanPending = false;
        void this.runRescan();
      }
    }
  }
}

export async function waitForScan(): Promise<void> {
  await delay(0);
}
