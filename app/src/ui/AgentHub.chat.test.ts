// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@agent-hub/shared';
import { ChatView } from './AgentHub';

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('ChatView reply stop control', () => {
  it('renders Stop only while a reply is running and posts once with authentication', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let resolveStop!: (response: Response) => void;
    const stopResponse = new Promise<Response>((resolve) => { resolveStop = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith('/reply/stop')) return stopResponse;
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const session: AgentSession = {
      id: 'devin-local:glaze-spark',
      agent: 'devin',
      nativeId: 'glaze-spark',
      title: 'Devin Local session',
      status: 'working',
      canReply: true,
      replyRunning: false,
      updatedAt: new Date().toISOString(),
      machine: 'desktop',
    };
    const container = document.createElement('div');
    document.body.append(container);
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => {},
    });
    root = createRoot(container);
    const pairing = { url: 'http://hub.test', token: 'pair-token' };

    await act(async () => {
      root?.render(createElement(ChatView, { session, pairing, onBack: () => {} }));
    });
    expect(container.querySelector('.stop-reply')).toBeNull();

    await act(async () => {
      root?.render(createElement(ChatView, {
        session: { ...session, replyRunning: true },
        pairing,
        onBack: () => {},
      }));
    });
    const stopButton = container.querySelector<HTMLButtonElement>('.stop-reply');
    expect(stopButton?.textContent).toBe('Stop');
    expect(stopButton?.disabled).toBe(false);

    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });
    expect(stopButton?.disabled).toBe(true);
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });

    const stopCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/reply/stop'));
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]?.[0]).toBe(
      `http://hub.test/api/sessions/${encodeURIComponent(session.id)}/reply/stop`,
    );
    expect(stopCalls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer pair-token' },
    });

    await act(async () => {
      resolveStop(new Response(JSON.stringify({ stopped: true }), { status: 200 }));
      await stopResponse;
    });
    expect(stopButton?.disabled).toBe(false);
  });
});
