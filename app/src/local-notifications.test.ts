import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@agent-hub/shared';
import { liveNotificationIds, localNotificationId } from './local-notifications';

describe('local notification ids', () => {
  it('returns stable positive 31-bit ids for notification keys', () => {
    const id = localNotificationId('approval:approval-123');
    expect(id).toBe(localNotificationId('approval:approval-123'));
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThanOrEqual(0x7fffffff);
    expect(id).not.toBe(localNotificationId('session:claude-code:session-123'));
  });

  it('includes pending approval and needs-you notification ids only', () => {
    const approval = (id: string) => ({
      id,
      toolName: 'Bash',
      summary: 'Run a command',
      requestedAt: '2025-01-01T00:00:00.000Z',
    });
    const session = (id: string, status: AgentSession['status']): AgentSession => ({
      id,
      agent: 'claude-code',
      nativeId: id,
      title: id,
      status,
      canReply: true,
      updatedAt: '2025-01-01T00:00:00.000Z',
      machine: 'test',
    });
    const sessions = [
      { ...session('needs-you', 'needs_input'), approval: approval('single-approval') },
      {
        ...session('multiple-approvals', 'working'),
        approvals: [approval('approval-one'), approval('approval-two')],
      },
      session('working', 'working'),
    ];

    expect(liveNotificationIds(sessions)).toEqual(new Set([
      localNotificationId('session:needs-you'),
      localNotificationId('approval:single-approval'),
      localNotificationId('approval:approval-one'),
      localNotificationId('approval:approval-two'),
    ]));
  });
});
