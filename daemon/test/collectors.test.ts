import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@agent-hub/shared';
import { CodexCollector, parseCodexRecords } from '../src/collectors/codex';
import { ClaudeCollector, claudeHookOverride, mapClaudeHook, parseClaudeRecords } from '../src/collectors/claude';
import { AntigravityCollector, parseAntigravityRecords } from '../src/collectors/antigravity';
import { mapDevinStatus, DevinCollector } from '../src/collectors/devin';
import { CodexCloudCollector } from '../src/collectors/codex-cloud';
import { WatchedCollector, type ParsedWatchedSession } from '../src/collectors/watched';
import type { EmitSession } from '../src/collectors/types';

const fixtures = path.resolve('daemon/test/fixtures/home');

class CachedFileCollector extends WatchedCollector {
  name = 'cached-test';
  refreshCount = 0;
  constructor(private root: string, private file: string) { super(); }
  protected roots(): string[] { return [this.root]; }
  protected async findFiles(): Promise<string[]> { return [this.file]; }
  async parse(): Promise<ParsedWatchedSession> {
    const updatedAt = new Date().toISOString();
    return {
      session: { id: 'cached-test:fixture', agent: 'codex', nativeId: 'fixture', title: 'Fixture', status: 'working', updatedAt, machine: 'test' },
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

async function fixtureLines(file: string): Promise<Record<string, any>[]> {
  return (await readFile(path.join(fixtures, file), 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

async function collectFixture(collector: CodexCollector | ClaudeCollector | AntigravityCollector, agent: string): Promise<AgentSession> {
  const previousHome = process.env.AGENT_HUB_HOME;
  process.env.AGENT_HUB_HOME = fixtures;
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
  }
}

describe('Codex transcript parser', () => {
  it('extracts title, project, branch, status, and messages from rollout JSONL', async () => {
    const now = Date.parse('2025-01-02T10:00:09.000Z');
    const parsed = parseCodexRecords(await fixtureLines('.codex/sessions/2025/01/02/rollout-codex-fixture.jsonl'), 'codex-fixture', now);
    expect(parsed.session.title).toBe('Fix the live feed sorting');
    expect(parsed.session.project).toBe('project');
    expect(parsed.session.branch).toBe('feature/feed');
    expect(parsed.session.status).toBe('needs_input');
    expect(parsed.messages).toHaveLength(2);
  });
  it('treats an explicit aborted turn as an error', () => {
    const parsed = parseCodexRecords([
      { type: 'session_meta', payload: { id: 'aborted' } },
      { type: 'event_msg', payload: { type: 'turn_aborted' } },
    ], 'aborted', Date.now());
    expect(parsed.session.status).toBe('error');
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
});

describe('watched collector cache', () => {
  it('does not re-parse unchanged files and refreshes cached status facts', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-watched-'));
    const file = path.join(home, 'session.jsonl');
    await writeFile(file, '{"fixture":true}\n');
    const collector = new CachedFileCollector(home, file);
    const parseSpy = vi.spyOn(collector, 'parse');
    try {
      await collector.scan(() => {});
      await collector.scan(() => {});
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(collector.refreshCount).toBe(2);
    } finally {
      await collector.stop();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('Claude Code hooks', () => {
  it('maps hook events and applies an immediate session status', async () => {
    expect(mapClaudeHook('PreToolUse')).toBe('working');
    expect(mapClaudeHook('Notification')).toBe('needs_input');
    expect(mapClaudeHook('StopFailure')).toBe('error');
    expect(mapClaudeHook('SessionEnd')).toBe('done');
    expect(claudeHookOverride(100, 'needs_input', 100)).toBe('needs_input');
    expect(claudeHookOverride(101, 'needs_input', 100)).toBeUndefined();
    const collector = new ClaudeCollector();
    const emitted: any[] = [];
    collector.start((session) => emitted.push(session));
    await collector.applyHook({ session_id: 'hook-fixture', hook_event_name: 'Notification', cwd: '/tmp/project', message: 'Permission needed' });
    expect(emitted.at(-1).status).toBe('needs_input');
    await collector.stop();
  });

  it('parses transcript title, cwd, branch, status, and messages', async () => {
    const rows = await fixtureLines('.claude/projects/-home-alex-project/session-fixture.jsonl');
    const now = Date.parse('2025-01-02T11:00:04.000Z');
    const parsed = parseClaudeRecords(rows, 'claude-fixture', '2025-01-02T11:00:04.000Z', now);
    expect(parsed.session.title).toBe('Review the latest changes');
    expect(parsed.session.project).toBe('project');
    expect(parsed.session.branch).toBe('feature/feed');
    expect(parsed.session.status).toBe('needs_input');
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
});

describe('Devin API mapping', () => {
  it('maps the documented status categories', () => {
    expect(mapDevinStatus('working')).toBe('working');
    expect(mapDevinStatus('blocked')).toBe('needs_input');
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
    expect(emitted[0]).toMatchObject({ id: 'devin:abc', status: 'needs_input', project: 'repository', url: 'https://app.devin.ai/sessions/abc' });
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
