import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { agentHome } from '../config.js';
import type { AgentSession } from '@agent-hub/shared';
import type { Collector, EmitSession } from './types.js';

function cloudStatus(value: unknown): AgentSession['status'] {
  switch (String(value || '').toLowerCase()) {
    case 'working': case 'running': case 'in_progress': case 'pending': return 'working';
    case 'blocked': case 'needs_input': return 'needs_input';
    case 'finished': case 'completed': case 'done': return 'done';
    case 'error': case 'failed': return 'error';
    default: return 'idle';
  }
}

export class CodexCloudCollector implements Collector {
  name = 'codex-cloud';
  private timer?: NodeJS.Timeout;
  private emit?: EmitSession;
  private warned = false;
  private sessions = new Set<string>();
  constructor(private fetcher: typeof fetch = fetch) {}
  start(emit: EmitSession): void {
    this.emit = emit;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 60_000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }
  async getMessages(): Promise<[]> { return []; }
  private async poll(): Promise<void> {
    try {
      const auth = JSON.parse(await readFile(path.join(agentHome(), '.codex', 'auth.json'), 'utf8')) as any;
      const token = auth.tokens?.access_token || auth.access_token;
      let claims: any = {};
      try {
        claims = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8'));
      } catch { /* Some test and externally managed tokens are opaque. */ }
      const accountId = auth.tokens?.chatgpt_account_id || auth.tokens?.account_id
        || auth.chatgpt_account_id || auth.account_id || claims.auth?.chatgpt_account_id || claims.chatgpt_account_id;
      if (!token || !accountId) throw new Error('Codex auth token/account id unavailable');
      const response = await this.fetcher('https://chatgpt.com/backend-api/wham/tasks/list', {
        headers: { Authorization: `Bearer ${token}`, 'ChatGPT-Account-Id': String(accountId), 'User-Agent': 'codex-cli' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as any;
      const active = new Set<string>();
      for (const row of data.tasks || data.items || []) {
        const id = String(row.id || row.task_id || '');
        if (!id) continue;
        const session: AgentSession = {
          id: `codex-cloud:${id}`, agent: 'codex-cloud', nativeId: id,
          title: String(row.title || row.name || 'Codex Cloud task'),
          status: cloudStatus(row.status || row.status_enum),
          updatedAt: String(row.updated_at || row.created_at || new Date().toISOString()),
          ...(row.created_at ? { startedAt: String(row.created_at) } : {}),
          machine: os.hostname(),
        };
        active.add(session.id);
        this.emit?.(session);
      }
      for (const id of this.sessions) {
        if (!active.has(id)) this.emit?.remove?.(id);
      }
      this.sessions = active;
      this.warned = false;
    } catch (error) {
      if (!this.warned) console.warn(`[codex-cloud] experimental polling unavailable: ${(error as Error).message}`);
      this.warned = true;
    }
  }
}
