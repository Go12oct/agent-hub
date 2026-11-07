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
  private pendingClears = new Set<string>();
  private clearing = new Map<string, Promise<void>>();
  constructor(private config?: { server?: string; topic: string }, private fetchImpl: typeof fetch = fetch) {}

  async update(session: AgentSession): Promise<void> {
    const previous = this.previous.get(session.id);
    const approvals = session.approvals ?? (session.approval ? [session.approval] : []);
    const approvalIds = new Set(approvals.map((item) => item.id));
    const currentState = { status: session.status, approvalIds };
    this.previous.set(session.id, currentState);
    if (!this.config?.topic) return;

    const removedApprovals = [...(previous?.approvalIds ?? [])].filter((id) => !approvalIds.has(id));
    const sessionNeedsYouCleared = previous?.status === 'needs_input' && session.status !== 'needs_input';
    for (const id of removedApprovals) this.queueClear(`ah-${id}`);
    if (sessionNeedsYouCleared) this.queueClear(sessionNotificationSequence(session.id));
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
    const shouldPublish = changed
      && ['needs_input', 'done', 'error'].includes(session.status)
      && (newApprovals.length > 0 || now - (this.sentAt.get(session.id) || 0) >= 30_000);
    const messages = shouldPublish
      ? newApprovals.length
        ? newApprovals.map((approval) => ({
          sequenceId: `ah-${approval.id}`,
          message: ntfyMessage({ ...session, approval, approvals: [approval] }),
        }))
        : [{
          sequenceId: sessionNotificationSequence(session.id),
          message: ntfyMessage({ ...session, approval: undefined }),
        }]
      : [];
    for (const { sequenceId } of messages) this.pendingClears.delete(sequenceId);

    const pendingRetries = this.pendingClears.size ? this.retryPendingClears() : undefined;
    if (pendingRetries) await pendingRetries;
    if (!this.isCurrentState(session.id, currentState)) return;
    if (!shouldPublish) return;
    this.sentAt.set(session.id, now);
    for (const { sequenceId, message } of messages) {
      if (!this.isCurrentState(session.id, currentState)) return;
      const clearing = this.clearing.get(sequenceId);
      if (clearing) await clearing;
      if (!this.isCurrentState(session.id, currentState)) return;
      this.pendingClears.delete(sequenceId);
      await this.publish(message, sequenceId, session.id);
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

  private queueClear(sequenceId: string): void {
    this.pendingClears.add(sequenceId);
    while (this.pendingClears.size > 200) {
      const oldest = this.pendingClears.values().next().value;
      if (oldest === undefined) break;
      this.pendingClears.delete(oldest);
    }
  }

  private isSequenceLive(sequenceId: string): boolean {
    if (!sequenceId.startsWith('ah-')) return false;
    const approvalId = sequenceId.slice(3);
    for (const [sessionId, previous] of this.previous) {
      if (previous.approvalIds.has(approvalId)) return true;
      if (previous.status === 'needs_input' && sessionNotificationSequence(sessionId) === sequenceId) return true;
    }
    return false;
  }

  private isCurrentState(
    sessionId: string,
    state: { status: SessionStatus; approvalIds: Set<string> },
  ): boolean {
    const current = this.previous.get(sessionId);
    return current === state || Boolean(current
      && current.status === state.status
      && current.approvalIds.size === state.approvalIds.size
      && [...current.approvalIds].every((id) => state.approvalIds.has(id)));
  }

  private retryPendingClears(): Promise<void> | undefined {
    const retries: Promise<void>[] = [];
    for (const sequenceId of [...this.pendingClears]) {
      const inFlight = this.clearing.get(sequenceId);
      if (this.isSequenceLive(sequenceId)) {
        this.pendingClears.delete(sequenceId);
        if (inFlight) retries.push(inFlight);
        continue;
      }
      if (inFlight) {
        retries.push(inFlight);
        continue;
      }
      let clearing: Promise<void>;
      clearing = this.clear(sequenceId)
        .then((cleared) => {
          if (cleared || this.isSequenceLive(sequenceId)) this.pendingClears.delete(sequenceId);
        })
        .finally(() => {
          if (this.clearing.get(sequenceId) === clearing) this.clearing.delete(sequenceId);
        });
      this.clearing.set(sequenceId, clearing);
      retries.push(clearing);
    }
    return retries.length ? Promise.all(retries).then(() => undefined) : undefined;
  }

  private async clear(sequenceId: string): Promise<boolean> {
    const url = `${(this.config!.server || defaultNtfyServer).replace(/\/$/, '')}/${encodeURIComponent(this.config!.topic)}/${encodeURIComponent(sequenceId)}/clear`;
    try {
      const response = await this.fetchImpl(url, { method: 'PUT' });
      if (!response.ok) {
        console.warn('[ntfy] notification clear failed');
        return false;
      }
      return true;
    } catch {
      console.warn('[ntfy] notification clear failed');
      return false;
    }
  }
}
