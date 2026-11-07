import { createHash } from 'node:crypto';
import { agentLabels, type AgentSession, type SessionStatus } from '@agent-hub/shared';

export const defaultNtfyServer = 'https://ntfy.sh';

export function sessionDeepLink(sessionId: string): string {
  return `agenthub://session/${encodeURIComponent(sessionId)}`;
}

export function ntfyMessage(session: AgentSession): { title: string; body: string; priority: string; tags: string } {
  const label = agentLabels[session.agent];
  const where = session.project || session.title;
  if (session.status === 'needs_input' && session.approval) {
    if (session.approval.toolName === 'AskUserQuestion' && session.approval.questions?.length) {
      return {
        title: `${label} has a question — ${where}`,
        body: session.approval.questions[0]!.question,
        priority: 'high',
        tags: 'raised_hand',
      };
    }
    return {
      title: `${label} wants permission — ${where}`,
      body: `${label} wants to use ${session.approval.toolName}. Open Agent Hub to see the request and allow or deny it.`,
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

export function sessionNotificationSequence(sessionId: string): string {
  return `ah-s-${createHash('sha1').update(sessionId).digest('hex').slice(0, 32)}`;
}

export class NtfyNotifier {
  private previous = new Map<string, { status: SessionStatus; approvalIds: Set<string> }>();
  private sentAt = new Map<string, number>();
  constructor(private config?: { server?: string; topic: string }, private fetchImpl: typeof fetch = fetch) {}

  async update(session: AgentSession): Promise<void> {
    const previous = this.previous.get(session.id);
    const approvals = session.approvals ?? (session.approval ? [session.approval] : []);
    const approvalIds = new Set(approvals.map((item) => item.id));
    this.previous.set(session.id, { status: session.status, approvalIds });
    if (!this.config?.topic) return;
    const removedApprovals = [...(previous?.approvalIds ?? [])].filter((id) => !approvalIds.has(id));
    const sessionNeedsYouCleared = previous?.status === 'needs_input' && session.status !== 'needs_input';
    for (const id of removedApprovals) await this.clear(`ah-${id}`);
    if (sessionNeedsYouCleared) await this.clear(sessionNotificationSequence(session.id));

    const newApprovals = approvals.filter((item) => !previous?.approvalIds.has(item.id));
    const now = Date.now();
    const updatedAt = Date.parse(session.updatedAt);
    const firstSeen = previous === undefined;
    const freshTerminalState = ['needs_input', 'done', 'error'].includes(session.status)
      && Number.isFinite(updatedAt)
      && updatedAt <= now
      && now - updatedAt <= 120_000;
    const changed = firstSeen
      ? approvals.length > 0 || freshTerminalState
      : previous.status !== session.status || newApprovals.length > 0;
    if (!changed || !['needs_input', 'done', 'error'].includes(session.status)) return;
    if (!newApprovals.length && now - (this.sentAt.get(session.id) || 0) < 30_000) return;
    this.sentAt.set(session.id, now);
    const messages = newApprovals.length
      ? newApprovals.map((approval) => ({ approval, message: ntfyMessage({ ...session, approval, approvals: [approval] }) }))
      : [{ approval: undefined, message: ntfyMessage({ ...session, approval: undefined }) }];
    for (const { approval, message } of messages) {
      await this.publish(message, approval ? `ah-${approval.id}` : sessionNotificationSequence(session.id), session.id);
    }
  }

  private async publish(message: ReturnType<typeof ntfyMessage>, sequenceId: string, sessionId: string): Promise<void> {
    const url = `${(this.config!.server || defaultNtfyServer).replace(/\/$/, '')}/${encodeURIComponent(this.config!.topic)}`;
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Title: message.title.replace(/[^\x20-\x7E]/g, '-'),
          Priority: message.priority,
          Tags: message.tags,
          Click: sessionDeepLink(sessionId),
          'X-Sequence-ID': sequenceId,
        },
        body: message.body,
      });
      if (!response.ok) console.warn('[ntfy] notification delivery failed');
    } catch {
      console.warn('[ntfy] notification delivery failed');
    }
  }

  private async clear(sequenceId: string): Promise<void> {
    const url = `${(this.config!.server || defaultNtfyServer).replace(/\/$/, '')}/${encodeURIComponent(this.config!.topic)}/${encodeURIComponent(sequenceId)}/clear`;
    try {
      const response = await this.fetchImpl(url, { method: 'PUT' });
      if (!response.ok) console.warn('[ntfy] notification clear failed');
    } catch {
      console.warn('[ntfy] notification clear failed');
    }
  }
}
