import { describe, expect, it } from 'vitest';
import { inferStatus } from '../src/collectors/files';

const now = Date.parse('2025-01-02T12:00:00.000Z');

describe('file-agent status heuristic', () => {
  it('marks a recent unfinished session working', () => {
    expect(inferStatus(new Date(now - 89_999).toISOString(), 'user', false, false, now)).toBe('working');
  });
  it('marks a 90-second-old unfinished session idle', () => {
    expect(inferStatus(new Date(now - 90_000).toISOString(), 'user', false, false, now)).toBe('idle');
  });
  it('moves a completed assistant turn to needs_input', () => {
    expect(inferStatus(new Date(now - 90_000).toISOString(), 'assistant', true, false, now)).toBe('needs_input');
  });
  it('keeps a recent completed turn as needs_input', () => {
    expect(inferStatus(new Date(now - 5 * 60 * 60 * 1000).toISOString(), 'assistant', true, false, now)).toBe('needs_input');
  });
  it('moves a six-hour-old turn to idle', () => {
    expect(inferStatus(new Date(now - 6 * 60 * 60 * 1000).toISOString(), 'assistant', true, false, now)).toBe('idle');
  });
  it('prioritizes explicit errors', () => {
    expect(inferStatus(new Date(now - 1000).toISOString(), 'user', false, true, now)).toBe('error');
  });
});
