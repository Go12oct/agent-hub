// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, PendingApproval } from '@agent-hub/shared';
import type { QueueItem } from '../home';
import { ChatView, DeckCard, FinishedGroupHeader, statusLabel } from './AgentHub';

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

describe('Devin deck link', () => {
  it('renders only for Devin input cards with a URL and does not bubble card gestures', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const session = (agent: AgentSession['agent'], id: string, url?: string): AgentSession => ({
      id: `${agent}:${id}`,
      agent,
      nativeId: id,
      title: `${agent} session`,
      status: 'needs_input',
      canReply: true,
      updatedAt: new Date().toISOString(),
      machine: 'desktop',
      ...(url ? { url } : {}),
    });
    const onOpen = vi.fn();
    const onDecide = vi.fn();
    const onPointerDown = vi.fn();
    const onClick = vi.fn();
    const sessions = [
      session('devin', 'with-url', 'https://devin.ai/sessions/with-url'),
      session('claude-code', 'claude-with-url', 'https://example.com/claude'),
      session('devin', 'without-url'),
    ];
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement('div', { onPointerDown, onClick },
        ...sessions.map((itemSession) => {
          const item: QueueItem = { kind: 'input', session: itemSession };
          return createElement(DeckCard, {
            key: itemSession.id,
            item,
            depth: 0,
            onOpen,
            onDecide,
          });
        }),
      ));
    });

    const cards = container.querySelectorAll('.deck-card');
    const devinLink = cards[0]?.querySelector<HTMLAnchorElement>('.deck-open-in');
    expect(devinLink?.textContent).toContain('Open in Devin');
    expect(devinLink?.getAttribute('href')).toBe('https://devin.ai/sessions/with-url');
    expect(devinLink?.target).toBe('_blank');
    expect(devinLink?.rel).toBe('noreferrer');
    expect(cards[1]?.querySelector('.deck-open-in')).toBeNull();
    expect(cards[2]?.querySelector('.deck-open-in')).toBeNull();

    await act(async () => {
      devinLink?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      devinLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe('read-only Devin approvals', () => {
  const approval: PendingApproval = {
    id: 'devin-card:permission-1',
    toolName: 'Run a command',
    summary: 'Run a command on your PC',
    detail: 'git status --short',
    requestedAt: new Date().toISOString(),
    readOnly: true,
  };
  const session: AgentSession = {
    id: 'devin:abc123',
    agent: 'devin',
    nativeId: 'abc123',
    title: 'Cloud session',
    status: 'needs_input',
    canReply: false,
    approval,
    approvals: [approval],
    updatedAt: new Date().toISOString(),
    url: 'https://app.devin.ai/sessions/abc123',
    machine: 'desktop',
  };

  it('shows Open in Devin and no decision controls in the deck', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const onDecide = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(DeckCard, {
        item: { kind: 'approval', session, approval },
        depth: 0,
        onOpen: vi.fn(),
        onDecide,
      }));
    });
    const card = container.querySelector('.deck-card');
    const link = card?.querySelector<HTMLAnchorElement>('.deck-readonly-open-in');
    expect(card?.textContent).toContain(approval.summary);
    expect(card?.querySelector('.deck-readonly-detail')?.textContent).toBe(approval.detail);
    expect(link?.textContent).toContain('Open in Devin');
    expect(link?.href).toBe(session.url);
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noreferrer');
    expect(card?.querySelector('.deck-actions')).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('shows the read-only approval in chat without Allow or Deny controls', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => {},
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(ChatView, {
        session,
        pairing: { url: 'http://hub.test', token: 'pair-token' },
        onBack: () => {},
      }));
    });
    const card = container.querySelector('.approval-read-only');
    const link = card?.querySelector<HTMLAnchorElement>('.approval-open-in');
    expect(card?.textContent).toContain(approval.summary);
    expect(card?.querySelector('.approval-read-only-detail')?.textContent).toBe(approval.detail);
    expect(link?.textContent).toContain('Open in Devin');
    expect(link?.href).toBe(session.url);
    expect(card?.querySelector('.approval-actions')).toBeNull();
    expect(card?.textContent).not.toContain('Allow');
    expect(card?.textContent).not.toContain('Deny');
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
