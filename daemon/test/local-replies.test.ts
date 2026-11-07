import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@agent-hub/shared';
import {
  buildReplyCommand, cleanReplyError, LocalReplyRunner, ReplyBusyError, ReplyFailedError,
  warnLocalReplyFailure, type CommandRunner, type ReplyAgent,
} from '../src/local-replies';

const text = 'Run the tests without changing permissions';

describe('reply error messages', () => {
  it('removes hook/model warnings and keeps the final Error line', () => {
    const stderr = [
      'Error: That session is running in the background (b1c5c281). Run `claude attach b1c5c281` to open it, or `claude stop b1c5c281` first to resume it here. Add --fork-session to branch off a copy instead.',
      'SessionEnd hook [python3 /tmp/hook.py] failed: Python was not found',
      "Warning: Claude Code doesn't recognize the model 'unknown'.",
      '[claude-code:unrecognized_model] unsupported model',
    ].join('\n');
    expect(cleanReplyError(stderr)).toBe('That session is running in the background (b1c5c281). Run `claude attach b1c5c281` to open it, or `claude stop b1c5c281` first to resume it here. Add --fork-session to branch off a copy instead.');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnLocalReplyFailure('claude-code', 'claude-code:session', 'line one\nline two');
      expect(warn).toHaveBeenCalledWith('Local reply failed: claude-code claude-code:session: line one line two');
    } finally { warn.mockRestore(); }
  });
});

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
    const command = buildReplyCommand(agent, 'session_123-abc', text, process.cwd(), executable, platform);
    const shellShim = shell;
    const resumeFlag = agent === 'claude-code' ? '--resume' : agent === 'antigravity' ? '--conversation' : undefined;
    expect(command.command).toBe(shellShim ? `"${executable}"` : executable);
    expect(command.shell).toBe(shell);
    expect(command.cwd).toBe(process.cwd());
    if (agent === 'codex') {
      expect(command.args).toEqual(['exec', 'resume', '--skip-git-repo-check', 'session_123-abc', '-']);
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

  it('requires an existing project directory except for Antigravity', () => {
    expect(buildReplyCommand('antigravity', 'session_123', text, undefined, 'agy', 'linux').cwd).toBe(os.homedir());
    expect(() => buildReplyCommand('codex', 'session_123', text, undefined, 'codex', 'linux'))
      .toThrow("Couldn't find this chat's project folder");
    expect(() => buildReplyCommand('claude-code', 'session_123', text, undefined, 'claude', 'linux'))
      .toThrow("Couldn't find this chat's project folder");

    const missing = '/agent-hub-missing-project';
    expect(() => buildReplyCommand('antigravity', 'session_123', text, missing, 'agy', 'linux'))
      .toThrow(`Project folder not found: ${missing}`);
    expect(() => buildReplyCommand('codex', 'session_123', text, process.execPath, 'codex', 'linux'))
      .toThrow(`Project folder not found: ${process.execPath}`);
  });

  it.each(['C:\\bad&path\\codex.cmd', 'C:\\bad\npath\\codex.cmd'])(
    'rejects unsafe shell shim paths',
    (executable) => {
      expect(() => buildReplyCommand('codex', 'session_123', text, process.cwd(), executable, 'win32'))
        .toThrow('Unsafe CLI path');
    },
  );
});

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 1234,
    stdin: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

function backgroundChild(output: string, exitCode: number): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  queueMicrotask(() => {
    if (output) child.stdout.write(output);
    child.emit('close', exitCode);
  });
  return child as unknown as ChildProcess;
}

const session: AgentSession = {
  id: 'codex:session_123',
  agent: 'codex',
  nativeId: 'session_123',
  title: 'Test',
  cwd: process.cwd(),
  status: 'done',
  canReply: false,
  updatedAt: new Date().toISOString(),
  machine: 'test',
};

function createRunner(child: ChildProcess, options: { startupMs?: number; timeoutMs?: number } = {}) {
  const spawnProcess = vi.fn(() => child);
  const runner = new LocalReplyRunner({
    commands: { codex: 'codex' },
    resolve: async () => undefined,
    spawn: spawnProcess as unknown as typeof spawn,
    startupMs: options.startupMs,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  return { runner, spawnProcess };
}

function claudeSession(nativeId = 'claude-session'): AgentSession {
  return {
    ...session,
    id: `claude-code:${nativeId}`,
    agent: 'claude-code',
    nativeId,
    canReply: true,
  };
}

describe('LocalReplyRunner', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the existing -p reply path when the Claude session is not backgrounded', async () => {
    const calls: string[][] = [];
    const commandRunner: CommandRunner = async (_executable, args) => {
      calls.push(args);
      return { stdout: '[]', stderr: '', exitCode: 0 };
    };
    const spawnProcess = vi.fn((_executable: string, _args: string[]) => backgroundChild('', 0));
    const runner = new LocalReplyRunner({
      commands: { 'claude-code': 'claude' },
      resolve: async () => undefined,
      commandRunner,
      spawn: spawnProcess as unknown as typeof spawn,
      startupMs: 1,
    });
    await runner.send(claudeSession(), text);
    expect(calls).toEqual([['agents', '--json']]);
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual(['--resume', 'claude-session', '-p', text]);
  });

  it('falls back to the existing -p path if Claude agents output is unavailable', async () => {
    const spawnProcess = vi.fn((_executable: string, _args: string[]) => backgroundChild('', 0));
    const runner = new LocalReplyRunner({
      commands: { 'claude-code': 'claude' },
      resolve: async () => undefined,
      commandRunner: async () => { throw new Error('agents unavailable'); },
      spawn: spawnProcess as unknown as typeof spawn,
      startupMs: 1,
    });
    await runner.send(claudeSession(), text);
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual(['--resume', 'claude-session', '-p', text]);
  });

  it('rejects a busy background Claude session', async () => {
    const spawnProcess = vi.fn();
    const runner = new LocalReplyRunner({
      commands: { 'claude-code': 'claude' },
      resolve: async () => undefined,
      commandRunner: async () => ({
        stdout: JSON.stringify([{ id: 'short-id', sessionId: 'claude-session', status: 'running' }]),
        stderr: '',
        exitCode: 0,
      }),
      spawn: spawnProcess as unknown as typeof spawn,
    });
    await expect(runner.send(claudeSession(), text)).rejects.toMatchObject({
      name: 'ReplyBusyError',
      message: 'Claude is still working on this chat in the background. Send again when it finishes.',
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('serializes concurrent sends while checking an idle background Claude session', async () => {
    const calls: string[][] = [];
    let agentCalls = 0;
    let releaseInitial: ((result: { stdout: string; stderr: string; exitCode: number }) => void) | undefined;
    const commandRunner: CommandRunner = async (_executable, args) => {
      calls.push(args);
      if (args[0] === 'agents' && ++agentCalls === 1) {
        return new Promise((resolve) => { releaseInitial = resolve; });
      }
      if (args[0] === 'agents') return { stdout: '[]', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const spawnProcess = vi.fn((_executable: string, _args: string[]) => backgroundChild('backgrounded · short-id', 0));
    const runner = new LocalReplyRunner({
      commands: { 'claude-code': 'claude' },
      resolve: async () => undefined,
      commandRunner,
      sleep: async () => {},
      spawn: spawnProcess as unknown as typeof spawn,
    });
    const claude = claudeSession();
    await runner.init();
    const first = runner.send(claude, text);
    await vi.waitFor(() => expect(releaseInitial).toBeTypeOf('function'));
    expect(runner.isRunning(claude.id)).toBe(true);
    await expect(runner.send(claude, 'Another message')).rejects.toBeInstanceOf(ReplyBusyError);
    releaseInitial!({
      stdout: JSON.stringify([{ id: 'short-id', sessionId: claude.nativeId, status: 'idle' }]),
      stderr: '',
      exitCode: 0,
    });
    await first;
    expect(calls.filter(([command]) => command === 'stop')).toEqual([['stop', 'short-id']]);
    expect(spawnProcess.mock.calls.filter(([, args]) => args[0] === '--bg')).toHaveLength(1);
    expect(runner.isRunning(claude.id)).toBe(false);
  });

  it('validates a background Claude session cwd before running agents or stop', async () => {
    const calls: string[][] = [];
    const commandRunner: CommandRunner = async (_executable, args) => {
      calls.push(args);
      return { stdout: '[]', stderr: '', exitCode: 0 };
    };
    const runner = new LocalReplyRunner({
      commands: { 'claude-code': 'claude' },
      resolve: async () => undefined,
      commandRunner,
    });
    const cwd = path.join(os.tmpdir(), `agent-hub-missing-cwd-${process.pid}`);
    await expect(runner.send({ ...claudeSession(), cwd }, text)).rejects.toMatchObject({
      name: 'ReplyFailedError',
      message: `Project folder not found: ${cwd}`,
    });
    expect(calls).toEqual([]);
  });

  it('does not pass phone text through a Windows shell shim for background Claude', async () => {
    const runner = new LocalReplyRunner({
      commands: { 'claude-code': 'claude.cmd' },
      resolve: async () => undefined,
      commandRunner: async () => ({
        stdout: JSON.stringify([{ id: 'short-id', sessionId: 'claude-session', status: 'idle' }]),
        stderr: '',
        exitCode: 0,
      }),
    });
    await expect(runner.send(claudeSession(), text)).rejects.toMatchObject({
      name: 'ReplyFailedError',
      message: 'Replying to background Claude chats needs the claude.exe install.',
    });
  });

  it('stops, polls, and resumes an idle background Claude session', async () => {
    const results = [
      JSON.stringify([{ id: 'short-id', sessionId: 'claude-session', status: 'idle' }]),
      JSON.stringify([{ id: 'short-id', sessionId: 'claude-session', status: 'idle' }]),
      '[]',
    ];
    const calls: string[][] = [];
    const commandRunner: CommandRunner = async (_executable, args) => {
      calls.push(args);
      return args[0] === 'agents'
        ? { stdout: results.shift()!, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 };
    };
    const spawnProcess = vi.fn((_executable: string, _args: string[]) => backgroundChild('note: woke session short-id\nbackgrounded · short-id', 0));
    const runner = new LocalReplyRunner({
      commands: { 'claude-code': 'claude' },
      resolve: async () => undefined,
      commandRunner,
      sleep: async () => {},
      spawn: spawnProcess as unknown as typeof spawn,
    });
    await runner.send(claudeSession(), text);
    expect(calls).toEqual([
      ['agents', '--json'],
      ['stop', 'short-id'],
      ['agents', '--json'],
      ['agents', '--json'],
    ]);
    expect(spawnProcess).toHaveBeenCalledWith('claude', ['--bg', '--resume', 'claude-session', text], expect.objectContaining({ shell: false, cwd: process.cwd() }));
  });

  it('stops a mistakenly started Claude copy and reports the retryable failure', async () => {
    const results = [
      JSON.stringify([{ id: 'short-id', sessionId: 'claude-session', status: 'idle' }]),
      '[]',
    ];
    const calls: string[][] = [];
    const commandRunner: CommandRunner = async (_executable, args) => {
      calls.push(args);
      return args[0] === 'agents'
        ? { stdout: results.shift()!, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 };
    };
    const spawnProcess = vi.fn(() => backgroundChild('note: session short-id is already running in the background, so this started a copy as copy-id', 1));
    const runner = new LocalReplyRunner({
      commands: { 'claude-code': 'claude' },
      resolve: async () => undefined,
      commandRunner,
      sleep: async () => {},
      spawn: spawnProcess as unknown as typeof spawn,
    });
    await expect(runner.send(claudeSession(), text)).rejects.toMatchObject({
      name: 'ReplyFailedError',
      message: 'Claude restarted this chat as a copy; send again in a few seconds.',
    });
    expect(calls).toEqual([
      ['agents', '--json'],
      ['stop', 'short-id'],
      ['agents', '--json'],
      ['stop', 'copy-id'],
    ]);
  });

  it('only allows Antigravity replies for chats in the agy CLI store', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-antigravity-home-'));
    const previousHome = process.env.AGENT_HUB_HOME;
    process.env.AGENT_HUB_HOME = home;
    const cliHome = path.join(home, '.gemini', 'antigravity-cli');
    const runner = new LocalReplyRunner({
      commands: { codex: 'codex', antigravity: 'agy' },
      resolve: async () => undefined,
    });
    const antigravitySession = (nativeId: string): AgentSession => ({
      ...session,
      id: `antigravity:${nativeId}`,
      agent: 'antigravity',
      nativeId,
    });

    try {
      await mkdir(path.join(cliHome, 'conversations'), { recursive: true });
      await writeFile(path.join(cliHome, 'conversations', 'cli-db.db'), '');
      await writeFile(path.join(cliHome, 'conversations', 'cli-pb.pb'), '');
      await mkdir(path.join(cliHome, 'brain', 'cli-brain'), { recursive: true });
      await mkdir(path.join(home, '.gemini', 'antigravity', 'conversations'), { recursive: true });
      await writeFile(path.join(home, '.gemini', 'antigravity', 'conversations', 'ide-only.db'), '');
      await runner.init();

      expect(runner.canReplyTo(session)).toBe(true);
      expect(runner.canReplyTo(antigravitySession('cli-db'))).toBe(true);
      expect(runner.canReplyTo(antigravitySession('cli-pb'))).toBe(true);
      expect(runner.canReplyTo(antigravitySession('cli-brain'))).toBe(true);
      const ideSession = antigravitySession('ide-only');
      expect(runner.canReplyTo(ideSession)).toBe(false);
      await expect(runner.send(ideSession, text)).rejects.toMatchObject({
        name: 'ReplyFailedError',
        message: 'Antigravity can only continue chats started with the agy CLI',
      });
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_HUB_HOME;
      else process.env.AGENT_HUB_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

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

  it('records a late failure and clears it when a new reply starts', async () => {
    vi.useFakeTimers();
    const firstChild = fakeChild();
    const secondChild = fakeChild();
    const children = [firstChild, secondChild];
    const runner = new LocalReplyRunner({
      commands: { codex: 'codex' },
      resolve: async () => undefined,
      spawn: vi.fn(() => children.shift()!) as unknown as typeof spawn,
      startupMs: 10,
      timeoutMs: 60_000,
    });
    await runner.init();

    const first = runner.send(session, text);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await first;
    firstChild.emit('close', 7);
    expect(runner.failure(session.id)).toEqual({
      error: 'Codex stopped with exit code 7',
      at: expect.any(String),
    });

    const second = runner.send(session, text);
    await Promise.resolve();
    expect(runner.failure(session.id)).toBeUndefined();
    secondChild.emit('close', 0);
    await second;
  });

  it('stores a cleaned late failure for the session feed', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const { runner } = createRunner(child, { startupMs: 1 });
    await runner.init();
    const sending = runner.send(session, text);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);
    await sending;
    (child.stderr as PassThrough).write('Error: Claude could not resume\nSessionEnd hook [python3 /hook.py] failed: Python was not found');
    child.emit('close', 1);
    expect(runner.failure(session.id)?.error).toBe('Claude could not resume');
  });

  it('handles stdin EPIPE errors and records a late failure', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const { runner } = createRunner(child, { startupMs: 10 });
    await runner.init();

    const sending = runner.send(session, text);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await sending;
    expect((child.stdin as PassThrough).writableEnded).toBe(true);

    (child.stdin as PassThrough).emit('error', new Error('EPIPE'));
    expect(runner.isRunning(session.id)).toBe(true);
    expect(runner.failure(session.id)).toBeUndefined();

    child.emit('close', 0);
    expect(runner.isRunning(session.id)).toBe(false);
    expect(runner.failure(session.id)).toEqual({
      error: 'EPIPE',
      at: expect.any(String),
    });
  });

  it('keeps an unresponsive timed-out process active through the SIGKILL grace period', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const { runner } = createRunner(child, { startupMs: 10, timeoutMs: 20 });
    await runner.init();

    const sending = runner.send(session, text);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await sending;
    await vi.advanceTimersByTimeAsync(10);

    expect(runner.isRunning(session.id)).toBe(true);
    expect(runner.failure(session.id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(runner.isRunning(session.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(runner.isRunning(session.id)).toBe(true);
    expect(runner.failure(session.id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(runner.isRunning(session.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(runner.isRunning(session.id)).toBe(false);
    expect(runner.failure(session.id)).toEqual({
      error: "Couldn't stop Codex after timeout",
      at: expect.any(String),
    });
  });

  it('finalizes after exit when close does not arrive', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const { runner } = createRunner(child, { startupMs: 10 });
    await runner.init();

    const sending = runner.send(session, text);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await sending;

    child.emit('exit', 2);
    expect(runner.isRunning(session.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(runner.isRunning(session.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    expect(runner.isRunning(session.id)).toBe(false);
    const failure = runner.failure(session.id);
    expect(failure).toEqual({
      error: 'Codex stopped with exit code 2',
      at: expect.any(String),
    });

    child.emit('close', 9);
    expect(runner.failure(session.id)).toEqual(failure);
  });
});
