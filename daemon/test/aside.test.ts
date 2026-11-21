import { describe, expect, it, vi } from 'vitest';
import { AsideCollector, parseAsidePrompts } from '../src/collectors/aside.js';

describe('AsideCollector', () => {
  it('parses Aside UIA prompt JSON payloads', () => {
    const prompts = parseAsidePrompts(JSON.stringify([
      {
        hwnd: '12345',
        summary: 'Browser — Allow ChatGPT to access https://www.facebook.com?',
        buttons: ['Allow for all sites', 'Deny', 'Allow once'],
      },
    ]));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.buttons).toEqual(['Allow for all sites', 'Deny', 'Allow once']);
  });

  it('emits needs_input sessions, clears them when gone, and invokes Allow/Deny', async () => {
    let response = JSON.stringify([
      {
        hwnd: '999',
        summary: 'Computer Use — Allow ChatGPT to use Aside?',
        buttons: ['Always allow', 'Deny', 'Allow this conversation'],
      },
    ]);
    const runner = vi.fn(async (script: string) => {
      if (script.includes('TryGetCurrentPattern')) return 'ok';
      return response;
    });

    const emitted: any[] = [];
    const removed: string[] = [];
    const emit = Object.assign((s: any) => emitted.push(s), { remove: (id: string) => removed.push(id) });

    const collector = new AsideCollector(5000, runner, 'win32', () => 1_700_000_000_000);
    collector.start(emit);
    collector.stop();
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0].id).toMatch(/^aside:/);
    expect(emitted[0].agent).toBe('codex');
    expect(emitted[0].status).toBe('needs_input');
    expect(emitted[0].approval.summary).toBe('Computer Use — Allow ChatGPT to use Aside?');

    const decision = await collector.decideApproval(emitted[0].nativeId, emitted[0].approval.id, 'allow');
    expect(decision).toBe('ok');
    expect(removed).toEqual([emitted[0].id]);
    const clickCall = runner.mock.calls.find(([script]) => script.includes('TryGetCurrentPattern'))?.[0];
    expect(clickCall).toContain("'Allow this conversation', 'Always allow'");

    response = '[]';
    await collector.poll();
    expect(removed).toHaveLength(1);
  });
});
