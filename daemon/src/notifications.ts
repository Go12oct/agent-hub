import { agentLabels, type AgentSession, type SessionStatus } from '@agent-hub/shared';

export const defaultNtfyServer = 'https://ntfy.sh';

export function sessionDeepLink(sessionId: string): string {
  return `agenthub://session/${encodeURIComponent(sessionId)}`;
}

export function ntfyMessage(session: AgentSession): { title: string; body: string; priority: string; tags: string } {
  const label = agentLabels[session.agent];
  const where = session.project || session.title;
  const lastMessage = session.lastMessage;
  if (session.agent === 'devin' && session.status === 'needs_input' && lastMessage?.startsWith('Devin is asking for a secret')) {
    return { title: `Devin needs a secret — ${where}`, body: lastMessage, priority: 'high', tags: 'raised_hand' };
  }
  if (session.status === 'needs_input' && session.approval) {
    return {
      title: `${label} wants permission — ${where}`,
      body: `Claude wants to use ${session.approval.toolName}. Open Agent Hub to see the request and allow or deny it.`,
      priority: 'high',
      tags: 'raised_hand',
    };
  }
  if (session.status === 'needs_input') {
    return { title: `${label} needs you — ${where}`, body: session.lastMessage || `${session.title} is waiting for your input.`, priority: 'high', tags: 'raised_hand' };
  }
  if (session.status === 'error') {
    return { title: `${label} hit an error — ${where}`, body: session.lastMessage || `${session.title} stopped with an error.`, priority: 'default', tags: 'x' };
  }
  return { title: `${label} finished — ${where}`, body: session.lastMessage || `${session.title} is done.`, priority: 'default', tags: 'white_check_mark' };
}

export class NtfyNotifier {
  private previous = new Map<string, { status: SessionStatus; approvalIds: Set<string> }>();
  private sentAt = new Map<string, number>();
  constructor(private config?: { server?: string; topic: string }, private fetchImpl: typeof fetch = fetch) {}

  async update(session: AgentSession): Promise<void> {
    const previous = this.previous.get(session.id);
    const approvals = session.approvals ?? (session.approval ? [session.approval] : []);
    this.previous.set(session.id, { status: session.status, approvalIds: new Set(approvals.map((item) => item.id)) });
    if (!this.config?.topic) return;
    const newApproval = approvals.find((item) => !previous?.approvalIds.has(item.id));
    const now = Date.now();
    const updatedAt = Date.parse(session.updatedAt);
    const firstSeen = previous === undefined;
    const freshTerminalState = ['needs_input', 'done', 'error'].includes(session.status)
      && Number.isFinite(updatedAt)
      && updatedAt <= now
      && now - updatedAt <= 120_000;
    const changed = firstSeen
      ? approvals.length > 0 || freshTerminalState
      : previous.status !== session.status || Boolean(newApproval);
    if (!changed || !['needs_input', 'done', 'error'].includes(session.status)) return;
    if (!newApproval && now - (this.sentAt.get(session.id) || 0) < 30_000) return;
    this.sentAt.set(session.id, now);
    const message = ntfyMessage(newApproval ? { ...session, approval: newApproval } : { ...session, approval: undefined });
    try {
      await this.fetchImpl(`${(this.config.server || defaultNtfyServer).replace(/\/$/, '')}/${encodeURIComponent(this.config.topic)}`, {
        method: 'POST',
        headers: {
          Title: message.title.replace(/[^\x20-\x7E]/g, '-'),
          Priority: message.priority,
          Tags: message.tags,
          Click: sessionDeepLink(session.id),
        },
        body: message.body,
      });
    } catch {
      console.warn('[ntfy] notification delivery failed');
    }
  }
}
