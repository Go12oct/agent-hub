import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsideCollector, parseAsidePrompts, type AsideWatcherProcess } from '../src/collectors/aside.js';

function fakeWatcherFactory() {
  const instances: Array<{
    emitLine: (line: string) => void;
    emitExit: () => void;
    killed: boolean;
    proc: AsideWatcherProcess;
  }> = [];

  const spawn = vi.fn((_script: string) => {
    let lineCb: ((line: string) => void) | undefined;
    let exitCb: (() => void) | undefined;
    const entry = {
      emitLine: (line: string) => lineCb?.(line),
      emitExit: () => exitCb?.(),
      killed: false,
      proc: {
        onLine: (cb: (line: string) => void) => { lineCb = cb; },
        onExit: (cb: () => void) => { exitCb = cb; },
        kill: () => { entry.killed = true; },
      },
    };
    instances.push(entry);
    return entry.proc;
  });

  return { spawn, instances };
}

describe('AsideCollector', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('emits from watcher lines, ignores heartbeats, clears on [], and orders allow/deny buttons', async () => {
    const runner = vi.fn(async (script: string) => (script.includes('TryGetCurrentPattern') ? 'ok' : '[]'));
    const watcher = fakeWatcherFactory();

    const emitted: any[] = [];
    const removed: string[] = [];
    const emit = Object.assign((s: any) => emitted.push(s), { remove: (id: string) => removed.push(id) });

    const collector = new AsideCollector(60_000, runner, 'win32', () => 1_700_000_000_000, watcher.spawn);
    collector.start(emit);

    expect(watcher.instances).toHaveLength(1);
    const proc = watcher.instances[0]!;

    proc.emitLine('{"hb":1}');
    expect(emitted).toHaveLength(0);

    proc.emitLine(JSON.stringify([
      {
        hwnd: '999',
        summary: 'Computer Use — Allow ChatGPT to use Aside?',
        buttons: ['Always allow', 'Deny', 'Allow this conversation'],
      },
    ]));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toMatch(/^aside:/);
    expect(emitted[0].agent).toBe('codex');
    expect(emitted[0].status).toBe('needs_input');

    const allowResult = await collector.decideApproval(emitted[0].nativeId, emitted[0].approval.id, 'allow');
    expect(allowResult).toBe('ok');
    expect(removed).toEqual([emitted[0].id]);
    const allowCall = runner.mock.calls.find(([script]) => script.includes('TryGetCurrentPattern'))?.[0];
    expect(allowCall).toContain("'Allow this conversation', 'Always allow'");

    proc.emitLine(JSON.stringify([
      {
        hwnd: '1000',
        summary: 'Browser — Allow ChatGPT to access https://example.com?',
        buttons: ['Allow for all sites', 'Deny', 'Allow once'],
      },
    ]));
    expect(emitted).toHaveLength(2);
    const denyResult = await collector.decideApproval(emitted[1].nativeId, emitted[1].approval.id, 'deny');
    expect(denyResult).toBe('ok');
    const denyCall = runner.mock.calls[1]?.[0];
    expect(denyCall).toContain("'Deny'");

    proc.emitLine(JSON.stringify([
      {
        hwnd: '1001',
        summary: 'Browser — Allow ChatGPT to access https://other.test?',
        buttons: ['Deny', 'Allow once'],
      },
    ]));
    expect(emitted).toHaveLength(3);
    proc.emitLine('[]');
    expect(removed).toContain(emitted[2].id);

    collector.stop();
    expect(proc.killed).toBe(true);
  });

  it('matches shortcut-hinted and variant button labels (Deny Esc, Allow this conversation ↵, Always allow this app)', async () => {
    const runner = vi.fn(async (_script: string) => 'ok');
    const watcher = fakeWatcherFactory();
    const emitted: any[] = [];
    const emit = Object.assign((s: any) => emitted.push(s), { remove: vi.fn() });

    const collector = new AsideCollector(60_000, runner, 'win32', () => 1_700_000_000_000, watcher.spawn);
    collector.start(emit);

    watcher.instances[0]!.emitLine(JSON.stringify([
      {
        hwnd: '2001',
        summary: 'Computer Use — Allow ChatGPT to use Microsoft Edge?',
        buttons: ['Always allow this app', 'Deny Esc', 'Allow this conversation ↵'],
      },
    ]));
    expect(emitted).toHaveLength(1);
    expect(await collector.decideApproval(emitted[0].nativeId, emitted[0].approval.id, 'allow')).toBe('ok');
    expect(runner.mock.calls[0]?.[0]).toContain("'Allow this conversation ↵', 'Always allow this app'");

    watcher.instances[0]!.emitLine(JSON.stringify([
      {
        hwnd: '2002',
        summary: 'Computer Use — Allow ChatGPT to use Microsoft Edge?',
        buttons: ['Always allow this app', 'Deny Esc', 'Allow this conversation ↵'],
      },
    ]));
    expect(await collector.decideApproval(emitted[1].nativeId, emitted[1].approval.id, 'deny')).toBe('ok');
    expect(runner.mock.calls[1]?.[0]).toContain("'Deny Esc'");

    collector.stop();
  });

  it('restarts the watcher with backoff after exit', () => {
    vi.useFakeTimers();
    const watcher = fakeWatcherFactory();
    const collector = new AsideCollector(60_000, vi.fn(), 'win32', Date.now, watcher.spawn);
    collector.start(() => {});
    expect(watcher.instances).toHaveLength(1);

    watcher.instances[0]!.emitExit();
    vi.advanceTimersByTime(1999);
    expect(watcher.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(watcher.instances).toHaveLength(2);

    watcher.instances[1]!.emitExit();
    vi.advanceTimersByTime(3999);
    expect(watcher.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(watcher.instances).toHaveLength(3);

    collector.stop();
  });
});
