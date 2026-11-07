import { describe, expect, it } from 'vitest';
import { localNotificationId } from './local-notifications';

describe('local notification ids', () => {
  it('returns stable positive 31-bit ids for notification keys', () => {
    const id = localNotificationId('approval:approval-123');
    expect(id).toBe(localNotificationId('approval:approval-123'));
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThanOrEqual(0x7fffffff);
    expect(id).not.toBe(localNotificationId('session:claude-code:session-123'));
  });
});
