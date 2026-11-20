import type { AgentSession } from '@agent-hub/shared';

export function localNotificationId(key: string): number {
  let hash = 0;
  for (const character of key) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) & 0x7fffffff;
  return hash || 1;
}

export function liveNotificationIds(sessions: AgentSession[]): Set<number> {
  const ids = new Set<number>();
  for (const session of sessions) {
    const approvals = session.approvals ?? (session.approval ? [session.approval] : []);
    for (const approval of approvals) ids.add(localNotificationId(`approval:${approval.id}`));
    if (session.status === 'needs_input') ids.add(localNotificationId(`session:${session.id}`));
  }
  return ids;
}
