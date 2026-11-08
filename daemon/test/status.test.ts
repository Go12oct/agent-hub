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
  it('marks a completed recent turn done rather than needing input', () => {
    expect(inferStatus(new Date(now - 90_000).toISOString(), 'assistant', true, false, now)).toBe('done');
  });
  it('marks a recent completed turn done', () => {
    expect(inferStatus(new Date(now - 5 * 60 * 60 * 1000).toISOString(), 'assistant', true, false, now)).toBe('done');
  });
  it('marks a completed turn done regardless of age', () => {
    expect(inferStatus(new Date(now - 24 * 60 * 60 * 1000).toISOString(), 'assistant', true, false, now)).toBe('done');
  });
  it('prioritizes explicit errors', () => {
    expect(inferStatus(new Date(now - 1000).toISOString(), 'user', false, true, now)).toBe('error');
  });
});
