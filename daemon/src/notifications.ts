import type { AgentSession, SessionStatus } from '@agent-hub/shared';

export class NtfyNotifier {
  private previous = new Map<string, SessionStatus>();
  private sentAt = new Map<string, number>();
  constructor(private config?: { server: string; topic: string }) {}

  async update(session: AgentSession): Promise<void> {
    const previous = this.previous.get(session.id);
    this.previous.set(session.id, session.status);
    if (!this.config || previous === session.status || !['needs_input', 'done', 'error'].includes(session.status)) return;
    const now = Date.now();
    if (now - (this.sentAt.get(session.id) || 0) < 30_000) return;
    this.sentAt.set(session.id, now);
    try {
      await fetch(`${this.config.server.replace(/\/$/, '')}/${encodeURIComponent(this.config.topic)}`, {
        method: 'POST',
        headers: { Title: `${session.agent} ${session.status.replace('_', ' ')} — ${session.project || session.title}` },
        body: session.lastMessage || `${session.title} is ${session.status.replace('_', ' ')}.`,
      });
    } catch {
      console.warn('[ntfy] notification delivery failed');
    }
  }
}
