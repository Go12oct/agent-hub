import { describe, expect, it } from 'vitest';
import { parseCodexRecords } from '../src/collectors/codex.js';
import { parseAntigravityRecords } from '../src/collectors/antigravity.js';
import { sanitizeDisplayText, sanitizeTitle } from '../src/collectors/files.js';

describe('tag sanitization', () => {
  it('cleans Codex <heartbeat> titles and assistant previews', () => {
    const now = Date.parse('2026-11-21T08:00:00.000Z');
    const parsed = parseCodexRecords([
      { type: 'session_meta', payload: { id: 'hb-1', timestamp: '2026-11-21T07:50:00.000Z' } },
      {
        type: 'response_item',
        timestamp: '2026-11-21T07:51:00.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ input_text: '<heartbeat>\n  <automation_id>daily-teaching-applications</automation_id>\n  <current_time_iso>2026-11-21T07:51:00Z</current_time_iso>\n  <instructions>Check apps</instructions>\n</heartbeat>' }],
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-11-21T07:52:00.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final',
          content: [{ text: '<heartbeat>\n  <automation_id>daily-teaching-applications</automation_id>\n  <decision>DONT_NOTIFY</decision>\n  <message>No new applications needed.</message>\n</heartbeat>' }],
        },
      },
    ], 'hb-1', now);

    expect(parsed.session.title).toBe('Daily teaching applications');
    expect(parsed.session.lastMessage).toBe('No new applications needed.');
  });

  it('strips <openbot_saved_memories>, <oai-mem-citation>, and <send_user_message_question_reply>', () => {
    const now = Date.parse('2026-11-21T08:00:00.000Z');
    const parsed = parseCodexRecords([
      { type: 'session_meta', payload: { id: 'mem-1', timestamp: '2026-11-21T07:50:00.000Z' } },
      {
        type: 'response_item',
        timestamp: '2026-11-21T07:51:00.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ input_text: '<openbot_saved_memories>Secret memory</openbot_saved_memories>\nCheck Windows Update' }],
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-11-21T07:52:00.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final',
          content: [{ text: 'All good.\n&lt;oai-mem-citation&gt;MEMORY.md:1-5&lt;/oai-mem-citation&gt;\n<oai-mem-citation>hidden</oai-mem-citation>' }],
        },
      },
    ], 'mem-1', now);

    expect(parsed.session.title).toBe('Check Windows Update');
    expect(parsed.session.lastMessage).toBe('All good.');

    expect(sanitizeTitle('<send_user_message_question_reply>[{"question":"Work permit?","answer":"Yes"}]</send_user_message_question_reply>'))
      .toBe('Work permit?: Yes');
  });

  it('strips Antigravity <voice_instructions> and <talker_agent_context> wrappers', () => {
    const parsed = parseAntigravityRecords([
      {
        role: 'user',
        timestamp: '2026-11-21T07:50:00.000Z',
        text: '<USER_REQUEST>\n<voice_instructions>\n<talker_agent_context>Voice context</talker_agent_context>\n1. Speak concisely.\n</voice_instructions>\nFix the login flow\n</USER_REQUEST>',
      },
    ], 'anti-1', '2026-11-21T07:50:00.000Z');

    expect(parsed.session.title).toBe('Fix the login flow');
  });

  it('replaces Devin <ref_file /> tags with file basenames', () => {
    expect(sanitizeDisplayText('Saved in <ref_file file="D:\\AWS\\Files\\Projects\\CTA\\PROGRESS.md" /> and <ref_file file="frontend/manifest.webmanifest" />.'))
      .toBe('Saved in PROGRESS.md and manifest.webmanifest.');
  });
});
