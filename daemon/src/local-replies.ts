import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentLabels, type AgentSession } from '@agent-hub/shared';
import { agentHome } from './config.js';

export type ReplyAgent = 'codex' | 'claude-code' | 'antigravity' | 'devin';

export interface ReplyCommand {
  command: string;
  args: string[];
  stdin?: string;
  shell: boolean;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface ReplyFailure {
  error: string;
  at: string;
}

export interface ReplyRunner {
  onChange?: (sessionId: string) => void;
  init?(): Promise<void>;
  supports(agent: ReplyAgent): boolean;
  canReplyTo?(session: AgentSession): boolean;
  isRunning(sessionId: string): boolean;
  failure(sessionId: string): ReplyFailure | undefined;
  send(session: AgentSession, text: string): Promise<void>;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (
  executable: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
) => Promise<CommandResult>;

interface BackgroundClaudeAgent {
  id: string;
  sessionId: string;
  status?: string;
}

function runCommandFile(executable: string, args: string[], options: { cwd?: string; timeoutMs: number }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable),
    }, (error, stdout, stderr) => {
      const result = { stdout: String(stdout || ''), stderr: String(stderr || ''), exitCode: 0 };
      if (error) {
        Object.assign(error, result);
        reject(error);
      } else resolve(result);
    });
  });
}

function parseBackgroundAgents(output: string): BackgroundClaudeAgent[] | undefined {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const agent = value as Record<string, unknown>;
      if (typeof agent.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(agent.id) || typeof agent.sessionId !== 'string') return [];
      return [{
        id: agent.id,
        sessionId: agent.sessionId,
        ...(typeof agent.status === 'string' ? { status: agent.status } : {}),
      }];
    });
  } catch {
    return undefined;
  }
}

export class ReplyBusyError extends Error {
  constructor(message = 'That agent is still working on your last message') {
    super(message);
    this.name = 'ReplyBusyError';
  }
}

export class ReplyFailedError extends Error {
  constructor(readonly stderrTail: string, message = stderrTail) {
    super(message);
    this.name = 'ReplyFailedError';
  }
}

export function cleanReplyError(stderr: string): string {
  const lines = stderr.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/hook \[.*\] failed:/i.test(line))
    .filter((line) => !/doesn't recognize the model|\[claude-code:unrecognized_model\]/i.test(line));
  const errorLine = lines.filter((line) => /^Error:\s*/i.test(line)).at(-1);
  return (errorLine ? errorLine.replace(/^Error:\s*/i, '') : lines.at(-1) || '').slice(0, 300);
}

export function warnLocalReplyFailure(agent: string, sessionId: string, message: string): void {
  console.warn(`Local reply failed: ${agent} ${sessionId}: ${message.replace(/[\r\n]+/g, ' ').slice(0, 300)}`);
}

export function devinCliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => {
    const normalizedKey = key.toUpperCase();
    return normalizedKey !== 'ACP_BACKEND' && !normalizedKey.startsWith('WINDSURF_');
  }));
}

const commandNames: Record<ReplyAgent, string> = {
  codex: 'codex',
  'claude-code': 'claude',
  antigravity: 'agy',
  devin: 'devin',
};

function quoteExecutable(executable: string): string {
  return `"${executable}"`;
}

function workingDirectoryForReply(agent: ReplyAgent, cwd: string | undefined): string {
  if (cwd === undefined) {
    if (agent !== 'antigravity') {
      throw new ReplyFailedError('', "Couldn't find this chat's project folder");
    }
    return os.homedir();
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) throw new ReplyFailedError('', `Project folder not found: ${cwd}`);
  return cwd;
}

export function buildReplyCommand(
  agent: ReplyAgent,
  nativeId: string,
  text: string,
  cwd: string | undefined,
  executable: string,
  platform = process.platform,
): ReplyCommand {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(nativeId)) {
    throw new Error('Invalid session ID');
  }

  const shell = platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
  if (agent === 'devin' && shell) {
    throw new ReplyFailedError('', 'Replying to Devin Local chats needs devin.exe');
  }
  if (shell && /["%&|<>^!\r\n]/.test(executable)) {
    throw new ReplyFailedError('', 'Unsafe CLI path');
  }
  const command = shell ? quoteExecutable(executable) : executable;
  const workingDirectory = workingDirectoryForReply(agent, cwd);

  if (agent === 'codex') {
    return {
      command,
      args: ['exec', 'resume', '--skip-git-repo-check', nativeId, '-'],
      stdin: text,
      shell,
      cwd: workingDirectory,
    };
  }

  if (agent === 'devin') {
    return {
      command,
      args: ['--respect-workspace-trust', 'false', '-r', nativeId, `--print=${text}`],
      shell: false,
      cwd: workingDirectory,
      env: devinCliEnv(),
    };
  }

  const resumeFlag = agent === 'claude-code' ? '--resume' : '--conversation';
  const args = shell
    ? [resumeFlag, nativeId, '-p']
    : [resumeFlag, nativeId, '-p', text];
  return {
    command,
    args,
    ...(shell ? { stdin: text } : {}),
    shell,
    cwd: workingDirectory,
  };
}

function execute(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export async function resolveExecutable(name: string): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const output = await execute('where.exe', [name]);
      const priority = new Map([['.exe', 0], ['.cmd', 1], ['.bat', 2]]);
      return output
        .split(/\r?\n/)
        .map((candidate) => candidate.trim())
        .filter(Boolean)
        .map((candidate) => ({ candidate, extension: path.win32.extname(candidate).toLowerCase() }))
        .filter(({ extension }) => priority.has(extension))
        .sort((left, right) => priority.get(left.extension)! - priority.get(right.extension)!)[0]?.candidate;
    }
    const output = await execute('sh', ['-c', 'command -v "$1"', 'agent-hub', name]);
    return output.split(/\r?\n/).map((candidate) => candidate.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

interface ActiveReply {
  child: ChildProcess;
  timeout: NodeJS.Timeout;
}

export class LocalReplyRunner implements ReplyRunner {
  onChange?: (sessionId: string) => void;
  private readonly spawnProcess: typeof spawn;
  private readonly resolve: typeof resolveExecutable;
  private readonly commands: Partial<Record<ReplyAgent, string>>;
  private readonly timeoutMs: number;
  private readonly startupMs: number;
  private readonly commandRunner: CommandRunner;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly executables = new Map<ReplyAgent, string>();
  private readonly active = new Map<string, ActiveReply>();
  private readonly backgroundInFlight = new Set<string>();
  private readonly lastFailure = new Map<string, ReplyFailure>();
  private initPromise?: Promise<void>;

  constructor(options: {
    spawn?: typeof spawn;
    resolve?: typeof resolveExecutable;
    commands?: Partial<Record<ReplyAgent, string>>;
    commandRunner?: CommandRunner;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    startupMs?: number;
  } = {}) {
    this.spawnProcess = options.spawn || spawn;
    this.resolve = options.resolve || resolveExecutable;
    this.commands = options.commands || {};
    this.commandRunner = options.commandRunner || runCommandFile;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? 20 * 60_000;
    this.startupMs = options.startupMs ?? 3_000;
  }

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = Promise.all(
        (Object.entries(commandNames) as Array<[ReplyAgent, string]>).map(async ([agent, name]) => {
          const executable = this.commands[agent] || await this.resolve(name);
          if (executable) this.executables.set(agent, executable);
        }),
      ).then(() => undefined);
    }
    return this.initPromise;
  }

  supports(agent: ReplyAgent): boolean {
    return this.executables.has(agent);
  }

  canReplyTo(session: AgentSession): boolean {
    if (session.agent === 'devin') {
      return session.id.startsWith('devin-local:') && this.supports('devin');
    }
    if (session.agent !== 'antigravity') {
      return (session.agent === 'codex' || session.agent === 'claude-code')
        && this.supports(session.agent);
    }
    if (!this.supports('antigravity') || !/^[A-Za-z0-9._-]{1,128}$/.test(session.nativeId)) return false;

    const cliHome = path.join(agentHome(), '.gemini', 'antigravity-cli');
    return existsSync(path.join(cliHome, 'conversations', `${session.nativeId}.db`))
      || existsSync(path.join(cliHome, 'conversations', `${session.nativeId}.pb`))
      || existsSync(path.join(cliHome, 'brain', session.nativeId));
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId) || this.backgroundInFlight.has(sessionId);
  }

  failure(sessionId: string): ReplyFailure | undefined {
    return this.lastFailure.get(sessionId);
  }

  async send(session: AgentSession, text: string): Promise<void> {
    if (session.agent === 'devin'
      && session.id.startsWith('devin-local:')
      && session.status === 'working') {
      throw new ReplyBusyError('Devin is still working in this chat. Send again when it finishes.');
    }
    if (this.isRunning(session.id)) throw new ReplyBusyError();
    await this.init();
    if (this.isRunning(session.id)) throw new ReplyBusyError();

    const agent = session.agent as ReplyAgent;
    const executable = this.executables.get(agent);
    if (!executable) throw new ReplyFailedError('', `Failed to start ${session.agent}`);
    if (!this.canReplyTo(session)) {
      if (agent === 'antigravity') {
        throw new ReplyFailedError('', 'Antigravity can only continue chats started with the agy CLI');
      }
      throw new ReplyFailedError('', `Failed to start ${session.agent}`);
    }

    if (agent === 'claude-code') workingDirectoryForReply(agent, session.cwd);
    if (agent === 'claude-code') {
      this.backgroundInFlight.add(session.id);
      this.notify(session.id);
      try {
        const agents = await this.backgroundClaudeAgents(executable, session.cwd);
        const background = agents?.find((item) => item.sessionId === session.nativeId);
        if (background) {
          if (background.status !== 'idle') {
            throw new ReplyBusyError('Claude is still working on this chat in the background. Send again when it finishes.');
          }
          await this.resumeBackgroundClaude(executable, background, session, text);
          return;
        }
      } finally {
        this.backgroundInFlight.delete(session.id);
        this.notify(session.id);
      }
    }

    const command = buildReplyCommand(agent, session.nativeId, text, session.cwd, executable);
    let child: ChildProcess;
    try {
      child = this.spawnProcess(command.command, command.args, {
        cwd: command.cwd,
        shell: command.shell,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
        ...(command.env ? { env: command.env } : {}),
      });
    } catch (error) {
      throw new ReplyFailedError('', error instanceof Error ? error.message : String(error));
    }

    this.lastFailure.delete(session.id);
    let stderrTail = '';
    let startupSettled = false;
    let finished = false;
    let pendingFailure: string | undefined;

    return new Promise<void>((resolve, reject) => {
      let startupTimer: NodeJS.Timeout;
      let timeout: NodeJS.Timeout;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let exitGraceTimer: NodeJS.Timeout | undefined;
      let stopGraceTimer: NodeJS.Timeout | undefined;
      let spawned = child.pid !== undefined;
      let exited = false;
      const finish = (code: number | null, error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(startupTimer);
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (exitGraceTimer) clearTimeout(exitGraceTimer);
        if (stopGraceTimer) clearTimeout(stopGraceTimer);
        if (this.active.get(session.id)?.child === child) this.active.delete(session.id);
        const failed = Boolean(error || pendingFailure) || code !== 0;
        const rawFailureMessage = error
          ? stderrTail || error.message || `Failed to start ${agentLabels[agent]}`
          : pendingFailure || stderrTail || `${agentLabels[agent]} stopped with exit code ${code ?? 'unknown'}`;
        const failureMessage = cleanReplyError(stderrTail || rawFailureMessage) || rawFailureMessage;
        if (startupSettled && failed) {
          this.lastFailure.set(session.id, { error: failureMessage, at: new Date().toISOString() });
          warnLocalReplyFailure(session.agent, session.id, failureMessage);
        }
        this.notify(session.id);
        console.log(`Local reply exited: ${session.agent} ${session.id} (${failed ? 'error' : code ?? 'unknown'})`);

        if (!startupSettled) {
          startupSettled = true;
          if (failed) reject(new ReplyFailedError(cleanReplyError(stderrTail) || stderrTail, failureMessage));
          else resolve();
        }
      };

      timeout = setTimeout(() => {
        if (finished) return;
        pendingFailure = 'Timed out after 20 minutes';
        this.kill(child);
        if (!finished) {
          forceKillTimer = setTimeout(() => {
            if (finished) return;
            try {
              child.kill('SIGKILL');
            } catch {}
            if (finished) return;
            stopGraceTimer = setTimeout(() => {
              if (finished) return;
              pendingFailure = `Couldn't stop ${agentLabels[agent]} after timeout`;
              finish(null);
            }, 30_000);
          }, 10_000);
        }
      }, this.timeoutMs);
      this.active.set(session.id, { child, timeout });
      this.notify(session.id);
      console.log(`Local reply started: ${session.agent} ${session.id}`);
      startupTimer = setTimeout(() => {
        if (startupSettled) return;
        startupSettled = true;
        resolve();
      }, this.startupMs);

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrTail = `${stderrTail}${chunk.toString()}`.slice(-500);
      });
      child.once('spawn', () => { spawned = true; });
      child.once('error', (error) => {
        if (!spawned) finish(null, error);
        else pendingFailure ||= error.message || 'Local reply process error';
      });
      child.once('exit', (code) => {
        if (finished) return;
        exited = true;
        exitGraceTimer = setTimeout(() => finish(code), 5_000);
      });
      child.once('close', (code) => finish(code));
      child.stdin?.on('error', (error) => {
        pendingFailure ||= error.message || 'Failed to write to CLI stdin';
      });

      try {
        if (command.stdin === undefined) child.stdin?.end();
        else child.stdin?.end(command.stdin);
      } catch (error) {
        pendingFailure ||= error instanceof Error ? error.message : String(error);
      }
    });
  }

  private async backgroundClaudeAgents(executable: string, cwd?: string, timeoutMs = 10_000): Promise<BackgroundClaudeAgent[] | undefined> {
    try {
      const result = await this.commandRunner(executable, ['agents', '--json'], { cwd, timeoutMs });
      if (result.exitCode !== 0) return undefined;
      return parseBackgroundAgents(result.stdout);
    } catch {
      return undefined;
    }
  }

  private async resumeBackgroundClaude(
    executable: string,
    background: BackgroundClaudeAgent,
    session: AgentSession,
    text: string,
  ): Promise<void> {
    if (/\.(?:cmd|bat)$/i.test(executable)) {
      throw this.backgroundFailure(session, 'Replying to background Claude chats needs the claude.exe install.');
    }
    try {
      await this.commandRunner(executable, ['stop', background.id], { cwd: session.cwd, timeoutMs: 10_000 });
    } catch {}

    const deadline = Date.now() + 15_000;
    let paused = false;
    while (Date.now() <= deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const agents = await this.backgroundClaudeAgents(executable, session.cwd, Math.min(10_000, remaining));
      if (agents && !agents.some((item) => item.sessionId === session.nativeId)) {
        paused = true;
        break;
      }
      const wait = deadline - Date.now();
      if (wait <= 0) break;
      await this.sleep(Math.min(1000, wait));
    }
    if (!paused) throw this.backgroundFailure(session, "Couldn't pause the background Claude session. Try again.");

    let result: CommandResult;
    try {
      result = await this.runBackgroundReply(executable, session, text);
    } catch (error) {
      throw this.backgroundFailure(session, error instanceof Error ? error.message : String(error));
    }
    const output = `${result.stdout}\n${result.stderr}`;
    const copyId = output.match(/started a copy as\s+([A-Za-z0-9._-]+)/i)?.[1];
    if (/started a copy/i.test(output)) {
      if (copyId) {
        try {
          await this.commandRunner(executable, ['stop', copyId], { cwd: session.cwd, timeoutMs: 10_000 });
        } catch {}
      }
      throw this.backgroundFailure(session, 'Claude restarted this chat as a copy; send again in a few seconds.');
    }
    if (result.exitCode !== 0 || !/backgrounded/i.test(output)) {
      const message = cleanReplyError(`${result.stderr}\n${result.stdout}`) || `Claude background reply failed with exit code ${result.exitCode}`;
      throw this.backgroundFailure(session, message);
    }
    this.lastFailure.delete(session.id);
    this.notify(session.id);
  }

  private backgroundFailure(session: AgentSession, rawMessage: string): ReplyFailedError {
    const message = cleanReplyError(rawMessage) || rawMessage;
    this.lastFailure.set(session.id, { error: message, at: new Date().toISOString() });
    this.notify(session.id);
    return new ReplyFailedError(message, message);
  }

  private runBackgroundReply(executable: string, session: AgentSession, text: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: Error, code?: number | null) => {
        if (settled) return;
        settled = true;
        if (error) reject(new ReplyFailedError(cleanReplyError(stderr || error.message), cleanReplyError(stderr || error.message) || error.message));
        else resolve({ stdout, stderr, exitCode: code ?? 1 });
      };
      let child: ChildProcess;
      try {
        child = this.spawnProcess(executable, ['--bg', '--resume', session.nativeId, text], {
          cwd: session.cwd,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        const message = cleanReplyError(error instanceof Error ? error.message : String(error));
        reject(new ReplyFailedError(message, message || `Failed to start ${agentLabels['claude-code']}`));
        return;
      }
      child.stdout?.on('data', (chunk: Buffer | string) => { stdout = `${stdout}${chunk.toString()}`.slice(-10_000); });
      child.stderr?.on('data', (chunk: Buffer | string) => { stderr = `${stderr}${chunk.toString()}`.slice(-10_000); });
      child.once('error', (error) => finish(error));
      child.once('close', (code) => finish(undefined, code));
    });
  }

  private notify(sessionId: string): void {
    try {
      this.onChange?.(sessionId);
    } catch {
      console.error('Local reply status update failed');
    }
  }

  private kill(child: ChildProcess): void {
    try {
      if (process.platform === 'win32' && child.pid) {
        const killer = this.spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.once('error', () => { child.kill(); });
        return;
      }
      child.kill();
    } catch {
      child.kill();
    }
  }
}
