import { watch, type FSWatcher } from 'chokidar';
import { setTimeout as delay } from 'node:timers/promises';
import { filesModifiedAfter } from './files.js';
import type { Collector, EmitSession } from './types.js';
import type { AgentSession, SessionMessage } from '@agent-hub/shared';

export abstract class WatchedCollector implements Collector {
  abstract name: string;
  protected emit?: EmitSession;
  protected watcher?: FSWatcher;
  protected timer?: NodeJS.Timeout;
  protected readonly fileById = new Map<string, string>();
  protected readonly sessions = new Map<string, AgentSession>();

  protected abstract roots(): string[];
  protected abstract findFiles(): Promise<string[]>;
  protected abstract parse(file: string): Promise<AgentSession | undefined>;
  protected abstract messages(file: string, limit: number): Promise<SessionMessage[]>;
  protected shouldRetain(_session: AgentSession): boolean { return false; }

  start(emit: EmitSession): void {
    this.emit = emit;
    const roots = this.roots();
    this.watcher = watch(roots, {
      ignoreInitial: true,
      usePolling: process.env.AGENT_HUB_USE_POLLING === 'true',
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    this.watcher.on('add', () => void this.rescan());
    this.watcher.on('change', () => void this.rescan());
    this.watcher.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[${this.name}] watcher failed: ${message}`);
    });
    this.timer = setInterval(() => void this.rescan(), 15_000);
    void this.rescan();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.watcher?.close();
  }

  async getMessages(nativeId: string, limit: number): Promise<SessionMessage[]> {
    const file = this.fileById.get(nativeId);
    return file ? this.messages(file, limit) : [];
  }

  protected async recentFiles(files: string[], days: number): Promise<string[]> {
    return filesModifiedAfter(files, Date.now() - days * 24 * 60 * 60 * 1000);
  }

  private async rescan(): Promise<void> {
    if (!this.emit) return;
    try {
      const files = await this.findFiles();
      const active = new Set<string>();
      for (const file of files) {
        const session = await this.parse(file);
        if (!session) continue;
        active.add(session.id);
        this.fileById.set(session.nativeId, file);
        const old = this.sessions.get(session.id);
        this.sessions.set(session.id, session);
        if (!old || old.updatedAt !== session.updatedAt || old.status !== session.status || old.title !== session.title) {
          this.emit(session);
        }
      }
      for (const [id, session] of this.sessions) {
        if (active.has(id) || this.shouldRetain(session)) continue;
        this.sessions.delete(id);
        this.fileById.delete(session.nativeId);
        this.emit.remove?.(id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[${this.name}] scan failed: ${message}`);
    }
  }
}

export async function waitForScan(): Promise<void> {
  await delay(0);
}
