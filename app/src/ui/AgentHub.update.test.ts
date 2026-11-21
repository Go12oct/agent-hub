// @vitest-environment happy-dom

import { createHmac } from 'node:crypto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('update banner', () => {
  it('shows the update banner, remembers dismissal across remount, and flags an out-of-date PC daemon', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('__APP_VERSION__', '0.2.6');
    vi.stubGlobal('EventSource', MockEventSource);
    const storage = createStorage();
    vi.stubGlobal('localStorage', storage);

    storage.setItem('agent-hub-pairing', JSON.stringify({
      url: 'http://127.0.0.1:4747',
      token: 'test-token',
    }));

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/health')) {
        const parsed = new URL(url);
        const nonce = parsed.searchParams.get('nonce');
        const proof = nonce ? createHmac('sha256', 'test-token').update(nonce).digest('hex') : undefined;
        return new Response(JSON.stringify({ ok: true, service: 'agent-hub', ...(proof ? { proof } : {}) }), { status: 200 });
      }
      if (url.includes('/api/sessions')) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes('/api/update')) {
        return new Response(JSON.stringify({
          currentVersion: '0.2.5',
          latestVersion: '9.9.9',
          updateAvailable: true,
          releaseUrl: 'https://github.com/Go12oct/agent-hub/releases/tag/v9.9.9',
          androidDownloadUrl: 'https://github.com/Go12oct/agent-hub/releases/download/v9.9.9/agent-hub-android.apk',
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));

    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(AgentHub));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('.update-banner')?.textContent).toContain('v9.9.9');
    });
    expect(container.querySelector('.update-banner')?.textContent).toContain('PC app is out of date');

    const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss update"]');
    expect(dismiss).not.toBeNull();
    await act(async () => {
      dismiss?.click();
    });
    expect(container.querySelector('.update-banner')).toBeNull();
    expect(storage.getItem('agent-hub-update-dismissed')).toBe('9.9.9');

    await act(async () => root?.unmount());
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(AgentHub));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('.screen')).not.toBeNull();
    });
    expect(container.querySelector('.update-banner')).toBeNull();
  });
});
