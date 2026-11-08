import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDevinDesktopCards } from '../src/collectors/devin-desktop-cards';

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

interface FixtureRow {
  position: number;
  kind?: string;
  payload: Record<string, unknown>;
}

function toolCall(
  eventType: string,
  status: string,
  metadata: Record<string, unknown>,
  title = `${eventType}: fixture`,
  toolCallId = `tool-${eventType}`,
): Record<string, unknown> {
  return {
    id: `tool:${toolCallId}`,
    kind: 'tool_call',
    content: {
      toolCallId,
      title,
      kind: 'tool_call',
      status,
      _meta: {
        'cognition.ai/eventType': eventType,
        ...Object.fromEntries(Object.entries(metadata).map(([key, value]) => [`cognition.ai/${key}`, value])),
      },
    },
    sourceEventId: `event-${toolCallId}`,
    sourceEventTimestampMs: 1_740_000_000_000,
    sourceEventIsStart: false,
    sourceEventType: 'tool_call',
    warnings: [],
  };
}

function sessionInfo(id: string, overrides: {
  url?: string;
  status?: string;
} = {}): Record<string, unknown> {
  return {
    title: `Session ${id}`,
    _meta: {
      ...(overrides.url === undefined ? { 'cognition.ai/url': `https://app.devin.ai/sessions/${id}` } : { 'cognition.ai/url': overrides.url }),
      'cognition.ai/sessionStatus': overrides.status ?? 'running',
    },
  };
}

async function createDatabase(
  file: string,
  info: Record<string, unknown>,
  rows: FixtureRow[],
): Promise<void> {
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE messages (position INTEGER PRIMARY KEY, kind TEXT, payload TEXT);');
  database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('info', JSON.stringify(info));
  const insert = database.prepare('INSERT INTO messages (position, kind, payload) VALUES (?, ?, ?)');
  for (const row of rows) insert.run(row.position, row.kind ?? 'tool_call', JSON.stringify(row.payload));
  database.close();
}

describe('Devin Desktop approval cards', () => {
  it('reads only fresh running cloud sessions and omits stale, resolved, and secret values', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-devin-desktop-'));
    const secretCiphertext = 'fixture-encrypted-secret-not-for-output';
    const userMessage = { position: 1, kind: 'user_message', payload: { kind: 'user_message' } };
    await createDatabase(path.join(directory, 'permission.db'), sessionInfo('abc123'), [
      userMessage,
      {
        position: 2,
        payload: {
          id: 'tool:perm-local',
          kind: 'tool_call',
          content: {
            toolCallId: 'tool-perm-local',
            title: 'Permission requested (local_machine): Command: git status --short',
            kind: 'tool_call',
            status: 'completed',
            _meta: {
              'cognition.ai/eventType': 'permission_request',
              'cognition.ai/requestId': 'perm-local',
              'cognition.ai/permissionType': 'local_machine',
              'cognition.ai/toolName': 'local_exec',
              'cognition.ai/toolArgs': '{"command":"git status"}',
              'cognition.ai/command': 'git status --short',
              'cognition.ai/timestamp': '2025-03-01T10:00:00.000Z',
            },
          },
          sourceEventId: 'event-perm-local',
          sourceEventTimestampMs: 1_740_000_000_000,
          sourceEventIsStart: false,
          sourceEventType: 'tool_call',
          warnings: [],
        },
      },
    ]);
    await createDatabase(path.join(directory, 'resolved.db'), sessionInfo('def456'), [
      userMessage,
      { position: 2, payload: toolCall('permission_request', 'completed', {
        requestId: 'perm-resolved', permissionType: 'devin_mcp', toolName: 'devin_automation_manage',
        resourceTitle: 'BTECCheck outreach autopilot', toolArgs: '{"operation":"run"}', timestamp: '2025-03-01T10:01:00.000Z',
      }) },
      { position: 3, payload: toolCall('permission_resolved', 'failed', { requestId: 'perm-resolved' }) },
    ]);
    await createDatabase(path.join(directory, 'stale-card.db'), sessionInfo('aaa111'), [
      { position: 1, payload: toolCall('permission_request', 'completed', {
        requestId: 'perm-old', permissionType: 'devin_mcp', toolName: 'old', timestamp: '2025-03-01T10:02:00.000Z',
      }) },
      { ...userMessage, position: 2 },
    ]);
    await createDatabase(path.join(directory, 'secret-open.db'), sessionInfo('bbb222'), [
      userMessage,
      {
        position: 2,
        payload: {
          id: 'tool:secret-open',
          kind: 'tool_call',
          content: {
            toolCallId: 'tool-secret-open',
            title: 'Requesting secret: FAKE_TOKEN — Needed for tests',
            kind: 'tool_call',
            status: 'pending',
            _meta: {
              'cognition.ai/eventId': 'event-secret-open',
              'cognition.ai/eventType': 'request_secret',
              'cognition.ai/requestId': 'secret-open',
              'cognition.ai/timestamp': '2025-03-01T10:03:00.000Z',
              'cognition.ai/createdAtMs': 1_740_000_000_000,
              'cognition.ai/secretName': 'FAKE_TOKEN',
              'cognition.ai/note': 'Needed for tests',
              'cognition.ai/secretInstructions': 'Use the test account',
            },
          },
          sourceEventId: 'event-secret-open',
          sourceEventTimestampMs: 1_740_000_000_000,
          sourceEventIsStart: false,
          sourceEventType: 'tool_call',
          warnings: [],
        },
      },
    ]);
    await createDatabase(path.join(directory, 'secret-answered.db'), sessionInfo('ccc333'), [
      userMessage,
      { position: 2, payload: toolCall('request_secret', 'pending', {
        requestId: 'secret-pending', secretName: 'FAKE_TOKEN', note: 'Needed',
        timestamp: '2025-03-01T10:04:00.000Z',
      }, 'Requesting secret: FAKE_TOKEN — Needed') },
      { position: 3, payload: {
        ...toolCall('request_secret', 'completed', {
          requestId: 'secret-answer', secretName: 'FAKE_TOKEN',
          encryptedValue: secretCiphertext, timestamp: '2025-03-01T10:05:00.000Z',
        }, 'Secret provided: FAKE_TOKEN'),
      } },
    ]);
    await createDatabase(path.join(directory, 'access-open.db'), sessionInfo('ddd444'), [
      userMessage,
      { position: 2, payload: toolCall('local_access_requested', 'pending', {
        timestamp: '2025-03-01T10:06:00.000Z',
      }, 'Local access requested', 'tool-access-open') },
    ]);
    await createDatabase(path.join(directory, 'access-resolved.db'), sessionInfo('eee555'), [
      userMessage,
      { position: 2, payload: toolCall('local_access_requested', 'pending', {
        timestamp: '2025-03-01T10:07:00.000Z',
      }, 'Local access requested', 'tool-access-pending') },
      { position: 3, payload: toolCall('local_access_requested', 'completed', {
        timestamp: '2025-03-01T10:08:00.000Z',
      }, 'Local access granted', 'tool-access-granted') },
    ]);
    await createDatabase(path.join(directory, 'no-url.db'), sessionInfo('fff666', { url: '' }), [
      userMessage,
      { position: 2, payload: toolCall('permission_request', 'completed', {
        requestId: 'no-url-card', toolName: 'tool', timestamp: '2025-03-01T10:09:00.000Z',
      }) },
    ]);
    await createDatabase(path.join(directory, 'exit.db'), sessionInfo('abc777', { status: 'exit' }), [
      userMessage,
      { position: 2, payload: toolCall('permission_request', 'completed', {
        requestId: 'exit-card', toolName: 'tool', timestamp: '2025-03-01T10:10:00.000Z',
      }) },
    ]);
    const staleFile = path.join(directory, 'stale.db');
    await createDatabase(staleFile, sessionInfo('abc888'), [
      userMessage,
      { position: 2, payload: toolCall('permission_request', 'completed', {
        requestId: 'stale-db-card', toolName: 'tool', timestamp: '2025-03-01T10:11:00.000Z',
      }) },
    ]);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(staleFile, old, old);
    await writeFile(path.join(directory, 'corrupt.db'), 'not a sqlite database');

    const cards = readDevinDesktopCards(directory);
    expect(cards.get('abc123')).toMatchObject([{
      id: 'devin-card:perm-local',
      toolName: 'Run a command',
      summary: 'Run a command on your PC',
      detail: 'git status --short',
      readOnly: true,
      requestedAt: '2025-03-01T10:00:00.000Z',
    }]);
    expect(cards.get('bbb222')).toMatchObject([{
      id: 'devin-card:secret-open',
      toolName: 'Credentials',
      summary: 'Credentials requested: FAKE_TOKEN',
      detail: 'Needed for tests\n\nUse the test account',
      readOnly: true,
      requestedAt: '2025-03-01T10:03:00.000Z',
    }]);
    expect(cards.get('ddd444')).toMatchObject([{
      id: 'devin-card:tool-access-open',
      toolName: 'Local access',
      summary: 'Local access requested',
      readOnly: true,
    }]);
    for (const sessionId of ['def456', 'aaa111', 'ccc333', 'eee555', 'fff666', 'abc777', 'abc888']) {
      expect(cards.has(sessionId)).toBe(false);
    }
    expect(JSON.stringify([...cards])).not.toContain(secretCiphertext);
  });

  it('pretty-prints tool arguments for ordinary permission requests', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-devin-desktop-permission-'));
    await createDatabase(path.join(directory, 'mcp.db'), sessionInfo('123abc'), [
      { position: 1, kind: 'user_message', payload: { kind: 'user_message' } },
      {
        position: 2,
        payload: {
          id: 'tool:permission-fake',
          kind: 'tool_call',
          content: {
            toolCallId: 'tool-permission-fake',
            title: 'Permission requested (devin_mcp): Run automation',
            kind: 'tool_call',
            status: 'completed',
            _meta: {
              'cognition.ai/eventId': 'event-permission-fake',
              'cognition.ai/timestamp': '2025-03-01T11:00:00.000Z',
              'cognition.ai/createdAtMs': 1_740_000_000_000,
              'cognition.ai/eventType': 'permission_request',
              'cognition.ai/requestId': 'mcp-permission',
              'cognition.ai/permissionType': 'devin_mcp',
              'cognition.ai/command': 'fake command',
              'cognition.ai/toolName': 'devin_automation_manage',
              'cognition.ai/toolArgs': { operation: 'run', count: 2 },
              'cognition.ai/approvedCallId': 'approved-fake-call',
              'cognition.ai/requestedPermissions': ['devin_automation_manage'],
              'cognition.ai/resourceTitle': 'BTECCheck outreach autopilot',
              'cognition.ai/priority': 1,
            },
          },
          sourceEventId: 'event-permission-fake',
          sourceEventTimestampMs: 1_740_000_000_000,
          sourceEventIsStart: false,
          sourceEventType: 'tool_call',
          warnings: [],
        },
      },
      { position: 3, payload: toolCall('permission_request', 'completed', {
        requestId: 'mcp-title-fallback',
        permissionType: 'devin_mcp',
        toolName: 'devin_mcp_tool',
        toolArgs: { action: 'inspect' },
        timestamp: '2025-03-01T11:01:00.000Z',
      }, 'Permission requested (devin_mcp): Manual approval') },
    ]);

    expect(readDevinDesktopCards(directory).get('123abc')).toMatchObject([{
      id: 'devin-card:mcp-permission',
      toolName: 'devin_automation_manage',
      summary: 'devin_automation_manage — BTECCheck outreach autopilot',
      detail: '{\n  "operation": "run",\n  "count": 2\n}',
      readOnly: true,
      requestedAt: '2025-03-01T11:00:00.000Z',
    }, {
      id: 'devin-card:mcp-title-fallback',
      summary: '(devin_mcp): Manual approval',
      requestedAt: '2025-03-01T11:01:00.000Z',
    }]);
  });
});
