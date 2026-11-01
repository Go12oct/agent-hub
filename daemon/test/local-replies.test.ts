import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@agent-hub/shared';
import {
  buildReplyCommand, LocalReplyRunner, ReplyBusyError, ReplyFailedError, type ReplyAgent,
} from '../src/local-replies';

const text = 'Run the tests without changing permissions';

const commandCases: Array<{
  agent: ReplyAgent;
  platform: NodeJS.Platform;
  executable: string;
  shell: boolean;
}> = [
  { agent: 'codex', platform: 'win32', executable: 'C:\\Agent Tools\\codex.exe', shell: false },
  { agent: 'codex', platform: 'win32', executable: 'C:\\Agent Tools\\codex.cmd', shell: true },
  { agent: 'codex', platform: 'linux', executable: '/usr/bin/codex', shell: false },
  { agent: 'claude-code', platform: 'win32', executable: 'C:\\Agent Tools\\claude.exe', shell: false },
  { agent: 'claude-code', platform: 'win32', executable: 'C:\\Agent Tools\\claude.cmd', shell: true },
  { agent: 'claude-code', platform: 'linux', executable: '/usr/bin/claude', shell: false },
  { agent: 'antigravity', platform: 'win32', executable: 'C:\\Agent Tools\\agy.exe', shell: false },
  { agent: 'antigravity', platform: 'win32', executable: 'C:\\Agent Tools\\agy.cmd', shell: true },
  { agent: 'antigravity', platform: 'linux', executable: '/usr/bin/agy', shell: false },
];

describe('buildReplyCommand', () => {
  it.each(commandCases)('$agent on $platform using $executable', ({ agent, platform, executable, shell }) => {
    const command = buildReplyCommand(agent, 'session_123-abc', text, undefined, executable, platform);
    const shellShim = shell;
    const resumeFlag = agent === 'claude-code' ? '--resume' : agent === 'antigravity' ? '--conversation' : undefined;
    expect(command.command).toBe(shellShim ? `"${executable}"` : executable);
    expect(command.shell).toBe(shell);
    if (agent === 'codex') {
      expect(command.args).toEqual(['exec', 'resume', 'session_123-abc', '-']);
      expect(command.stdin).toBe(text);
    } else {
      expect(command.args).toEqual(shellShim ? [resumeFlag, 'session_123-abc', '-p'] : [resumeFlag, 'session_123-abc', '-p', text]);
      expect(command.stdin).toBe(shellShim ? text : undefined);
    }
    if (shellShim) expect(command.args).not.toContain(text);
  });

  it('rejects an unsafe native ID', () => {
    expect(() => buildReplyCommand('codex', 'abc;rm -rf', text, undefined, 'codex', 'linux')).toThrow('Invalid session ID');
  });
});

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 1234,
    stdin: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

const session: AgentSession = {
  id: 'codex:session_123',
  agent: 'codex',
  nativeId: 'session_123',
  title: 'Test',
  status: 'done',
  canReply: false,
  updatedAt: new Date().toISOString(),
  machine: 'test',
};

function createRunner(child: ChildProcess) {
  const spawnProcess = vi.fn(() => child);
  const runner = new LocalReplyRunner({
    commands: { codex: 'codex' },
    resolve: async () => undefined,
    spawn: spawnProcess as unknown as typeof spawn,
    timeoutMs: 60_000,
  });
  return { runner, spawnProcess };
}

describe('LocalReplyRunner', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects a concurrent reply for the same session as busy', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const { runner } = createRunner(child);
    await runner.init();

    const first = runner.send(session, text);
    await Promise.resolve();
    await expect(runner.send(session, 'Another message')).rejects.toBeInstanceOf(ReplyBusyError);
    await vi.advanceTimersByTimeAsync(3_000);
    await first;
    expect(runner.isRunning(session.id)).toBe(true);
    child.emit('close', 0);
    expect(runner.isRunning(session.id)).toBe(false);
  });

  it('rejects a quick non-zero exit with the stderr tail', async () => {
    const child = fakeChild();
    const { runner } = createRunner(child);
    await runner.init();

    const sending = runner.send(session, text);
    await Promise.resolve();
    (child.stderr as PassThrough).write('CLI could not resume the session');
    child.emit('close', 2);
    await expect(sending).rejects.toMatchObject({
      name: 'ReplyFailedError',
      stderrTail: 'CLI could not resume the session',
    } satisfies Partial<ReplyFailedError>);
    expect(runner.isRunning(session.id)).toBe(false);
  });

  it('returns after the startup window while tracking the background run', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const { runner } = createRunner(child);
    const changes: string[] = [];
    runner.onChange = (id) => changes.push(id);
    await runner.init();

    const sending = runner.send(session, text);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3_000);
    await sending;
    expect(runner.isRunning(session.id)).toBe(true);
    expect(changes).toEqual([session.id]);

    child.emit('close', 0);
    expect(runner.isRunning(session.id)).toBe(false);
    expect(changes).toEqual([session.id, session.id]);
  });
});
