import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@agent-hub/shared';
import { candidateUrls, feedGroups, mergeKnownUrls, parsePairingLink, previewText } from './pairing';

describe('pairing links', () => {
  it('parses the agenthub scheme and decodes the URL', () => {
    expect(parsePairingLink('agenthub://pair?url=http%3A%2F%2F192.168.1.2%3A4747&token=abc'))
      .toEqual({ url: 'http://192.168.1.2:4747', token: 'abc' });
  });
  it('rejects incomplete links', () => {
    expect(parsePairingLink('agenthub://pair?token=x')).toBeUndefined();
  });
});

describe('feed groups', () => {
  it('sorts sessions into attention, active, and recent groups', () => {
    const make = (id: string, status: AgentSession['status'], updatedAt: string) => ({
      id, agent: 'codex', nativeId: id, title: id, status, updatedAt, machine: 'test',
    }) as AgentSession;
    const groups = feedGroups([
      make('old', 'idle', '2025-01-01T00:00:00Z'),
      make('working', 'working', '2025-01-02T00:00:00Z'),
      make('attention', 'needs_input', '2025-01-01T00:00:00Z'),
    ]);
    expect(groups.needsYou.map((item) => item.id)).toEqual(['attention']);
    expect(groups.working.map((item) => item.id)).toEqual(['working']);
    expect(groups.recent.map((item) => item.id)).toEqual(['old']);
  });
});

describe('multiple hub addresses', () => {
  it('reads every url in a pairing link', () => {
    expect(parsePairingLink('agenthub://pair?url=http%3A%2F%2F192.168.8.3%3A4747&url=http%3A%2F%2F100.64.1.2%3A4747&token=t'))
      .toEqual({ url: 'http://192.168.8.3:4747', token: 't', urls: ['http://192.168.8.3:4747', 'http://100.64.1.2:4747'] });
  });
  it('tries the current url first and dedupes', () => {
    expect(candidateUrls({ url: 'http://a:1', token: 't', urls: ['http://b:1', 'http://a:1'] })).toEqual(['http://a:1', 'http://b:1']);
  });
  it('merges discovered urls and ignores junk', () => {
    expect(mergeKnownUrls({ url: 'http://a:1', token: 't' }, ['http://100.64.0.9:1/', 5, 'not a url']).urls)
      .toEqual(['http://a:1', 'http://100.64.0.9:1']);
  });
  it('strips markdown for previews', () => {
    expect(previewText('Run **this**:\n```sh\nnpm test\n```\nsee [docs](http://x)')).toBe('Run this: [code] see docs');
  });
});
