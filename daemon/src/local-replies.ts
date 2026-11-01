import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession } from '@agent-hub/shared';

export type ReplyAgent = 'codex' | 'claude-code' | 'antigravity';

export interface ReplyCommand {
  command: string;
  args: string[];
  stdin?: string;
  shell: boolean;
  cwd: string;
}

export interface ReplyRunner {
  onChange?: (sessionId: string) => void;
  init?(): Promise<void>;
  supports(agent: ReplyAgent): boolean;
  isRunning(sessionId: string): boolean;
  send(session: AgentSession, text: string): Promise<void>;
}

export class ReplyBusyError extends Error {
  constructor() {
    super('That agent is still working on your last message');
    this.name = 'ReplyBusyError';
  }
}

export class ReplyFailedError extends Error {
  constructor(readonly stderrTail: string, message = stderrTail) {
    super(message);
    this.name = 'ReplyFailedError';
  }
}

const commandNames: Record<ReplyAgent, string> = {
  codex: 'codex',
  'claude-code': 'claude',
  antigravity: 'agy',
};

function quoteExecutable(executable: string): string {
  return `"${executable}"`;
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
  const command = shell ? quoteExecutable(executable) : executable;
  const workingDirectory = cwd && existsSync(cwd) ? cwd : os.homedir();

  if (agent === 'codex') {
    return {
      command,
      args: ['exec', 'resume', nativeId, '-'],
      stdin: text,
      shell,
      cwd: workingDirectory,
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
  private readonly executables = new Map<ReplyAgent, string>();
  private readonly active = new Map<string, ActiveReply>();
  private initPromise?: Promise<void>;

  constructor(options: {
    spawn?: typeof spawn;
    resolve?: typeof resolveExecutable;
    commands?: Partial<Record<ReplyAgent, string>>;
    timeoutMs?: number;
  } = {}) {
    this.spawnProcess = options.spawn || spawn;
    this.resolve = options.resolve || resolveExecutable;
    this.commands = options.commands || {};
    this.timeoutMs = options.timeoutMs ?? 20 * 60_000;
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

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  async send(session: AgentSession, text: string): Promise<void> {
    if (this.isRunning(session.id)) throw new ReplyBusyError();
    await this.init();
    if (this.isRunning(session.id)) throw new ReplyBusyError();

    const agent = session.agent as ReplyAgent;
    const executable = this.executables.get(agent);
    if (!executable) throw new ReplyFailedError('', `Failed to start ${session.agent}`);

    const command = buildReplyCommand(agent, session.nativeId, text, session.cwd, executable);
    let child: ChildProcess;
    try {
      child = this.spawnProcess(command.command, command.args, {
        cwd: command.cwd,
        shell: command.shell,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    } catch (error) {
      throw new ReplyFailedError('', error instanceof Error ? error.message : String(error));
    }

    let stderrTail = '';
    let startupSettled = false;
    let finished = false;
    let startupTimer: NodeJS.Timeout;
    const timeout = setTimeout(() => this.kill(child), this.timeoutMs);
    this.active.set(session.id, { child, timeout });
    this.notify(session.id);
    console.log(`Local reply started: ${session.agent} ${session.id}`);

    return new Promise<void>((resolve, reject) => {
      const finish = (code: number | null, error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(startupTimer);
        clearTimeout(timeout);
        if (this.active.get(session.id)?.child === child) this.active.delete(session.id);
        this.notify(session.id);
        console.log(`Local reply exited: ${session.agent} ${session.id} (${error ? 'error' : code ?? 'unknown'})`);

        if (!startupSettled) {
          startupSettled = true;
          if (error || code !== 0) reject(new ReplyFailedError(stderrTail, error?.message));
          else resolve();
        }
      };

      startupTimer = setTimeout(() => {
        if (startupSettled) return;
        startupSettled = true;
        resolve();
      }, 3_000);

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrTail = `${stderrTail}${chunk.toString()}`.slice(-500);
      });
      child.once('error', (error) => finish(null, error));
      child.once('close', (code) => finish(code));

      if (command.stdin === undefined) child.stdin?.end();
      else child.stdin?.end(command.stdin);
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
