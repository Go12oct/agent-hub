// @vitest-environment happy-dom

import { createHmac } from 'node:crypto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@agent-hub/shared';
import { AgentHub } from './AgentHub';

let root: Root | undefined;

function createStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => { data.clear(); },
  };
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

class MockEventSource {
  addEventListener() {}
  close() {}
}

describe('dynamic agent tabs', () => {
  it('shows only All and synced agents instead of hardcoded empty tabs', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('__APP_VERSION__', '0.2.7');
    vi.stubGlobal('EventSource', MockEventSource);
    const storage = createStorage();
    vi.stubGlobal('localStorage', storage);

    storage.setItem('agent-hub-pairing', JSON.stringify({
      url: 'http://127.0.0.1:4747',
      token: 'test-token',
    }));

    const sessions: AgentSession[] = [
      {
        id: 'codex:1',
        agent: 'codex',
        nativeId: '1',
        title: 'Only Codex session',
        status: 'done',
        canReply: true,
        updatedAt: new Date().toISOString(),
        machine: 'pc',
      },
    ];

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/health')) {
        const nonce = new URL(url).searchParams.get('nonce');
        const proof = nonce ? createHmac('sha256', 'test-token').update(nonce).digest('hex') : undefined;
        return new Response(JSON.stringify({ ok: true, service: 'agent-hub', ...(proof ? { proof } : {}) }), { status: 200 });
      }
      if (url.includes('/api/sessions')) return new Response(JSON.stringify(sessions), { status: 200 });
      if (url.includes('/api/update')) return new Response(JSON.stringify({ currentVersion: '0.2.7', updateAvailable: false }), { status: 200 });
      return new Response('{}', { status: 200 });
    }));

    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(AgentHub));
    });
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.tabs .tab').length).toBe(2);
    });

    const tabLabels = [...container.querySelectorAll('.tabs .tab')].map((el) => el.textContent?.trim());
    expect(tabLabels).toEqual(['All 1', 'Codex 1']);
    expect(container.querySelector('.tabs')?.textContent).not.toContain('Devin');
    expect(container.querySelector('.tabs')?.textContent).not.toContain('Claude Code');
    expect(container.querySelector('.tabs')?.textContent).not.toContain('Antigravity');
  });
});
