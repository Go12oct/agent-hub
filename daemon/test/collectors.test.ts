import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@agent-hub/shared';
import { CodexCollector, parseCodexRecords } from '../src/collectors/codex';
import { ClaudeCollector, claudeHookOverride, mapClaudeHook, parseClaudeRecords } from '../src/collectors/claude';
import { AntigravityCollector, parseAntigravityRecords } from '../src/collectors/antigravity';
import { mapDevinStatus, parseDevinMessages, DevinCollector } from '../src/collectors/devin';
import { CodexCloudCollector } from '../src/collectors/codex-cloud';
import { WatchedCollector, type ParsedWatchedSession } from '../src/collectors/watched';
import type { EmitSession } from '../src/collectors/types';
import { NtfyNotifier } from '../src/notifications';

const fixtures = path.resolve('daemon/test/fixtures/home');

class CachedFileCollector extends WatchedCollector {
  name = 'cached-test';
  refreshCount = 0;
  constructor(private root: string, private file: string, private parsedUpdatedAt?: string) { super(); }
  protected roots(): string[] { return [this.root]; }
  protected async findFiles(): Promise<string[]> { return [this.file]; }
  async parse(): Promise<ParsedWatchedSession> {
    const updatedAt = this.parsedUpdatedAt ?? new Date().toISOString();
    return {
      session: { id: 'cached-test:fixture', agent: 'codex', nativeId: 'fixture', title: 'Fixture', status: 'working', canReply: false, updatedAt, machine: 'test' },
      statusFacts: { updatedAt, lastRole: 'assistant', completed: true, errored: false },
    };
  }
  protected async messages(): Promise<[]> { return []; }
  protected refreshSession(parsed: ParsedWatchedSession, mtimeMs: number, now: number): AgentSession {
    this.refreshCount++;
    return super.refreshSession(parsed, mtimeMs, now);
  }
  async scan(emit: EmitSession): Promise<void> {
    this.emit = emit;
    await this.rescan();
  }
}

class InspectableAntigravityCollector extends AntigravityCollector {
  async discover(): Promise<string[]> { return this.findFiles(); }
}

function collectorWatchTargets(collector: WatchedCollector): {
  paths: string[];
  depth?: number;
  ignored?: (path: string, stats?: Stats) => boolean;
} {
  return (collector as unknown as {
    watchTargets(): { paths: string[]; depth?: number; ignored?: (path: string, stats?: Stats) => boolean };
  }).watchTargets();
}

async function fixtureLines(file: string): Promise<Record<string, any>[]> {
  return (await readFile(path.join(fixtures, file), 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

async function collectFixture(
  collector: CodexCollector | ClaudeCollector | AntigravityCollector,
  agent: string,
  configDir?: string,
): Promise<AgentSession> {
  const previousHome = process.env.AGENT_HUB_HOME;
  const previousConfigDir = process.env.AGENT_HUB_CONFIG_DIR;
  const temporaryConfigDir = configDir ?? await mkdtemp(path.join(os.tmpdir(), 'agent-hub-fixture-config-'));
  process.env.AGENT_HUB_HOME = fixtures;
  process.env.AGENT_HUB_CONFIG_DIR = temporaryConfigDir;
  let timeout: NodeJS.Timeout | undefined;
  try {
    const session = await new Promise<AgentSession>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${agent} fixture scan`)), 3_000);
      collector.start((value) => {
        if (value.agent === agent) resolve(value);
      });
    });
    return session;
  } finally {
    if (timeout) clearTimeout(timeout);
    await collector.stop();
    if (previousHome === undefined) delete process.env.AGENT_HUB_HOME;
    else process.env.AGENT_HUB_HOME = previousHome;
    if (previousConfigDir === undefined) delete process.env.AGENT_HUB_CONFIG_DIR;
    else process.env.AGENT_HUB_CONFIG_DIR = previousConfigDir;
    if (configDir === undefined) await rm(temporaryConfigDir, { recursive: true, force: true });
  }
}

describe('Codex transcript parser', () => {
  it('extracts title, project, branch, status, and messages from rollout JSONL', async () => {
    const now = Date.parse('2025-01-02T10:00:09.000Z');
    const parsed = parseCodexRecords(await fixtureLines('.codex/sessions/2025/01/02/rollout-codex-fixture.jsonl'), 'codex-fixture', now);
    expect(parsed.session.title).toBe('Fix the live feed sorting');
    expect(parsed.session.project).toBe('project');
    expect(parsed.session.branch).toBe('feature/feed');
    expect(parsed.session.status).toBe('done');
    expect(parsed.messages).toHaveLength(2);
  });
  it('uses the latest Codex activity to determine whether a turn is errored or done', () => {
    const parse = (events: Record<string, any>[]) => parseCodexRecords([
      { type: 'session_meta', payload: { id: 'latest-state' } },
      ...events,
    ], 'latest-state', Date.now());
    const event = (type: string, payload: Record<string, unknown> = {}) => ({ type: 'event_msg', payload: { type, ...payload } });

    expect(parse([
      event('turn_aborted'),
      event('task_started'),
      event('agent_message', { message: 'Continuing' }),
      event('task_complete'),
    ]).session.status).toBe('done');
    expect(parse([
      event('task_started'),
      event('user_message', { message: 'Please try again' }),
      event('error'),
    ]).session.status).toBe('error');
    expect(parse([
      event('task_started'),
      event('error'),
      event('task_started'),
      event('agent_message', { message: 'Recovered' }),
      event('task_complete'),
    ]).session.status).toBe('done');
    expect(parse([
      event('user_message', { message: 'Stop here' }),
      event('turn_aborted'),
    ]).session.status).toBe('done');
  });

  it('uses the error event message as the Codex session last message', () => {
    const now = Date.now();
    const parsed = parseCodexRecords([
      { type: 'session_meta', payload: { id: 'codex-error' } },
      { type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'error', message: 'Quota exceeded' } },
    ], 'codex-error', now);
    expect(parsed.session.status).toBe('error');
    expect(parsed.session.lastMessage).toBe('Error: Quota exceeded');
  });

  it('clears Codex approval requests after a later response_item or event_msg', () => {
    const now = Date.now();
    const pending = parseCodexRecords([
      { type: 'session_meta', payload: { id: 'approval' } },
      { type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'exec_approval_request' } },
    ], 'approval', now);
    expect(pending.session.status).toBe('needs_input');
    expect(pending.session.lastMessage).toBe('Waiting for approval');

    const resolved = parseCodexRecords([
      { type: 'session_meta', payload: { id: 'approval-resolved' } },
      { type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'apply_patch_approval_request' } },
      { type: 'response_item', timestamp: new Date(now).toISOString(), payload: { type: 'function_call', name: 'apply_patch' } },
    ], 'approval-resolved', now);
    expect(resolved.session.status).not.toBe('needs_input');

    const superseded = parseCodexRecords([
      { type: 'session_meta', payload: { id: 'approval-superseded' } },
      { type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'apply_patch_approval_request' } },
      { type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'agent_message', message: 'Continuing' } },
    ], 'approval-superseded', now);
    expect(superseded.session.status).not.toBe('needs_input');

    const staleAt = now - 31 * 60_000;
    const stale = parseCodexRecords([
      { type: 'session_meta', payload: { id: 'approval-stale' } },
      { type: 'event_msg', timestamp: new Date(staleAt).toISOString(), payload: { type: 'exec_approval_request' } },
    ], 'approval-stale', now);
    expect(stale.session.status).not.toBe('needs_input');

    const missingTimestamp = parseCodexRecords([
      { type: 'session_meta', payload: { id: 'approval-unknown-time' } },
      { type: 'event_msg', payload: { type: 'exec_approval_request' } },
    ], 'approval-unknown-time', now);
    expect(missingTimestamp.session.status).not.toBe('needs_input');
  });
});

describe('Claude hook override expiry', () => {
  it('expires Claude needs_input hook overrides after the hold plus 60 seconds', async () => {
    class TestClaudeCollector extends ClaudeCollector {
      refresh(parsed: ParsedWatchedSession, mtimeMs: number, now: number): AgentSession {
        return this.refreshSession(parsed, mtimeMs, now);
      }
      retains(session: AgentSession): boolean {
        return this.shouldRetain(session);
      }
    }
    const base = 1_700_000_000_000;
    let now = base;
    const collector = new TestClaudeCollector({ approvalHoldMs: 300_000, now: () => now });
    const emitted: AgentSession[] = [];
    await collector.applyHook({
      session_id: 'expiring-hook',
      hook_event_name: 'PermissionRequest',
      cwd: '/tmp/project',
    }, (session) => emitted.push(session));
    expect(emitted.at(-1)?.status).toBe('needs_input');

    const parsed = parseClaudeRecords([], 'expiring-hook', new Date(base).toISOString(), base);
    now = base + 360_001;
    const refreshed = collector.refresh({ session: parsed.session, statusFacts: parsed.statusFacts }, base, now);
    expect(refreshed.status).not.toBe('needs_input');
    expect(collector.retains(refreshed)).toBe(false);
    await collector.stop();
  });
});

describe('fixture-backed collector discovery', () => {
  it('scans the configured home for Codex, Claude, and Antigravity sessions', async () => {
    const codex = await collectFixture(new CodexCollector(), 'codex');
    const claude = await collectFixture(new ClaudeCollector(), 'claude-code');
    const antigravity = await collectFixture(new AntigravityCollector(), 'antigravity');
    expect(codex.title).toBe('Fix the live feed sorting');
    expect(claude.title).toBe('Review the latest changes');
    expect(antigravity.title).toBe('Implement the settings panel');
  });

  it('reloads lazy messages from disk after restoring parsed session caches', async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-message-cache-'));
    try {
      const collectors = [
        { agent: 'codex', create: () => new CodexCollector() },
        { agent: 'claude-code', create: () => new ClaudeCollector() },
        { agent: 'antigravity', create: () => new AntigravityCollector() },
      ];
      for (const { agent, create } of collectors) {
        await collectFixture(create(), agent, configDir);
        const restoredCollector = create();
        const parseSpy = vi.spyOn(restoredCollector as any, 'parse');
        const restoredSession = await collectFixture(restoredCollector, agent, configDir);
        expect(parseSpy).not.toHaveBeenCalled();
        expect(await restoredCollector.getMessages(restoredSession.nativeId, 30)).not.toHaveLength(0);
        if (agent !== 'codex') expect(parseSpy).toHaveBeenCalledTimes(1);
      }
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('Antigravity discovery and watcher scope', () => {
  it('selects only brain transcripts and conversation databases', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-antigravity-'));
    const previousHome = process.env.AGENT_HUB_HOME;
    process.env.AGENT_HUB_HOME = home;
    const root = path.join(home, '.gemini', 'antigravity');
    const transcript = path.join(root, 'brain', 'a', '.system_generated', 'logs', 'transcript.jsonl');
    const database = path.join(root, 'conversations', 'b.db');
    const worktreeDecoy = path.join(root, 'worktrees', 'x', 'brain', 'c', '.system_generated', 'logs', 'transcript.jsonl');
    const numberedDecoy = path.join(root, 'brain', 'a', 'logs', '00000000.jsonl');
    try {
      await mkdir(path.dirname(transcript), { recursive: true });
      await mkdir(path.dirname(database), { recursive: true });
      await mkdir(path.dirname(worktreeDecoy), { recursive: true });
      await mkdir(path.dirname(numberedDecoy), { recursive: true });
      await writeFile(transcript, '{"type":"assistant","text":"done"}\n');
      await writeFile(database, 'synthetic database\n');
      await writeFile(worktreeDecoy, '{"type":"assistant","text":"decoy"}\n');
      await writeFile(numberedDecoy, '{"type":"assistant","text":"decoy"}\n');

      const files = await new InspectableAntigravityCollector().discover();
      expect(new Set(files)).toEqual(new Set([transcript, database]));
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_HUB_HOME;
      else process.env.AGENT_HUB_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('limits collector watch targets to relevant directory depths', () => {
    const previousHome = process.env.AGENT_HUB_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.AGENT_HUB_HOME = '/synthetic/home';
    process.env.CODEX_HOME = '/synthetic/codex';
    try {
      expect(collectorWatchTargets(new CodexCollector())).toEqual({
        paths: [path.join('/synthetic/codex', 'sessions'), path.join('/synthetic/codex', 'archived_sessions')],
        depth: 3,
      });
      expect(collectorWatchTargets(new ClaudeCollector())).toEqual({
        paths: [path.join('/synthetic/home', '.claude', 'projects')],
        depth: 2,
      });
      expect(collectorWatchTargets(new AntigravityCollector())).toEqual({
        paths: [
          path.join('/synthetic/home', '.gemini', 'antigravity-ide', 'conversations'),
          path.join('/synthetic/home', '.gemini', 'antigravity', 'conversations'),
          path.join('/synthetic/home', '.gemini', 'antigravity-cli', 'conversations'),
          path.join('/synthetic/home', '.gemini', 'antigravity-ide', 'brain'),
          path.join('/synthetic/home', '.gemini', 'antigravity', 'brain'),
          path.join('/synthetic/home', '.gemini', 'antigravity-cli', 'brain'),
        ],
        depth: 3,
        ignored: expect.any(Function),
      });
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_HUB_HOME;
      else process.env.AGENT_HUB_HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it('only watches transcript paths under brain and normalizes Windows separators', () => {
    const previousHome = process.env.AGENT_HUB_HOME;
    process.env.AGENT_HUB_HOME = '/synthetic/home';
    try {
      const ignored = collectorWatchTargets(new AntigravityCollector()).ignored!;
      const brain = path.join('/synthetic/home', '.gemini', 'antigravity', 'brain');
      const allowed = [
        brain,
        path.join(brain, 'session-a'),
        path.join(brain, 'session-a', '.system_generated'),
        path.join(brain, 'session-a', '.system_generated', 'logs'),
        path.join(brain, 'session-a', '.system_generated', 'logs', 'transcript.jsonl'),
      ];
      for (const candidate of allowed) {
        expect(ignored(candidate)).toBe(false);
        expect(ignored(candidate, {} as Stats)).toBe(false);
      }
      expect(ignored('\\synthetic\\home\\.gemini\\antigravity\\brain\\session-a\\.system_generated\\logs\\transcript.jsonl')).toBe(false);
      for (const candidate of [
        path.join(brain, 'session-a', 'notes.txt'),
        path.join(brain, 'session-a', '.system_generated', 'logs', '00000001.jsonl'),
        path.join(brain, 'session-a', '.system_generated', 'logs', 'transcript.jsonl', 'nested'),
      ]) {
        expect(ignored(candidate)).toBe(true);
      }
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_HUB_HOME;
      else process.env.AGENT_HUB_HOME = previousHome;
    }
  });
});

describe('watched collector cache', () => {
  it('does not re-parse unchanged files and refreshes cached status facts', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-watched-'));
    const file = path.join(home, 'session.jsonl');
    await writeFile(file, '{"fixture":true}\n');
    const previousConfigDir = process.env.AGENT_HUB_CONFIG_DIR;
    process.env.AGENT_HUB_CONFIG_DIR = path.join(home, 'config');
    const collector = new CachedFileCollector(home, file);
    const parseSpy = vi.spyOn(collector, 'parse');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await collector.scan(() => {});
      await collector.scan(() => {});
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(collector.refreshCount).toBe(2);
      expect(logSpy.mock.calls[0]?.[0]).toMatch(/^\[cached-test\] rescan: 1 files, 1 parsed, \d+ ms$/);
      expect(logSpy.mock.calls[1]?.[0]).toMatch(/^\[cached-test\] rescan: 1 files, 0 parsed, \d+ ms$/);
      await writeFile(file, '{"fixture":false}\n');
      parseSpy.mockRejectedValue(new Error('synthetic parse failure'));
      await collector.scan(() => {});
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[cached-test\] rescan failed after \d+ ms: synthetic parse failure$/));
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      await collector.stop();
      await rm(home, { recursive: true, force: true });
      if (previousConfigDir === undefined) delete process.env.AGENT_HUB_CONFIG_DIR;
      else process.env.AGENT_HUB_CONFIG_DIR = previousConfigDir;
    }
  });

  it('restores sessions before parsing, reparses changed files, and suppresses old-session notifications', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-watched-restart-'));
    const file = path.join(home, 'session.jsonl');
    await writeFile(file, '{"fixture":true}\n');
    const previousConfigDir = process.env.AGENT_HUB_CONFIG_DIR;
    process.env.AGENT_HUB_CONFIG_DIR = path.join(home, 'config');
    const oldUpdatedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const first = new CachedFileCollector(home, file, oldUpdatedAt);
    const second = new CachedFileCollector(home, file, oldUpdatedAt);
    const parseSpy = vi.spyOn(second, 'parse');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const notifier = new NtfyNotifier({ topic: 'cache-test' }, fetchMock as unknown as typeof fetch);
    const notificationPromises: Promise<void>[] = [];
    const emitted: AgentSession[] = [];
    try {
      await first.scan(() => {});
      await first.stop();
      const cache = JSON.parse(await readFile(path.join(home, 'config', 'cache', 'cached-test.json'), 'utf8'));
      expect(cache.version).toBe(1);

      second.start((session) => {
        emitted.push(session);
        notificationPromises.push(notifier.update(session));
      });
      await vi.waitFor(() => expect(emitted).toHaveLength(1));
      expect(emitted[0]?.status).toBe('done');
      expect(parseSpy).not.toHaveBeenCalled();
      await Promise.all(notificationPromises);
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[cached-test\] rescan: 1 files, 0 parsed,/)));

      await writeFile(file, '{"fixture":false}\n');
      await second.scan((session) => emitted.push(session));
      expect(parseSpy).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
      await first.stop();
      await second.stop();
      await rm(home, { recursive: true, force: true });
      if (previousConfigDir === undefined) delete process.env.AGENT_HUB_CONFIG_DIR;
      else process.env.AGENT_HUB_CONFIG_DIR = previousConfigDir;
    }
  });
});

describe('Claude Code hooks', () => {
  it('maps hook events and applies an immediate session status', async () => {
    expect(mapClaudeHook('PreToolUse')).toBe('working');
    expect(mapClaudeHook('Notification')).toBe('done');
    expect(mapClaudeHook('Notification', { notification_type: 'permission_prompt' })).toBe('needs_input');
    expect(mapClaudeHook('Notification', { notification_type: 'elicitation_dialog' })).toBe('needs_input');
    expect(mapClaudeHook('Notification', { notification_type: 'idle_prompt', message: 'Allow access?' })).toBe('done');
    expect(mapClaudeHook('Notification', { message: 'Please approve this action' })).toBe('needs_input');
    expect(mapClaudeHook('Notification', { message: 'The session is idle' })).toBe('done');
    expect(mapClaudeHook('PermissionRequest')).toBe('needs_input');
    expect(mapClaudeHook('Stop')).toBe('done');
    expect(mapClaudeHook('StopFailure')).toBe('error');
    expect(mapClaudeHook('SessionEnd')).toBe('done');
    expect(claudeHookOverride(100, 'needs_input', 100, 100)).toBe('needs_input');
    expect(claudeHookOverride(101, 'needs_input', 100, 100)).toBeUndefined();
    expect(claudeHookOverride(100, 'needs_input', 100, 460_001, 300_000)).toBeUndefined();
    const collector = new ClaudeCollector();
    const emitted: any[] = [];
    const emit = (session: AgentSession) => emitted.push(session);
    await collector.applyHook({ session_id: 'hook-fixture', hook_event_name: 'Notification', cwd: '/tmp/project', message: 'Permission needed' }, emit);
    expect(emitted.at(-1).status).toBe('needs_input');
    expect(emitted.at(-1).lastMessage).toBe('Permission needed');
    await collector.applyHook({
      session_id: 'hook-fixture', hook_event_name: 'StopFailure', cwd: '/tmp/project', error: 'The API request failed',
    }, emit);
    expect(emitted.at(-1).status).toBe('error');
    expect(emitted.at(-1).lastMessage).toBe('Error: The API request failed');
    await collector.applyHook({
      session_id: 'hook-fixture', hook_event_name: 'StopFailure', cwd: '/tmp/project', message: 'Process exited unexpectedly',
    }, emit);
    expect(emitted.at(-1).lastMessage).toBe('Error: Process exited unexpectedly');
  });

  it('parses transcript title, cwd, branch, status, and messages', async () => {
    const rows = await fixtureLines('.claude/projects/-home-alex-project/session-fixture.jsonl');
    const now = Date.parse('2025-01-02T11:00:04.000Z');
    const parsed = parseClaudeRecords(rows, 'claude-fixture', '2025-01-02T11:00:04.000Z', now);
    expect(parsed.session.title).toBe('Review the latest changes');
    expect(parsed.session.project).toBe('project');
    expect(parsed.session.branch).toBe('feature/feed');
    expect(parsed.session.status).toBe('done');
    expect(parsed.messages).toHaveLength(2);
  });

  it('does not complete an assistant entry that contains tool use', () => {
    const parsed = parseClaudeRecords([
      { type: 'user', timestamp: '2025-01-02T11:00:00.000Z', message: { role: 'user', content: 'Run the checks' } },
      { type: 'assistant', timestamp: '2025-01-02T11:00:04.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }], stop_reason: null } },
    ], 'claude-tool-use', '2025-01-02T11:00:04.000Z', Date.parse('2025-01-02T11:00:04.000Z'));
    expect(parsed.session.status).toBe('working');
    expect(parsed.statusFacts.completed).toBe(false);
  });

  it('uses Claude API error text and transcript error fields as the session last message', () => {
    const now = Date.parse('2025-01-02T11:00:04.000Z');
    const apiError = parseClaudeRecords([
      {
        type: 'assistant',
        timestamp: new Date(now).toISOString(),
        message: { role: 'assistant', content: 'API Error: 500 missing csrf token' },
      },
    ], 'claude-api-error', new Date(now).toISOString(), now);
    expect(apiError.session.status).toBe('error');
    expect(apiError.session.lastMessage).toBe('Error: API Error: 500 missing csrf token');

    const stopFailure = parseClaudeRecords([
      { type: 'stop_failure', timestamp: new Date(now).toISOString(), error: { message: 'Tool execution failed' } },
    ], 'claude-stop-failure', new Date(now).toISOString(), now);
    expect(stopFailure.session.status).toBe('error');
    expect(stopFailure.session.lastMessage).toBe('Error: Tool execution failed');
  });

  it('clears transcript error state after a later user message or successful assistant reply', () => {
    const now = Date.now();
    const apiError = {
      type: 'assistant',
      timestamp: new Date(now - 2_000).toISOString(),
      message: { role: 'assistant', content: 'API Error: 500 missing csrf token' },
    };
    const recoveredReply = parseClaudeRecords([
      apiError,
      {
        type: 'assistant',
        timestamp: new Date(now - 1_000).toISOString(),
        message: { role: 'assistant', content: 'The request succeeded.', stop_reason: 'end_turn' },
      },
    ], 'claude-recovered', new Date(now).toISOString(), now);
    expect(recoveredReply.session.status).not.toBe('error');
    expect(recoveredReply.session.lastMessage).toBe('The request succeeded.');

    const recoveredPrompt = parseClaudeRecords([
      apiError,
      { type: 'user', timestamp: new Date(now - 1_000).toISOString(), message: { role: 'user', content: 'Please try again.' } },
    ], 'claude-retried', new Date(now).toISOString(), now);
    expect(recoveredPrompt.session.status).not.toBe('error');
    expect(recoveredPrompt.session.lastMessage).toBe('Please try again.');
  });
});

describe('Antigravity transcript parser', () => {
  it('extracts user prompt and conversation metadata from transcript records', async () => {
    const rows = await fixtureLines('.gemini/antigravity-cli/brain/anti-fixture/.system_generated/logs/transcript.jsonl');
    const now = Date.parse('2025-01-02T12:00:05.000Z');
    const result = parseAntigravityRecords(rows, 'anti-fixture', '2025-01-02T12:00:05.000Z', now);
    expect(result.session.title).toBe('Implement the settings panel');
    expect(result.session.project).toBe('project');
    expect(result.session.status).toBe('working');
    expect(result.messages).toHaveLength(2);
  });

  it('only reports errors that are not superseded by later messages or completion', () => {
    const now = Date.now();
    const modifiedAt = new Date(now).toISOString();
    const parse = (records: Record<string, any>[]) => parseAntigravityRecords(records, 'anti-state', modifiedAt, now);

    expect(parse([
      { type: 'error', text: 'Earlier failure' },
      { type: 'assistant', role: 'assistant', text: 'Finished', turnComplete: true },
    ]).session.status).toBe('done');
    expect(parse([
      { type: 'error', text: 'Final failure' },
    ]).session.status).toBe('error');
    const aborted = parse([
      { type: 'turn_aborted' },
    ]);
    expect(aborted.statusFacts.errored).toBe(false);
    expect(aborted.session.status).toBe('done');
    expect(parse([
      { type: 'turn_aborted', status: 'ERROR' },
    ]).session.status).toBe('error');
    expect(parse([
      { role: 'assistant', text: 'Request failed', status: 'ERROR' },
    ]).session.status).toBe('error');
    expect(parse([
      { role: 'assistant', text: 'Request failed', status: 'ERROR' },
      { role: 'assistant', text: 'Completed', turnComplete: true },
    ]).session.status).toBe('done');
  });
});

describe('Devin API mapping', () => {
  it('maps the documented status categories', () => {
    expect(mapDevinStatus('working')).toBe('working');
    expect(mapDevinStatus('blocked')).toBe('done');
    expect(mapDevinStatus('awaiting_input')).toBe('done');
    expect(mapDevinStatus('waiting_for_user')).toBe('done');
    expect(mapDevinStatus('finished')).toBe('done');
    expect(mapDevinStatus('suspend_requested')).toBe('idle');
    expect(mapDevinStatus('error')).toBe('error');
  });

  it('polls with a personal API key and emits mapped sessions', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ sessions: [{ session_id: 'abc', status_enum: 'blocked', title: 'Triage', structured_output: { repo: 'org/repository' } }] }));
    const collector = new DevinCollector('not-a-real-key', fetcher);
    const emitted: any[] = [];
    collector.start((session) => emitted.push(session));
    await new Promise((resolve) => setTimeout(resolve, 5));
    collector.stop();
    expect(emitted[0]).toMatchObject({ id: 'devin:abc', status: 'done', project: 'repository', url: 'https://app.devin.ai/sessions/abc' });
    expect(emitted[0].lastMessage).toBeUndefined();
  });

  it('maps message types and invalidates cached messages when updated_at changes', async () => {
    const timestamps = ['2025-01-02T12:00:00.000Z', '2025-01-02T12:00:30.000Z'];
    let listCalls = 0;
    let detailCalls = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/sessions?limit=50')) {
        const updatedAt = timestamps[Math.min(listCalls++, timestamps.length - 1)]!;
        return new Response(JSON.stringify({ sessions: [{
          session_id: 'abc', status_enum: 'blocked', title: 'Triage', updated_at: updatedAt,
        }] }));
      }
      detailCalls++;
      const messages = detailCalls === 1 ? [
        { type: 'user_message', message: 'Can you check this?', timestamp: '2025-01-02T12:00:01.000Z' },
        { type: 'devin_message', message: 'I found the issue.', created_at: '2025-01-02T12:00:02.000Z' },
        { type: 'tool_event', message: 'Ran a check', timestamp: '2025-01-02T12:00:03.000Z' },
        { type: 'devin_message', message: '' },
      ] : [{ type: 'devin_message', message: 'The refreshed answer.' }];
      return new Response(JSON.stringify({ messages }));
    };
    class TestDevinCollector extends DevinCollector {
      refresh(): Promise<void> { return this.poll(); }
    }
    const collector = new TestDevinCollector('not-a-real-key', fetcher);
    const emitted: any[] = [];
    collector.start((session) => emitted.push(session));
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const first = await collector.getMessages('abc', 30);
      expect(first).toEqual([
        { role: 'user', text: 'Can you check this?', at: '2025-01-02T12:00:01.000Z' },
        { role: 'assistant', text: 'I found the issue.', at: '2025-01-02T12:00:02.000Z' },
        { role: 'tool', text: 'Ran a check', at: '2025-01-02T12:00:03.000Z' },
      ]);
      expect((await collector.getMessages('abc', 30))).toEqual(first);
      expect(detailCalls).toBe(1);
      expect(emitted.at(-1)).toMatchObject({ canReply: true, lastMessage: 'I found the issue.' });

      await collector.refresh();
      expect(await collector.getMessages('abc', 30)).toEqual([
        { role: 'assistant', text: 'The refreshed answer.' },
      ]);
      expect(detailCalls).toBe(2);
    } finally {
      collector.stop();
    }
  });

  it('supports Devin role-based messages and alternate text fields', () => {
    expect(parseDevinMessages([
      { role: 'user', content: 'Question from the older schema' },
      { role: 'devin', text: 'Answer from the older schema' },
      { type: 'user_message', message: 'Question from the current schema' },
      { type: 'devin_message', role: 'user', content: 'Type takes precedence' },
    ])).toEqual([
      { role: 'user', text: 'Question from the older schema' },
      { role: 'assistant', text: 'Answer from the older schema' },
      { role: 'user', text: 'Question from the current schema' },
      { role: 'assistant', text: 'Type takes precedence' },
    ]);
  });

  it('uses the final non-tool message for the Devin preview and last role', async () => {
    const fetcher: typeof fetch = async (input) => {
      if (String(input).endsWith('/sessions?limit=50')) {
        return new Response(JSON.stringify({ sessions: [{
          session_id: 'preview', status_enum: 'blocked', updated_at: '2025-01-02T12:00:00.000Z',
        }] }));
      }
      return new Response(JSON.stringify({ messages: [
        { type: 'devin_message', message: 'Ready' },
        { type: 'user_message', message: 'Run tests' },
        { type: 'tool_event', message: 'Running suite' },
      ] }));
    };
    class TestDevinCollector extends DevinCollector {
      refresh(): Promise<void> { return this.poll(); }
    }
    const collector = new TestDevinCollector('not-a-real-key', fetcher);
    const emitted: any[] = [];
    collector.start((session) => emitted.push(session));
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(emitted[0].status).toBe('done');
      expect(emitted[0].lastMessage).toBeUndefined();
      await collector.getMessages('preview', 30);
      expect(emitted.at(-1)).toMatchObject({ lastMessage: 'Run tests', lastRole: 'user' });
      await collector.refresh();
      expect(emitted.at(-1)).toMatchObject({ lastMessage: 'Run tests', lastRole: 'user' });
    } finally {
      collector.stop();
    }
  });

  it('sends a Devin message to the documented endpoint and invalidates cached messages', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let detailCalls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const request = { url: String(input), init };
      requests.push(request);
      if (init?.method === 'POST') return new Response(null, { status: 204 });
      detailCalls++;
      return new Response(JSON.stringify({ messages: [{ type: 'devin_message', message: `reply ${detailCalls}` }] }));
    };
    const collector = new DevinCollector('not-a-real-key', fetcher);
    expect(await collector.getMessages('session-123', 10)).toEqual([{ role: 'assistant', text: 'reply 1' }]);
    expect(await collector.getMessages('session-123', 10)).toEqual([{ role: 'assistant', text: 'reply 1' }]);
    expect(detailCalls).toBe(1);
    await collector.sendMessage('session-123', 'Please add a test');
    expect(await collector.getMessages('session-123', 10)).toEqual([{ role: 'assistant', text: 'reply 2' }]);
    expect(detailCalls).toBe(2);
    const post = requests.find((request) => request.init?.method === 'POST');
    expect(post?.url).toBe('https://api.devin.ai/v1/sessions/session-123/message');
    expect(post?.init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-real-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Please add a test' }),
    });
  });

  it('drops empty Devin message text', () => {
    expect(parseDevinMessages([{ type: 'devin_message', message: ' ' }])).toEqual([]);
  });
});

describe('Codex Cloud experimental collector', () => {
  it('handles an unauthorized response without throwing', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-cloud-'));
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex', 'auth.json'), JSON.stringify({
      tokens: { access_token: 'fixture-token', chatgpt_account_id: 'fixture-account' },
    }));
    const previousHome = process.env.AGENT_HUB_HOME;
    process.env.AGENT_HUB_HOME = home;
    const fetcher: typeof fetch = async () => new Response('unauthorized', { status: 401 });
    const collector = new CodexCloudCollector(fetcher);
    const old = console.warn;
    console.warn = () => {};
    try {
      collector.start(() => {});
      await new Promise((resolve) => setTimeout(resolve, 5));
      collector.stop();
    } finally {
      console.warn = old;
      if (previousHome === undefined) delete process.env.AGENT_HUB_HOME;
      else process.env.AGENT_HUB_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});
