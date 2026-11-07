import { describe, expect, it } from 'vitest';
import type { AgentSession, SessionMessage } from '@agent-hub/shared';
import { activityBuckets, approvalQueue, formatElapsed } from './home';

function session(id: string, status: AgentSession['status'] = 'needs_input', updatedAt = '2025-01-01T00:00:00Z'): AgentSession {
  return {
    id, agent: 'codex', nativeId: id, title: id, status, canReply: true, updatedAt, machine: 'test',
  };
}

describe('approvalQueue', () => {
  it('supports the legacy approval field', () => {
    const item = { id: 'legacy', toolName: 'Write', summary: 'Write file', requestedAt: '2025-01-01T00:00:00Z' };
    expect(approvalQueue([{ ...session('one'), approval: item }], new Set())).toEqual([
      { kind: 'approval', session: { ...session('one'), approval: item }, approval: item },
    ]);
  });

  it('orders multiple approvals across sessions oldest first', () => {
    const old = { id: 'old', toolName: 'Write', summary: 'Old', requestedAt: '2025-01-01T00:00:00Z' };
    const middle = { id: 'middle', toolName: 'Write', summary: 'Middle', requestedAt: '2025-01-02T00:00:00Z' };
    const newest = { id: 'newest', toolName: 'Write', summary: 'Newest', requestedAt: '2025-01-03T00:00:00Z' };
    expect(approvalQueue([
      { ...session('one'), approvals: [newest, old] },
      { ...session('two'), approvals: [middle] },
    ], new Set()).map((item) => item.kind === 'approval' ? item.approval.id : item.session.id))
      .toEqual(['old', 'middle', 'newest']);
  });

  it('filters hidden approval ids', () => {
    const approval = { id: 'hidden', toolName: 'Write', summary: 'Write', requestedAt: '2025-01-01T00:00:00Z' };
    expect(approvalQueue([{ ...session('one'), approvals: [approval] }], new Set(['hidden']))).toEqual([]);
  });

  it('creates a skippable input item for approval-less sessions', () => {
    const waiting = session('waiting', 'needs_input', '2025-01-02T00:00:00Z');
    expect(approvalQueue([waiting], new Set())).toEqual([{ kind: 'input', session: waiting }]);
    expect(approvalQueue([waiting], new Set(['input:waiting']))).toEqual([]);
  });

  it('ignores sessions that do not need input', () => {
    const approval = { id: 'pending', toolName: 'Write', summary: 'Write', requestedAt: '2025-01-01T00:00:00Z' };
    expect(approvalQueue([{ ...session('working', 'working'), approvals: [approval] }], new Set())).toEqual([]);
  });
});

describe('activityBuckets', () => {
  const now = Date.parse('2025-01-01T01:00:00Z');
  const message = (at?: string): SessionMessage => ({ role: 'tool', text: 'step', at });

  it('places messages in the correct buckets, including the inclusive upper edge', () => {
    const counts = activityBuckets([
      message('2025-01-01T00:00:00.001Z'),
      message('2025-01-01T00:10:00Z'),
      message('2025-01-01T00:30:00Z'),
      message('2025-01-01T00:59:59.999Z'),
      message('2025-01-01T01:00:00Z'),
    ], now, 6);
    expect(counts).toEqual([1, 1, 0, 1, 0, 2]);
  });

  it('ignores out-of-window and missing or invalid timestamps', () => {
    expect(activityBuckets([
      message('2025-01-01T00:00:00Z'),
      message('2025-01-01T01:00:00.001Z'),
      message(),
      message('not a timestamp'),
    ], now, 4)).toEqual([0, 0, 0, 0]);
  });
});

describe('formatElapsed', () => {
  it('formats durations under an hour as minutes and seconds', () => {
    expect(formatElapsed(247_000)).toBe('4:07');
  });

  it('formats durations of an hour or more as hours and minutes', () => {
    expect(formatElapsed(3_960_000)).toBe('1h 06m');
  });
});
