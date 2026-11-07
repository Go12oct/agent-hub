import type { AgentSession, PendingApproval, SessionMessage } from '@agent-hub/shared';

export type QueueItem =
  | { kind: 'approval'; session: AgentSession; approval: PendingApproval }
  | { kind: 'input'; session: AgentSession };

export function approvalQueue(sessions: AgentSession[], hidden: ReadonlySet<string>): QueueItem[] {
  return sessions.flatMap((session): QueueItem[] => {
    if (session.status !== 'needs_input') return [];
    const approvals = session.approvals ?? (session.approval ? [session.approval] : []);
    if (!approvals.length) {
      return hidden.has(`input:${session.id}`) ? [] : [{ kind: 'input', session }];
    }
    return approvals
      .filter((approval) => !hidden.has(approval.id))
      .map((approval) => ({ kind: 'approval', session, approval }));
  }).sort((a, b) => {
    const aAt = Date.parse(a.kind === 'approval' ? a.approval.requestedAt : a.session.updatedAt);
    const bAt = Date.parse(b.kind === 'approval' ? b.approval.requestedAt : b.session.updatedAt);
    return (Number.isNaN(aAt) ? 0 : aAt) - (Number.isNaN(bAt) ? 0 : bAt);
  });
}

export function activityBuckets(
  messages: SessionMessage[],
  now: number,
  buckets = 30,
  windowMs = 3_600_000,
): number[] {
  if (buckets <= 0) return [];
  const counts = Array.from({ length: buckets }, () => 0);
  const start = now - windowMs;
  messages.forEach(({ at }) => {
    if (!at) return;
    const timestamp = Date.parse(at);
    if (!Number.isFinite(timestamp) || timestamp <= start || timestamp > now) return;
    const index = Math.min(buckets - 1, Math.floor(((timestamp - start) / windowMs) * buckets));
    counts[index]! += 1;
  });
  return counts;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}
