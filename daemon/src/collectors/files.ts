import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AgentKind, AgentSession, SessionMessage, SessionStatus } from '@agent-hub/shared';

export async function walkFiles(root: string, accept: (file: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  const queue = [root];
  while (queue.length) {
    const dir = queue.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile() && accept(full)) found.push(full);
    }
  }
  return found;
}

export async function readBoundedLines(file: string, tailBytes = 1_500_000): Promise<string[]> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    const headLength = Math.min(info.size, 48_000);
    const head = Buffer.alloc(headLength);
    if (headLength) await handle.read(head, 0, headLength, 0);
    const tailLength = Math.min(Math.max(0, info.size - headLength), tailBytes);
    const tail = Buffer.alloc(tailLength);
    if (tailLength) await handle.read(tail, 0, tailLength, info.size - tailLength);
    const combined = `${head.toString('utf8')}\n${tail.toString('utf8')}`;
    return combined.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
  } finally {
    await handle.close();
  }
}

export function parseJsonLines(file: string): Promise<Record<string, any>[]> {
  return readBoundedLines(file).then((lines) => {
    const values: Record<string, any>[] = [];
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as Record<string, any>;
        if (value && typeof value === 'object') values.push(value);
      } catch {
        // Partial trailing writes are expected while agents are running.
      }
    }
    return values;
  });
}

export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    const item = part as Record<string, unknown>;
    return typeof item.text === 'string' ? item.text : '';
  }).filter(Boolean).join('\n');
}

export function projectName(cwd?: string): string | undefined {
  return cwd ? path.basename(path.normalize(cwd.replaceAll('\\', '/'))) || undefined : undefined;
}

export function inferStatus(
  updatedAt: string,
  lastRole: string | undefined,
  completed: boolean,
  errored: boolean,
  now = Date.now(),
): SessionStatus {
  if (errored) return 'error';
  const age = now - Date.parse(updatedAt);
  if (age < 90_000 && !(lastRole === 'assistant' && completed)) return 'working';
  if (lastRole === 'assistant' && completed && age < 6 * 60 * 60 * 1000) return 'needs_input';
  return 'idle';
}

export function buildSession(input: {
  agent: AgentKind;
  nativeId: string;
  title?: string;
  cwd?: string;
  branch?: string;
  updatedAt: string;
  startedAt?: string;
  status: SessionStatus;
  lastMessage?: string;
  lastRole?: AgentSession['lastRole'];
  url?: string;
}): AgentSession {
  return {
    ...input,
    id: `${input.agent}:${input.nativeId}`,
    title: input.title || `${input.agent} session`,
    project: projectName(input.cwd),
    machine: os.hostname(),
  };
}

export async function filesModifiedAfter(files: string[], cutoff: number): Promise<string[]> {
  const output: string[] = [];
  for (const file of files) {
    try {
      if ((await stat(file)).mtimeMs >= cutoff) output.push(file);
    } catch {
      // Files can disappear during a scan.
    }
  }
  return output;
}

export function isoOrNow(value: unknown): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value || ''));
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function message(text: string, role: SessionMessage['role'], at?: string): SessionMessage {
  return { text: text.slice(0, 20_000), role, at };
}
