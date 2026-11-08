import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PendingApproval } from '@agent-hub/shared';

const maxDatabaseAgeMs = 24 * 60 * 60 * 1000;
const eventTypePath = '$.content._meta."cognition.ai/eventType"';

interface FileStamp {
  mtimeMs: number;
  size: number;
  walMtimeMs: number;
  walSize: number;
}

interface MessageRow {
  position: number;
  title: string | null;
  status: string | null;
  toolCallId: string | null;
  eventType: string | null;
  requestId: string | null;
  permissionType: string | null;
  toolName: string | null;
  toolArgs: string | null;
  command: string | null;
  resourceTitle: string | null;
  timestamp: string | number | null;
  secretName: string | null;
  note: string | null;
  secretInstructions: string | null;
}

interface CachedFile {
  stamp: FileStamp;
  cards: Map<string, PendingApproval[]>;
}

const fileCache = new Map<string, CachedFile>();

function defaultDirectory(): string {
  return path.join(process.env.APPDATA ?? '', 'Devin', 'User', 'acp-messages');
}

function cacheKey(stamp: FileStamp): string {
  return `${stamp.mtimeMs}:${stamp.size}:${stamp.walMtimeMs}:${stamp.walSize}`;
}

function fileStamp(file: string): FileStamp {
  const database = statSync(file);
  let walMtimeMs = 0;
  let walSize = 0;
  try {
    const wal = statSync(`${file}-wal`);
    walMtimeMs = wal.mtimeMs;
    walSize = wal.size;
  } catch { /* No WAL file is a valid checkpointed database. */ }
  return { mtimeMs: database.mtimeMs, size: database.size, walMtimeMs, walSize };
}

function sameStamp(left: FileStamp, right: FileStamp): boolean {
  return cacheKey(left) === cacheKey(right);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function requestedAt(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 1_000_000_000_000 ? value * 1000 : value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function truncate(value: string): string {
  return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
}

function prettyToolArgs(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return truncate(JSON.stringify(JSON.parse(value), null, 2));
  } catch {
    return truncate(value);
  }
}

function detailText(...parts: Array<string | null>): string | undefined {
  const value = parts.map((part) => part?.trim()).filter(Boolean).join('\n\n');
  return value || undefined;
}

function appendCards(
  target: Map<string, PendingApproval[]>,
  source: Map<string, PendingApproval[]>,
): void {
  for (const [sessionId, cards] of source) {
    const byId = new Map((target.get(sessionId) ?? []).map((card) => [card.id, card]));
    for (const card of cards) byId.set(card.id, card);
    target.set(sessionId, [...byId.values()]);
  }
}

function readDatabase(file: string): Map<string, PendingApproval[]> {
  const cards = new Map<string, PendingApproval[]>();
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    const infoRow = database.prepare('SELECT value FROM meta WHERE key = ?').get('info') as
      | { value: string }
      | undefined;
    if (!infoRow || typeof infoRow.value !== 'string') return cards;
    const info = JSON.parse(infoRow.value) as {
      _meta?: Record<string, unknown>;
    };
    const metadata = info?._meta;
    const url = stringValue(metadata?.['cognition.ai/url']);
    if (String(metadata?.['cognition.ai/sessionStatus'] ?? '').toLowerCase() !== 'running' || !url) return cards;
    const match = /\/sessions\/([a-f\d]+)(?:[/?#]|$)/i.exec(url);
    if (!match?.[1]) return cards;
    const sessionId = match[1].toLowerCase();
    const maxUserRow = database.prepare(
      "SELECT max(position) AS position FROM messages WHERE kind = 'user_message'",
    ).get() as { position: number | null } | undefined;
    const maxUser = maxUserRow?.position ?? 0;
    const rows = database.prepare(`
      SELECT
        position,
        json_extract(payload, '$.content.title') AS title,
        json_extract(payload, '$.content.status') AS status,
        json_extract(payload, '$.content.toolCallId') AS toolCallId,
        json_extract(payload, '${eventTypePath}') AS eventType,
        json_extract(payload, '$.content._meta."cognition.ai/requestId"') AS requestId,
        json_extract(payload, '$.content._meta."cognition.ai/permissionType"') AS permissionType,
        json_extract(payload, '$.content._meta."cognition.ai/toolName"') AS toolName,
        json_extract(payload, '$.content._meta."cognition.ai/toolArgs"') AS toolArgs,
        json_extract(payload, '$.content._meta."cognition.ai/command"') AS command,
        json_extract(payload, '$.content._meta."cognition.ai/resourceTitle"') AS resourceTitle,
        json_extract(payload, '$.content._meta."cognition.ai/timestamp"') AS timestamp,
        json_extract(payload, '$.content._meta."cognition.ai/secretName"') AS secretName,
        json_extract(payload, '$.content._meta."cognition.ai/note"') AS note,
        json_extract(payload, '$.content._meta."cognition.ai/secretInstructions"') AS secretInstructions
      FROM messages
      WHERE position > ? AND kind = 'tool_call'
        AND json_extract(payload, '${eventTypePath}') IN (
          'permission_request', 'permission_resolved', 'request_secret', 'local_access_requested'
        )
      ORDER BY position
    `).all(maxUser) as unknown as MessageRow[];
    const permissionResolution = database.prepare(`
      SELECT 1
      FROM messages
      WHERE position > ? AND kind = 'tool_call'
        AND json_extract(payload, '${eventTypePath}') = 'permission_resolved'
        AND lower(json_extract(payload, '$.content.status')) IN ('completed', 'failed')
        AND instr(payload, ?) > 0
      LIMIT 1
    `);

    for (const row of rows) {
      let approval: PendingApproval | undefined;
      const eventType = row.eventType;
      const status = String(row.status ?? '').toLowerCase();
      if (eventType === 'permission_request') {
        const requestId = stringValue(row.requestId);
        if (!requestId || permissionResolution.get(row.position, requestId)) continue;
        const localMachine = String(row.permissionType ?? '').toLowerCase() === 'local_machine';
        const title = stringValue(row.title) ?? 'Permission requested';
        const toolName = localMachine ? 'Run a command' : stringValue(row.toolName) ?? 'Permission request';
        const resourceTitle = stringValue(row.resourceTitle);
        const command = stringValue(row.command);
        const toolArgs = prettyToolArgs(row.toolArgs);
        approval = {
          id: `devin-card:${requestId}`,
          toolName,
          summary: localMachine
            ? 'Run a command on your PC'
            : resourceTitle
              ? `${toolName} — ${resourceTitle}`
              : title.replace(/^Permission requested\s*/, ''),
          ...(localMachine ? (command ? { detail: command } : {}) : (toolArgs ? { detail: toolArgs } : {})),
          readOnly: true,
          requestedAt: requestedAt(row.timestamp),
        };
      } else if (eventType === 'request_secret' && status === 'pending') {
        const requestId = stringValue(row.requestId);
        const secretName = stringValue(row.secretName);
        if (!requestId || !secretName) continue;
        const answeredLater = rows.some((later) => later.position > row.position
          && later.eventType === 'request_secret'
          && String(later.status ?? '').toLowerCase() === 'completed'
          && later.secretName === secretName);
        if (answeredLater) continue;
        approval = {
          id: `devin-card:${requestId}`,
          toolName: 'Credentials',
          summary: `Credentials requested: ${secretName}`,
          ...(detailText(row.note, row.secretInstructions) ? { detail: detailText(row.note, row.secretInstructions)! } : {}),
          readOnly: true,
          requestedAt: requestedAt(row.timestamp),
        };
      } else if (eventType === 'local_access_requested' && status === 'pending') {
        if (rows.some((later) => later.position > row.position && later.eventType === 'local_access_requested')) continue;
        const toolCallId = stringValue(row.toolCallId);
        if (!toolCallId) continue;
        approval = {
          id: `devin-card:${toolCallId}`,
          toolName: 'Local access',
          summary: stringValue(row.title) ?? 'Local access requested',
          readOnly: true,
          requestedAt: requestedAt(row.timestamp),
        };
      }
      if (approval) {
        const existing = cards.get(sessionId) ?? [];
        cards.set(sessionId, [...existing, approval]);
      }
    }
  } catch {
    return cards;
  } finally {
    try { database?.close(); } catch { /* Ignore a database that became unavailable. */ }
  }
  return cards;
}

function removeCachedDirectory(directory: string): void {
  for (const file of fileCache.keys()) {
    if (path.relative(directory, file) && !path.relative(directory, file).startsWith(`..${path.sep}`)) {
      fileCache.delete(file);
    }
  }
}

export function readDevinDesktopCards(
  dir = defaultDirectory(),
): Map<string, PendingApproval[]> {
  const directory = path.resolve(dir);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    removeCachedDirectory(directory);
    return new Map();
  }
  const result = new Map<string, PendingApproval[]>();
  const seen = new Set<string>();
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.db')) continue;
    const file = path.join(directory, entry);
    let stamp: FileStamp;
    try {
      stamp = fileStamp(file);
    } catch {
      fileCache.delete(file);
      continue;
    }
    seen.add(file);
    if (now - Math.max(stamp.mtimeMs, stamp.walMtimeMs) > maxDatabaseAgeMs) {
      fileCache.delete(file);
      continue;
    }
    const cached = fileCache.get(file);
    if (cached && sameStamp(cached.stamp, stamp)) {
      appendCards(result, cached.cards);
      continue;
    }
    const cards = readDatabase(file);
    fileCache.set(file, { stamp, cards });
    appendCards(result, cards);
  }
  for (const file of fileCache.keys()) {
    const relative = path.relative(directory, file);
    if (relative && !relative.startsWith(`..${path.sep}`) && !seen.has(file)) fileCache.delete(file);
  }
  return result;
}
