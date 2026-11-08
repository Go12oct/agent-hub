// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@agent-hub/shared';
import { ChatView, FinishedGroupHeader, statusLabel } from './AgentHub';

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('session status labels', () => {
  it('uses waiting copy for approval-less Devin sessions only', () => {
    const waiting: AgentSession = {
      id: 'devin:waiting-session',
      agent: 'devin',
      nativeId: 'waiting-session',
      title: 'Devin session',
      status: 'needs_input',
      canReply: false,
      updatedAt: new Date().toISOString(),
      machine: 'desktop',
    };
    expect(statusLabel(waiting)).toBe('Waiting on you');
    expect(statusLabel({ ...waiting, agent: 'claude-code' })).toBe('Needs you');
    expect(statusLabel({
      ...waiting,
      approval: {
        id: 'approval',
        toolName: 'Write',
        summary: 'Write a file',
        requestedAt: new Date().toISOString(),
      },
    })).toBe('Needs you');
  });
});

describe('finished group header', () => {
  it('shows a plain count while searching and keeps the toggle otherwise', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const onToggle = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(FinishedGroupHeader, {
        count: 3,
        search: 'tests',
        finishedOpen: true,
        onToggle,
      }));
    });
    const label = container.querySelector('.finished-toggle');
    expect(label?.tagName).toBe('DIV');
    expect(label?.textContent).toBe('3 finished or idle');
    expect(container.querySelector('button')).toBeNull();
    expect(onToggle).not.toHaveBeenCalled();

    await act(async () => {
      root?.render(createElement(FinishedGroupHeader, {
        count: 3,
        search: '',
        finishedOpen: false,
        onToggle,
      }));
    });
    const toggle = container.querySelector<HTMLButtonElement>('button.finished-toggle');
    expect(toggle?.textContent).toBe('3 finished or idleShow');
    await act(async () => toggle?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
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
