import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  AnimatePresence, LayoutGroup, animate, motion, useMotionValue, useTransform,
} from 'motion/react';
import {
  ArrowLeft, ArrowUp, Check, ShieldAlert, ChevronDown, ChevronRight, ExternalLink, LoaderCircle, LogOut, QrCode,
  Search, Settings, TerminalSquare, Wifi, WifiOff, X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { agentLabels, type AgentKind, type AgentSession, type PendingApproval, type SessionMessage, sessionOrder } from '@agent-hub/shared';
import { liveNotificationIds, localNotificationId } from '../local-notifications';
import { activityBuckets, approvalQueue, formatElapsed, type QueueItem } from '../home';
import {
  candidateUrls, feedGroups, mergeKnownUrls, newNonce, parsePairingLink, previewText, verifyHubProof,
  type PairingDetails,
} from '../pairing';

const agentOrder: AgentKind[] = ['devin', 'codex', 'claude-code', 'antigravity', 'codex-cloud'];
const agentMarks: Record<AgentKind, string> = {
  devin: 'DV', codex: 'CX', 'codex-cloud': 'XC', 'claude-code': 'CL', antigravity: 'AG',
};
const statusLabels: Record<AgentSession['status'], string> = {
  needs_input: 'Needs you', working: 'Working', done: 'Done', idle: 'Idle', error: 'Error',
};

export function statusLabel(session: AgentSession): string {
  if (session.agent === 'devin' && session.status === 'needs_input') {
    const approvals = session.approvals ?? (session.approval ? [session.approval] : []);
    if (!approvals.length) return 'Waiting on you';
  }
  return statusLabels[session.status];
}

type NativeViewTransition = { finished: Promise<void> };
type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => NativeViewTransition;
};

function withViewTransition(update: () => void): NativeViewTransition | undefined {
  const transitionDocument = document as ViewTransitionDocument;
  if (transitionDocument.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return transitionDocument.startViewTransition.call(document, () => flushSync(update));
  }
  update();
}

function sharedTransitionName(prefix: 'av' | 'title', sessionId: string): string {
  return `${prefix}-${CSS.escape(sessionId)}`;
}

async function loadPairing(): Promise<PairingDetails | undefined> {
  const native = Capacitor.isNativePlatform();
  let saved: PairingDetails | undefined;
  try {
    const raw = native ? (await Preferences.get({ key: 'pairing' })).value : localStorage.getItem('agent-hub-pairing');
    if (raw) saved = JSON.parse(raw) as PairingDetails;
  } catch { /* Invalid stored state falls back to setup. */ }
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (!native && token) {
    const pairing = { url: window.location.origin, token };
    await savePairing(pairing);
    params.delete('token');
    history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);
    return pairing;
  }
  return saved;
}

async function savePairing(pairing: PairingDetails): Promise<void> {
  const value = JSON.stringify(pairing);
  if (Capacitor.isNativePlatform()) await Preferences.set({ key: 'pairing', value });
  else localStorage.setItem('agent-hub-pairing', value);
}

async function reachable(url: string, token: string, timeout = 4000): Promise<boolean> {
  try {
    const nonce = newNonce();
    const response = await fetch(`${url}/health?nonce=${nonce}`, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return false;
    const data = await response.json() as { service?: unknown; proof?: unknown };
    return data.service === 'agent-hub' && await verifyHubProof(token, nonce, data.proof);
  } catch {
    return false;
  }
}

export function sessionIdFromLink(link?: string | null): string | undefined {
  if (!link) return undefined;
  const match = /^agenthub:\/\/session\/(.+)$/.exec(link.trim());
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]!); } catch { return undefined; }
}

function relativeTime(value?: string): string {
  if (!value) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (Number.isNaN(seconds)) return '';
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

async function sendDecision(
  pairing: PairingDetails,
  sessionId: string,
  approvalId: string,
  decision: 'allow' | 'deny',
  answers?: Record<string, string>,
): Promise<string | undefined> {
  try {
    const response = await fetch(`${pairing.url}/api/sessions/${encodeURIComponent(sessionId)}/approval`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairing.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, approvalId, ...(answers ? { answers } : {}) }),
    });
    if (response.ok) return undefined;
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : 'Could not send your answer. Try again.';
  } catch {
    return 'Could not reach your PC. Try again.';
  }
}

export function AgentHub() {
  const [pairing, setPairing] = useState<PairingDetails>();
  const [pairLink, setPairLink] = useState<string>();
  const [ready, setReady] = useState(false);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const [selectedAgent, setSelectedAgent] = useState<AgentKind | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string>();
  const [transitionSessionId, setTransitionSessionId] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [hiddenApprovalIds, setHiddenApprovalIds] = useState<Set<string>>(new Set());
  const [decisionErrors, setDecisionErrors] = useState<Record<string, string>>({});
  const [finishedOpen, setFinishedOpen] = useState(false);
  const pairingRef = useRef<PairingDetails | undefined>(undefined);
  const failingOver = useRef(false);
  const previousStatuses = useRef(new Map<string, AgentSession['status']>());
  const previousApprovals = useRef(new Map<string, Set<string>>());
  pairingRef.current = pairing;

  useEffect(() => { void loadPairing().then((value) => { setPairing(value); setReady(true); }); }, []);

  const url = pairing?.url;
  const token = pairing?.token;

  const clearLocalNotifications = useCallback(async (ids: number[]) => {
    if (!Capacitor.isNativePlatform()) return;
    const notifications = [...new Set(ids)].map((id) => ({ id }));
    if (!notifications.length) return;
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      await Promise.allSettled([
        Promise.resolve().then(() => LocalNotifications.cancel({ notifications })),
        Promise.resolve().then(() => LocalNotifications.removeDeliveredNotifications({
          notifications: notifications.map(({ id }) => ({ id, title: '', body: '' })),
        })),
      ]);
    } catch {}
  }, []);

  const syncDeliveredNotifications = useCallback(async (sessions: AgentSession[]) => {
    if (!Capacitor.isNativePlatform()) return;
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const { notifications } = await LocalNotifications.getDeliveredNotifications();
      const liveIds = liveNotificationIds(sessions);
      await clearLocalNotifications(notifications
        .filter(({ id }) => !liveIds.has(id))
      .map(({ id }) => id));
    } catch {}
  }, [clearLocalNotifications]);

  const openSession = useCallback((sessionId: string, source?: HTMLElement) => {
    if (source) {
      source.querySelector<HTMLElement>('.avatar')?.style.setProperty('view-transition-name', sharedTransitionName('av', sessionId));
      source.querySelector<HTMLElement>('.deck-title, .tile-title, .row-title')?.style.setProperty('view-transition-name', sharedTransitionName('title', sessionId));
    }
    withViewTransition(() => setSelectedId(sessionId));
    void clearLocalNotifications([
      localNotificationId(`session:${sessionId}`),
      ...[...(previousApprovals.current.get(sessionId) ?? [])].map((id) => localNotificationId(`approval:${id}`)),
    ]);
  }, [clearLocalNotifications]);

  const failover = useCallback(async () => {
    const current = pairingRef.current;
    if (!current || failingOver.current) return;
    failingOver.current = true;
    try {
      for (const candidate of candidateUrls(current)) {
        if (await reachable(candidate, current.token)) {
          if (candidate !== current.url) {
            const next = { ...current, url: candidate };
            await savePairing(next);
            setPairing(next);
          }
          return;
        }
      }
    } finally {
      failingOver.current = false;
    }
  }, []);

  const learnUrls = useCallback(async () => {
    const current = pairingRef.current;
    if (!current) return;
    try {
      const response = await fetch(`${current.url}/api/pair`, { headers: { Authorization: `Bearer ${current.token}` } });
      if (!response.ok) return;
      const data = await response.json() as { urls?: unknown };
      const next = mergeKnownUrls(current, data.urls);
      if (JSON.stringify(next.urls) !== JSON.stringify(current.urls)) {
        pairingRef.current = next;
        await savePairing(next);
        setPairing(next);
      }
    } catch { /* Discovery is best effort. */ }
  }, []);

  const refresh = useCallback(async () => {
    if (!url || !token) return;
    try {
      const response = await fetch(`${url}/api/sessions`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('Could not reach Agent Hub');
      const fetchedSessions = await response.json() as AgentSession[];
      setSessions(fetchedSessions);
      setConnection('connected');
      void syncDeliveredNotifications(fetchedSessions);
    } catch {
      setConnection('offline');
      void failover();
    }
  }, [url, token, failover, syncDeliveredNotifications]);

  useEffect(() => {
    if (!url || !token) return;
    let alive = true;
    setConnection('connecting');
    const source = new EventSource(`${url}/api/events?token=${encodeURIComponent(token)}`);
    source.addEventListener('snapshot', (event) => {
      if (!alive) return;
      const snapshot = JSON.parse((event as MessageEvent).data) as AgentSession[];
      snapshot.forEach((session) => {
        previousStatuses.current.set(session.id, session.status);
        previousApprovals.current.set(session.id, new Set((session.approvals ?? (session.approval ? [session.approval] : [])).map((item) => item.id)));
      });
      setSessions(snapshot);
      setConnection('connected');
      void syncDeliveredNotifications(snapshot);
    });
    source.addEventListener('upsert', (event) => {
      if (!alive) return;
      const session = JSON.parse((event as MessageEvent).data) as AgentSession;
      setSessions((existing) => [session, ...existing.filter((item) => item.id !== session.id)]);
      const previous = previousStatuses.current.get(session.id);
      previousStatuses.current.set(session.id, session.status);
      const pendingApprovals = session.approvals ?? (session.approval ? [session.approval] : []);
      const seenApprovals = previousApprovals.current.get(session.id) ?? new Set<string>();
      const currentApprovals = new Set(pendingApprovals.map((item) => item.id));
      const removedApprovals = [...seenApprovals].filter((id) => !currentApprovals.has(id));
      previousApprovals.current.set(session.id, currentApprovals);
      const leftNeedsInput = previous === 'needs_input' && session.status !== 'needs_input';
      const notificationsToClear = [
        ...removedApprovals.map((id) => localNotificationId(`approval:${id}`)),
        ...(leftNeedsInput ? [localNotificationId(`session:${session.id}`)] : []),
      ];
      const freshApprovals = pendingApprovals.filter((item) => !seenApprovals.has(item.id));
      const alerts: Array<{ id: number; title: string; body: string }> = freshApprovals.map((item) => ({
        id: localNotificationId(`approval:${item.id}`),
        title: `${agentLabels[session.agent]} wants permission`, body: item.summary.slice(0, 160),
      }));
      if (!alerts.length && previous !== 'needs_input' && session.status === 'needs_input') {
        alerts.push({
          id: localNotificationId(`session:${session.id}`),
          title: session.agent === 'devin' ? 'Devin is waiting on you' : `${agentLabels[session.agent]} needs you`,
          body: session.lastMessage ? previewText(session.lastMessage).slice(0, 120) : session.title,
        });
      }
      if (Capacitor.isNativePlatform() && (notificationsToClear.length || alerts.length)) {
        void (async () => {
          await clearLocalNotifications(notificationsToClear);
          if (!alerts.length) return;
          const { LocalNotifications } = await import('@capacitor/local-notifications');
          const permission = await LocalNotifications.checkPermissions();
          if (permission.display !== 'granted') await LocalNotifications.requestPermissions();
          await LocalNotifications.schedule({
            notifications: alerts.map((alert) => ({ ...alert, extra: { sessionId: session.id } })),
          });
        })().catch(() => {});
      }
    });
    source.addEventListener('remove', (event) => {
      if (!alive) return;
      const removed = JSON.parse((event as MessageEvent).data) as { id: string };
      setSessions((existing) => existing.filter((item) => item.id !== removed.id));
      const approvalIds = previousApprovals.current.get(removed.id) ?? new Set<string>();
      previousApprovals.current.delete(removed.id);
      previousStatuses.current.delete(removed.id);
      void clearLocalNotifications([
        localNotificationId(`session:${removed.id}`),
        ...[...approvalIds].map((id) => localNotificationId(`approval:${id}`)),
      ]);
    });
    source.onopen = () => { setConnection('connected'); void refresh(); void learnUrls(); };
    source.onerror = () => { setConnection('offline'); void failover(); };
    const poll = setInterval(() => void refresh(), 15_000);
    void refresh();
    return () => { alive = false; source.close(); clearInterval(poll); };
  }, [url, token, refresh, failover, learnUrls, clearLocalNotifications, syncDeliveredNotifications]);

  const backState = useRef({ selectedId, settingsOpen, searchOpen });
  backState.current = { selectedId, settingsOpen, searchOpen };
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let remove: (() => void) | undefined;
    void import('@capacitor/app').then(async ({ App }) => {
      const openLink = (link?: string | null) => {
        if (link && parsePairingLink(link)) { setPairLink(link); return; }
        const id = sessionIdFromLink(link);
        if (id) { setSettingsOpen(false); setSearchOpen(false); openSession(id); }
      };
      void App.getLaunchUrl().then((launch) => openLink(launch?.url)).catch(() => {});
      const urlHandle = await App.addListener('appUrlOpen', (event) => openLink(event.url));
      const handle = await App.addListener('backButton', () => {
        const state = backState.current;
        if (state.selectedId) setSelectedId(undefined);
        else if (state.settingsOpen) setSettingsOpen(false);
        else if (state.searchOpen) { setSearchOpen(false); setSearch(''); }
        else void App.minimizeApp();
      });
      remove = () => { void handle.remove(); void urlHandle.remove(); };
    }).catch(() => {});
    return () => remove?.();
  }, [openSession]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let remove: (() => void) | undefined;
    void import('@capacitor/app').then(async ({ App }) => {
      const handle = await App.addListener('resume', () => { void refresh(); });
      remove = () => { void handle.remove(); };
    }).catch(() => {});
    return () => remove?.();
  }, [refresh]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let remove: (() => void) | undefined;
    void import('@capacitor/local-notifications').then(async ({ LocalNotifications }) => {
      const handle = await LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
        const id = (action.notification.extra as { sessionId?: unknown } | undefined)?.sessionId;
        if (typeof id === 'string' && id) { setSettingsOpen(false); setSearchOpen(false); setSearch(''); openSession(id); }
      });
      remove = () => { void handle.remove(); };
    }).catch(() => {});
    return () => remove?.();
  }, [openSession]);

  const filtered = useMemo(() => sessions.filter((session) =>
    (selectedAgent === 'all' || session.agent === selectedAgent) &&
    (!search || `${session.title} ${session.project || ''} ${session.lastMessage || ''}`.toLowerCase().includes(search.toLowerCase())),
  ).sort(sessionOrder), [sessions, selectedAgent, search]);
  const groups = feedGroups(filtered);
  const queue = useMemo(() => approvalQueue(filtered, hiddenApprovalIds), [filtered, hiddenApprovalIds]);
  const activeTiles = useMemo(() => filtered
    .filter((session) => session.status === 'needs_input' || session.status === 'working')
    .sort((a, b) => (a.status === b.status ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt) : a.status === 'needs_input' ? -1 : 1)), [filtered]);
  const workingCount = filtered.filter((session) => session.status === 'working').length;
  const activity = useActivity(activeTiles, pairing);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!activeTiles.some((session) => session.status === 'working' && session.startedAt)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeTiles]);
  useEffect(() => {
    const currentApprovalIds = new Set(sessions.flatMap((session) =>
      (session.approvals ?? (session.approval ? [session.approval] : [])).map((approval) => approval.id),
    ));
    setHiddenApprovalIds((current) => {
      const next = new Set([...current].filter((id) => currentApprovalIds.has(id)));
      return next.size === current.size ? current : next;
    });
    setDecisionErrors((current) => Object.fromEntries(Object.entries(current).filter(([id]) => currentApprovalIds.has(id))));
  }, [sessions]);
  const selectedSession = sessions.find((session) => session.id === selectedId);
  const counts = useMemo(() => {
    const map = new Map<AgentKind, number>();
    sessions.forEach((session) => map.set(session.agent, (map.get(session.agent) || 0) + 1));
    return map;
  }, [sessions]);
  const tabs = agentOrder.filter((agent) => agent !== 'codex-cloud' || counts.has(agent));

  useEffect(() => {
    const screen = document.querySelector<HTMLElement>('.screen');
    const background = screen ? getComputedStyle(screen).getPropertyValue('--screen-bg').trim() : '';
    document.body.style.backgroundColor = background;
    document.documentElement.style.backgroundColor = background;
  }, [pairLink, pairing, ready, selectedAgent, selectedId, selectedSession]);

  useEffect(() => () => {
    document.body.style.backgroundColor = '';
    document.documentElement.style.backgroundColor = '';
  }, []);

  async function disconnect() {
    if (Capacitor.isNativePlatform()) await Preferences.remove({ key: 'pairing' });
    else localStorage.removeItem('agent-hub-pairing');
    setPairing(undefined);
    setSelectedId(undefined);
    setSettingsOpen(false);
    setSessions([]);
  }

  if (!ready) return <div className="splash"><span className="logo">AH</span></div>;
  if (!pairing || pairLink) {
    return (
      <Setup
        link={pairLink}
        onPaired={(next) => { setPairLink(undefined); setPairing(next); }}
        onCancel={pairing ? () => setPairLink(undefined) : undefined}
      />
    );
  }

  if (selectedSession) {
    return (
      <ChatView
        key={selectedSession.id}
        session={selectedSession}
        pairing={pairing}
        onBack={() => {
          const transition = withViewTransition(() => {
            setTransitionSessionId(selectedSession.id);
            setSelectedId(undefined);
          });
          if (transition) {
            void transition.finished.then(
              () => setTransitionSessionId(undefined),
              () => setTransitionSessionId(undefined),
            );
          } else {
            setTransitionSessionId(undefined);
          }
        }}
      />
    );
  }

  async function decide(item: QueueItem, decision: 'allow' | 'deny') {
    if (item.kind !== 'approval' || !pairing) return;
    const { session, approval } = item;
    setHiddenApprovalIds((current) => new Set(current).add(approval.id));
    setDecisionErrors((current) => {
      const next = { ...current };
      delete next[approval.id];
      return next;
    });
    const error = await sendDecision(pairing, session.id, approval.id, decision);
    if (error) {
      setHiddenApprovalIds((current) => {
        const next = new Set(current);
        next.delete(approval.id);
        return next;
      });
      setDecisionErrors((current) => ({ ...current, [approval.id]: error }));
    }
  }

  return (
    <main className="screen" data-agent={selectedAgent}>
      <header className="app-bar">
        {searchOpen ? (
          <div className="search-field">
            <Search size={18} />
            <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search chats" />
            <button className="icon-btn" aria-label="Close search" onClick={() => { setSearchOpen(false); setSearch(''); }}><X size={20} /></button>
          </div>
        ) : (
          <>
            <div className="app-title">
              <span className="eyebrow">
                <button className={`conn ${connection}`} onClick={() => void refresh()}>
                  {connection === 'connected' ? <Wifi size={12} /> : connection === 'offline' ? <WifiOff size={12} /> : <LoaderCircle className="spin" size={12} />}
                  {connection === 'connected' ? 'Live from your PC' : connection === 'offline' ? 'PC offline' : 'Connecting'}
                </button>
              </span>
              <h1>{queue.length ? <><em>{queue.length}</em> need{queue.length === 1 ? 's' : ''} you</> : 'All clear'}</h1>
              <p className="app-sub">{queue.length
                ? 'Swipe right to allow, left to deny'
                : workingCount ? `${workingCount} agent${workingCount === 1 ? '' : 's'} working` : 'Nothing running'}</p>
            </div>
            <button className="icon-btn glass" aria-label="Search" onClick={() => setSearchOpen(true)}><Search size={19} /></button>
            <button className="icon-btn glass" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings size={19} /></button>
          </>
        )}
      </header>

      <nav className="tabs" aria-label="Filter by app">
        <button className={selectedAgent === 'all' ? 'tab active' : 'tab'} onClick={() => setSelectedAgent('all')}>All <span>{sessions.length}</span></button>
        {tabs.map((agent) => (
          <button key={agent} className={selectedAgent === agent ? `tab active ${agent}` : `tab ${agent}`} onClick={() => setSelectedAgent(agent)}>
            {agentLabels[agent]} <span>{counts.get(agent) || 0}</span>
          </button>
        ))}
      </nav>

      <div className="list">
        {filtered.length === 0 ? <Empty connection={connection} agent={selectedAgent} /> : (
          <>
            <ApprovalDeck items={queue} errors={decisionErrors} onOpen={openSession} onDecide={(item, value) => void decide(item, value)} />
            <div className="section-head"><span>Agents</span><span>{workingCount} working</span></div>
            <LayoutGroup>
              <div className="agent-tiles">
                <AnimatePresence initial={false}>
                  {activeTiles.map((session) => (
                    <AgentTile
                      key={session.id}
                      session={session}
                      messages={activity.get(session.id) ?? []}
                      now={now}
                      transitionSessionId={transitionSessionId}
                      onOpen={(source) => openSession(session.id, source)}
                    />
                  ))}
                </AnimatePresence>
              </div>
            </LayoutGroup>
            {groups.recent.length > 0 && (
              <>
                <button className="finished-toggle" onClick={() => setFinishedOpen((value) => !value)}>
                  <span>{groups.recent.length} finished or idle</span><span>{search || finishedOpen ? 'Hide' : 'Show'}</span>
                </button>
                {(search || finishedOpen) && dayGroups(groups.recent).map(([title, items]) => (
                  <Group key={title} title={title} sessions={items} transitionSessionId={transitionSessionId} onOpen={openSession} />
                ))}
              </>
            )}
          </>
        )}
      </div>

      {settingsOpen && (
        <div className="sheet-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="sheet" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-handle" />
            <h2>Connection</h2>
            <div className="setting-row"><span>Status</span><strong className={`conn-text ${connection}`}>{connection === 'connected' ? 'Connected' : connection === 'offline' ? 'Offline' : 'Connecting'}</strong></div>
            <div className="setting-row"><span>Using</span><strong>{pairing.url.replace(/^https?:\/\//, '')}</strong></div>
            <div className="setting-note">
              {candidateUrls(pairingRef.current || pairing).some((item) => /\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(item))
                ? 'Tailscale is set up, so this also works away from home.'
                : 'Away from home: install Tailscale on this phone and your PC, sign in to the same account, then open this app once at home.'}
            </div>
            <button className="sheet-btn danger" onClick={() => void disconnect()}><LogOut size={18} /> Disconnect this phone</button>
            <button className="sheet-btn" onClick={() => setSettingsOpen(false)}>Close</button>
            <div className="version-note">Agent Hub v{__APP_VERSION__}</div>
          </div>
        </div>
      )}
    </main>
  );
}

function queueItemKey(item: QueueItem): string {
  return item.kind === 'approval' ? `approval:${item.approval.id}` : `input:${item.session.id}`;
}

function ApprovalDeck({
  items,
  errors,
  onOpen,
  onDecide,
}: {
  items: QueueItem[];
  errors: Record<string, string>;
  onOpen: (id: string, source?: HTMLElement) => void;
  onDecide: (item: QueueItem, decision: 'allow' | 'deny') => void;
}) {
  if (!items.length) {
    return <div className="deck-empty"><strong>Nothing needs you</strong><span>You'll get a ping when an agent asks.</span></div>;
  }

  return (
    <div className="approval-deck">
      {items.map((item, depth) => (
        <DeckCard
          key={queueItemKey(item)}
          item={item}
          depth={depth}
          error={item.kind === 'approval' ? errors[item.approval.id] : undefined}
          onOpen={(source) => onOpen(item.session.id, source)}
          onDecide={(decision) => onDecide(item, decision)}
        />
      ))}
    </div>
  );
}

function DeckCard({
  item,
  depth,
  error,
  onOpen,
  onDecide,
}: {
  item: QueueItem;
  depth: number;
  error?: string;
  onOpen: (source: HTMLElement) => void;
  onDecide: (decision: 'allow' | 'deny') => void;
}) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-240, 0, 240], [-10, 0, 10]);
  const allowOpacity = useTransform(x, [0, 100], [0, 1]);
  const denyOpacity = useTransform(x, [-100, 0], [1, 0]);
  const committing = useRef(false);
  const approval = item.kind === 'approval' ? item.approval : undefined;
  const questions = approval?.questions ?? [];
  const swipeable = Boolean(approval && questions.length === 0 && depth === 0);
  const preview = item.kind === 'input' && item.session.lastMessage ? previewText(item.session.lastMessage) : '';
  const depthIndex = Math.min(depth, 3);
  const y = [0, 12, 24, 24][depthIndex]!;
  const scale = [1, 0.95, 0.9, 0.9][depthIndex]!;

  async function flyOut(decision: 'allow' | 'deny', velocity = 0) {
    if (!swipeable || item.kind !== 'approval' || committing.current) return;
    committing.current = true;
    const direction = decision === 'allow' ? 1 : -1;
    await animate(x, direction * (window.innerWidth + 160), {
      type: 'spring',
      stiffness: 300,
      damping: 32,
      velocity,
    });
    onDecide(decision);
  }

  function endDrag(info: { offset: { x: number }; velocity: { x: number } }) {
    const offsetDirection = Math.sign(info.offset.x);
    const velocityDirection = Math.sign(info.velocity.x);
    const offsetCommits = Math.abs(info.offset.x) > 100;
    const velocityCommits = Math.abs(info.velocity.x) > 600 && (!offsetDirection || velocityDirection === offsetDirection);
    if (offsetCommits || velocityCommits) {
      const direction = offsetCommits ? offsetDirection : velocityDirection;
      const velocity = velocityDirection === direction ? info.velocity.x : 0;
      void flyOut(direction > 0 ? 'allow' : 'deny', velocity);
      return;
    }
    void animate(x, 0, { type: 'spring', stiffness: 500, damping: 34 });
  }

  return (
    <motion.div
      className="deck-card needs_input"
      data-depth={depthIndex}
      drag={swipeable ? 'x' : false}
      dragElastic={0.9}
      dragMomentum={false}
      initial={error ? { scale: 0.96, opacity: 0 } : false}
      animate={{ y, scale, opacity: depthIndex >= 3 ? 0 : 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 36 }}
      style={{ x, rotate, zIndex: 10 - depth }}
      onPointerDownCapture={(event) => {
        if (event.target instanceof Element && event.target.closest('button')) event.stopPropagation();
      }}
      onDragEnd={(_, info) => endDrag(info)}
    >
      <motion.span className="deck-stamp allow-stamp" style={{ opacity: allowOpacity }}>ALLOW</motion.span>
      <motion.span className="deck-stamp deny-stamp" style={{ opacity: denyOpacity }}>DENY</motion.span>
      <div className="deck-who">
        <Avatar agent={item.session.agent} />
        <span><strong className={`agent-name ${item.session.agent}`}>{agentLabels[item.session.agent]}</strong><span>{item.session.project}</span></span>
        <time>{relativeTime(approval?.requestedAt ?? item.session.updatedAt)}</time>
      </div>
      <h2 className="deck-title">{item.session.title}</h2>
      {item.kind === 'input' && (
        <span className={`status ${item.session.status}`}>{statusLabel(item.session)}</span>
      )}
      {approval ? (
        questions.length > 0
          ? <p className="deck-question">{questions[0]?.question}</p>
          : (
            <div className="deck-tool">
              <div className="deck-summary">{approval.summary}</div>
              {approval.detail && <div className="deck-detail">{approval.detail}</div>}
            </div>
          )
      ) : <p className="deck-input">{preview}</p>}
      {error && <div className="alert small">{error}</div>}
      {approval && questions.length === 0 ? (
        <>
          <div className="deck-actions">
            <button className="deck-deny" onClick={() => void flyOut('deny')}>Deny</button>
            <button className="deck-allow" onClick={() => void flyOut('allow')}>Allow</button>
          </div>
          <button className="deck-open" onClick={(event) => {
            const source = event.currentTarget.closest<HTMLElement>('.deck-card');
            if (source) onOpen(source);
          }}>Open chat</button>
        </>
      ) : (
        <button className="deck-primary" onClick={(event) => {
          const source = event.currentTarget.closest<HTMLElement>('.deck-card');
          if (source) onOpen(source);
        }}>{approval ? 'Answer' : 'Reply'}</button>
      )}
    </motion.div>
  );
}

function AgentTile({
  session,
  messages,
  now,
  transitionSessionId,
  onOpen,
}: {
  session: AgentSession;
  messages: SessionMessage[];
  now: number;
  transitionSessionId?: string;
  onOpen: (source: HTMLElement) => void;
}) {
  const shared = session.id === transitionSessionId;
  const needsInput = session.status === 'needs_input';
  const approval = (session.approvals ?? (session.approval ? [session.approval] : []))[0];
  const current = needsInput ? approval?.summary : session.lastMessage ? previewText(session.lastMessage) : '';
  const hasTimestamps = messages.some((message) => Boolean(message.at) && Number.isFinite(Date.parse(message.at!)));
  const buckets = activityBuckets(messages, now);
  const maxBucket = Math.max(1, ...buckets);
  const elapsedAt = session.startedAt ? Date.parse(session.startedAt) : undefined;
  const steps = messages.length >= 100 ? '100+' : messages.filter((message) => message.role === 'tool').length;

  return (
    <motion.button
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ type: 'spring', stiffness: 420, damping: 36 }}
      className={`agent-tile ${session.status}`}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <span className="tile-top">
        <Avatar agent={session.agent} viewTransitionName={shared ? sharedTransitionName('av', session.id) : undefined} />
        <span className="tile-agent"><strong className={`agent-name ${session.agent}`}>{agentLabels[session.agent]}</strong>{session.project && <> · {session.project}</>}</span>
        <span className={`status ${session.status}`}>
          {statusLabel(session)}
        </span>
      </span>
      <span className="tile-title" style={shared ? { viewTransitionName: sharedTransitionName('title', session.id) } : undefined}>{session.title}</span>
      {current && <span className="tile-current">{current}</span>}
      {hasTimestamps && (
        <span className="activity-track" aria-label="Recent activity">
          {buckets.map((count, index) => (
            <i
              key={index}
              className={needsInput && index === buckets.length - 1 ? 'ask' : count ? 'active' : ''}
              style={{ height: `${needsInput && index === buckets.length - 1 ? 100 : count ? 30 + (count / maxBucket) * 70 : 12}%` }}
            />
          ))}
        </span>
      )}
      <span className="tile-meta">
        {session.startedAt && <span>{formatElapsed(now - (Number.isFinite(elapsedAt) ? elapsedAt! : now))}</span>}
        <span>{steps} {steps === 1 ? 'step' : 'steps'}</span><span>now</span>
      </span>
    </motion.button>
  );
}

function useActivity(sessions: AgentSession[], pairing?: PairingDetails): Map<string, SessionMessage[]> {
  const [activity, setActivity] = useState<Map<string, SessionMessage[]>>(new Map());
  const sessionsRef = useRef(sessions);
  const activeIds = useRef(new Set<string>());
  const lastRequest = useRef(new Map<string, { at: number; updatedAt: string }>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = useRef(new Set<string>());
  sessionsRef.current = sessions;
  activeIds.current = new Set(sessions.map((session) => session.id));

  useEffect(() => {
    const ids = new Set(sessions.map((session) => session.id));
    setActivity((current) => new Map([...current].filter(([id]) => ids.has(id))));
    for (const [id, timer] of timers.current) {
      if (!ids.has(id)) {
        clearTimeout(timer);
        timers.current.delete(id);
      }
    }
    for (const id of lastRequest.current.keys()) {
      if (!ids.has(id)) lastRequest.current.delete(id);
    }
    if (!pairing) return;

    const fetchSession = (id: string) => {
      timers.current.delete(id);
      const session = sessionsRef.current.find((item) => item.id === id);
      if (!session || !activeIds.current.has(id) || !pairing) return;
      const previous = lastRequest.current.get(id);
      if (previous?.updatedAt === session.updatedAt) return;
      const delay = previous ? Math.max(0, 10_000 - (Date.now() - previous.at)) : 0;
      if (inFlight.current.has(id) || delay > 0) {
        timers.current.set(id, setTimeout(() => fetchSession(id), Math.max(delay, 250)));
        return;
      }
      lastRequest.current.set(id, { at: Date.now(), updatedAt: session.updatedAt });
      inFlight.current.add(id);
      void fetch(`${pairing.url}/api/sessions/${encodeURIComponent(id)}/messages?limit=100`, {
        headers: { Authorization: `Bearer ${pairing.token}` },
      }).then(async (response) => {
        if (!response.ok) throw new Error('Could not load activity');
        const messages = await response.json() as SessionMessage[];
        if (!activeIds.current.has(id) || sessionsRef.current.find((item) => item.id === id)?.updatedAt !== session.updatedAt) return;
        setActivity((current) => new Map(current).set(id, messages));
      }).catch(() => {}).finally(() => inFlight.current.delete(id));
    };

    sessions.forEach(({ id, updatedAt }) => {
      const previous = lastRequest.current.get(id);
      if (previous?.updatedAt === updatedAt || timers.current.has(id)) return;
      const delay = previous ? Math.max(0, 10_000 - (Date.now() - previous.at)) : 0;
      timers.current.set(id, setTimeout(() => fetchSession(id), delay));
    });
    return () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    };
  }, [sessions, pairing]);

  return activity;
}

function Setup({ link, onPaired, onCancel }: { link?: string; onPaired: (pairing: PairingDetails) => void; onCancel?: () => void }) {
  const [manual, setManual] = useState(false);
  const [pairInput, setPairInput] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    if (link) { setPairInput(link); void connect(link); }
  }, [link]);

  async function connect(link = pairInput) {
    setError('');
    const pair = parsePairingLink(link) || (urlInput.trim() && tokenInput.trim() ? parsePairingLink(`${urlInput.trim()}?token=${encodeURIComponent(tokenInput.trim())}`) : undefined);
    if (!pair) { setError('That pairing link is not valid.'); return; }
    setConnecting(true);
    try {
      let working: string | undefined;
      for (const candidate of candidateUrls(pair)) {
        if (await reachable(candidate, pair.token, 8000)) { working = candidate; break; }
      }
      if (!working) throw new Error();
      const next = { ...pair, url: working };
      await savePairing(next);
      onPaired(next);
    } catch {
      setError(`Can't reach ${pair.url}. Is the phone on the same Wi-Fi as the PC, and is Agent Hub running?`);
    } finally { setConnecting(false); }
  }

  async function scanQr() {
    setError('');
    try {
      const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } = await import('@capacitor/barcode-scanner');
      const result = await CapacitorBarcodeScanner.scanBarcode({ hint: CapacitorBarcodeScannerTypeHint.QR_CODE, scanInstructions: 'Scan the QR code shown on your PC' });
      if (result.ScanResult) { setPairInput(result.ScanResult); await connect(result.ScanResult); }
    } catch { setError('Could not open the camera. Paste the pairing link instead.'); setManual(true); }
  }

  return (
    <main className="setup">
      <div className="setup-hero">
        <span className="logo big">AH</span>
        <h1>Agent Hub</h1>
        <p>Your Devin, Codex, Claude Code and Antigravity chats in one place</p>
      </div>
      <div className="setup-actions">
        {Capacitor.isNativePlatform() && (
          <button className="primary" onClick={() => void scanQr()} disabled={connecting}>
            {connecting ? <><LoaderCircle className="spin" size={20} /> Connecting…</> : <><QrCode size={20} /> Scan QR code</>}
          </button>
        )}
        <p className="hint">On your PC, open <b>Agent Hub - Pair Phone</b> on the Desktop to show the QR code.</p>
        {error && <div className="alert">{error}</div>}
        {onCancel && <button type="button" className="secondary" onClick={onCancel} disabled={connecting}>Keep current PC</button>}
        <button className="link-btn" onClick={() => setManual((value) => !value)}>
          Enter details manually <ChevronDown size={16} className={manual ? 'flip' : ''} />
        </button>
        {manual && (
          <div className="manual">
            <input value={pairInput} onChange={(event) => setPairInput(event.target.value)} placeholder="agenthub://pair?url=…" />
            <div className="or">or</div>
            <input value={urlInput} onChange={(event) => setUrlInput(event.target.value)} placeholder="http://192.168.1.42:4747" inputMode="url" />
            <input value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="Access token" />
            <button className="secondary" onClick={() => void connect()} disabled={connecting}>{connecting ? 'Connecting…' : 'Connect'}</button>
          </div>
        )}
      </div>
    </main>
  );
}

function dayGroups(sessions: AgentSession[]): Array<[string, AgentSession[]]> {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const buckets: Array<[string, AgentSession[]]> = [['Today', []], ['Yesterday', []], ['This week', []], ['Earlier', []]];
  sessions.forEach((session) => {
    const at = Date.parse(session.updatedAt);
    const index = at >= today ? 0 : at >= today - 86_400_000 ? 1 : at >= today - 6 * 86_400_000 ? 2 : 3;
    buckets[index]![1].push(session);
  });
  return buckets.filter(([, items]) => items.length > 0);
}

function Avatar({
  agent,
  size = 'md',
  viewTransitionName,
}: {
  agent: AgentKind;
  size?: 'sm' | 'md';
  viewTransitionName?: string;
}) {
  return <span className={`avatar ${agent} ${size}`} style={viewTransitionName ? { viewTransitionName } : undefined} aria-hidden="true">{agentMarks[agent]}</span>;
}

function Group({
  title,
  tone,
  sessions,
  transitionSessionId,
  onOpen,
}: {
  title: string;
  tone?: string;
  sessions: AgentSession[];
  transitionSessionId?: string;
  onOpen: (id: string, source?: HTMLElement) => void;
}) {
  return (
    <section className={`group ${tone || ''}`}>
      <h2>{title} <span>{sessions.length}</span></h2>
      <LayoutGroup>
        <div className="cards">
          <AnimatePresence initial={false}>
            {sessions.map((session) => (
              <Row
                key={session.id}
                session={session}
                transitionSessionId={transitionSessionId}
                onOpen={(source) => onOpen(session.id, source)}
              />
            ))}
          </AnimatePresence>
        </div>
      </LayoutGroup>
    </section>
  );
}

function Row({
  session,
  transitionSessionId,
  onOpen,
}: {
  session: AgentSession;
  transitionSessionId?: string;
  onOpen: (source: HTMLElement) => void;
}) {
  const shared = session.id === transitionSessionId;
  const preview = session.lastMessage ? previewText(session.lastMessage) : '';
  const request = session.status === 'needs_input' ? (session.approvals ?? (session.approval ? [session.approval] : []))[0] : undefined;
  return (
    <motion.button
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ type: 'spring', stiffness: 420, damping: 36 }}
      className={`row ${session.status}`}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <Avatar agent={session.agent} viewTransitionName={shared ? sharedTransitionName('av', session.id) : undefined} />
      <span className="row-body">
        <span className="row-top">
          <span className={`agent-name ${session.agent}`}>{agentLabels[session.agent]}</span>
          <span className={`status ${session.status}`}>{statusLabel(session)}</span>
          <span className="row-time">{relativeTime(session.updatedAt)}</span>
        </span>
        <span className="row-title" style={shared ? { viewTransitionName: sharedTransitionName('title', session.id) } : undefined}>{session.title}</span>
        {request
          ? <span className="row-prompt">{request.summary}</span>
          : preview && <span className="row-preview">{session.lastRole === 'user' ? <b>You: </b> : ''}{preview}</span>}
        {(session.project || session.branch) && (
          <span className="row-meta">{[session.project, session.branch].filter(Boolean).join(' · ')}</span>
        )}
      </span>
    </motion.button>
  );
}

function Empty({ connection, agent }: { connection: string; agent: AgentKind | 'all' }) {
  if (connection === 'offline') return <div className="empty"><WifiOff size={30} /><h2>Can't reach your PC</h2><p>Make sure the PC is on and Agent Hub is running. Away from home, use Tailscale.</p></div>;
  if (agent === 'devin') return <div className="empty"><Avatar agent="devin" /><h2>No Devin sessions</h2><p>Add your Devin API key on the PC: <code>agent-hub config set devinApiKey &lt;key&gt;</code></p></div>;
  return <div className="empty"><h2>No chats yet</h2><p>Start a session in any agent and it shows up here.</p></div>;
}

interface ChatItem { kind: 'message'; message: SessionMessage; index: number }
interface ToolGroup { kind: 'tools'; messages: SessionMessage[]; index: number }

function groupMessages(messages: SessionMessage[]): Array<ChatItem | ToolGroup> {
  const output: Array<ChatItem | ToolGroup> = [];
  messages.forEach((message, index) => {
    if (!message.text.trim()) return;
    if (message.role === 'tool') {
      const last = output.at(-1);
      if (last?.kind === 'tools') last.messages.push(message);
      else output.push({ kind: 'tools', messages: [message], index });
    } else output.push({ kind: 'message', message, index });
  });
  return output;
}

export function ChatView({ session, pairing, onBack }: { session: AgentSession; pairing: PairingDetails; onBack: () => void }) {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sendError, setSendError] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const canReply = Boolean((session as AgentSession & { canReply?: boolean }).canReply);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${pairing.url}/api/sessions/${encodeURIComponent(session.id)}/messages?limit=100`, { headers: { Authorization: `Bearer ${pairing.token}` } });
      if (response.ok) setMessages(await response.json() as SessionMessage[]);
    } catch { /* Keep the last transcript while offline. */ } finally { setLoading(false); }
  }, [pairing.url, pairing.token, session.id]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load, session.updatedAt]);

  useEffect(() => { if (stick.current) bottom.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  useEffect(() => {
    const scrollToBottom = () => {
      if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
    };
    window.addEventListener('resize', scrollToBottom);
    window.visualViewport?.addEventListener('resize', scrollToBottom);
    return () => {
      window.removeEventListener('resize', scrollToBottom);
      window.visualViewport?.removeEventListener('resize', scrollToBottom);
    };
  }, []);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError('');
    const optimisticMessage = { role: 'user' as const, text, at: new Date().toISOString() };
    setMessages((existing) => [...existing, optimisticMessage]);
    stick.current = true;
    try {
      const response = await fetch(`${pairing.url}/api/sessions/${encodeURIComponent(session.id)}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pairing.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        setMessages((existing) => existing.filter((message) => message !== optimisticMessage));
        setSendError(typeof body.error === 'string' ? body.error : 'Message not sent. Try again.');
        return;
      }
      setDraft('');
      setTimeout(() => void load(), 2500);
    } catch {
      setMessages((existing) => existing.filter((message) => message !== optimisticMessage));
      setSendError('Message not sent. Try again.');
    } finally { setSending(false); }
  }

  async function stopReply() {
    if (stopping) return;
    setStopping(true);
    setSendError('');
    try {
      const response = await fetch(`${pairing.url}/api/sessions/${encodeURIComponent(session.id)}/reply/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pairing.token}` },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        setSendError(typeof body.error === 'string' ? body.error : 'Could not stop this reply. Try again.');
      }
    } catch {
      setSendError('Could not reach your PC. Try again.');
    } finally { setStopping(false); }
  }

  const items = groupMessages(messages);
  const openLabel = session.agent === 'devin' ? 'Open in Devin' : `Open in ${agentLabels[session.agent]}`;

  return (
    <main className="chat">
      <header className="chat-bar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}><ArrowLeft size={22} /></button>
        <Avatar agent={session.agent} viewTransitionName={sharedTransitionName('av', session.id)} />
        <div className="chat-heading">
          <strong style={{ viewTransitionName: sharedTransitionName('title', session.id) }}>{session.title}</strong>
          <span>
            <span className={`agent-name ${session.agent}`}>{agentLabels[session.agent]}</span>
            <span className={`dot ${session.status}`} />{statusLabel(session)}
            {session.project && <> · {session.project}</>}
          </span>
        </div>
        {session.url && <a className="icon-btn" href={session.url} target="_blank" rel="noreferrer" aria-label={openLabel}><ExternalLink size={20} /></a>}
      </header>

      <div className="messages" ref={scroller} onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}>
        {loading && !messages.length && <div className="chat-empty"><LoaderCircle className="spin" size={22} /></div>}
        {!loading && !items.length && <div className="chat-empty">No messages yet</div>}
        {items.map((item, position) => {
          if (item.kind === 'tools') return <ToolBlock key={`t-${item.index}`} messages={item.messages} />;
          if (item.message.role === 'user') return <div key={`m-${item.index}`} className="msg user"><div className="bubble"><Markdown text={item.message.text} /></div></div>;
          const previous = items[position - 1];
          const startsTurn = !previous || (previous.kind === 'message' && previous.message.role === 'user');
          return (
            <div key={`m-${item.index}`} className="msg assistant">
              {startsTurn && <div className="speaker"><Avatar agent={session.agent} size="sm" />{agentLabels[session.agent]}</div>}
              <div className="assistant-text"><Markdown text={item.message.text} /></div>
            </div>
          );
        })}
        {session.status === 'working' && <div className="thinking"><i className="dot working" /><span>{agentLabels[session.agent]} is working</span></div>}
        <div ref={bottom} />
      </div>

      {(session.approvals || (session.approval ? [session.approval] : [])).map((approval) => (
        <ApprovalCard key={approval.id} session={session} approval={approval} pairing={pairing} />
      ))}
      {canReply || session.replyRunning ? (
        <footer className="composer">
          {(sendError || (!sending && session.replyError)) && (
            <div className="alert small">{sendError || session.replyError}</div>
          )}
          {canReply && (
            <div className="composer-box">
              <textarea value={draft} rows={1} placeholder={`Message ${agentLabels[session.agent]}`}
                onChange={(event) => { setDraft(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 140)}px`; }} />
              <button className="send" aria-label="Send" disabled={!draft.trim() || sending} onClick={() => void send()}>
                {sending ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={20} />}
              </button>
            </div>
          )}
          {session.replyRunning && (
            <button className="secondary danger stop-reply" type="button" aria-label="Stop reply"
              disabled={stopping} onClick={() => void stopReply()}>
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </footer>
      ) : (
        <footer className="composer readonly">
          {session.url
            ? <a className="secondary" href={session.url} target="_blank" rel="noreferrer">{openLabel} <ExternalLink size={16} /></a>
            : <span>Reply to {agentLabels[session.agent]} on your PC. This view updates live.</span>}
        </footer>
      )}
    </main>
  );
}

function ApprovalCard({ session, approval, pairing }: { session: AgentSession; approval: PendingApproval; pairing: PairingDetails }) {
  const [busy, setBusy] = useState<'allow' | 'deny' | undefined>();
  const [error, setError] = useState('');
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const questions = approval.questions ?? [];
  const answersComplete = questions.every((question) => (answers[question.question]?.length ?? 0) > 0);
  useEffect(() => { setBusy(undefined); setError(''); setAnswers({}); }, [approval.id]);
  async function decide(decision: 'allow' | 'deny', answerMap?: Record<string, string>) {
    if (busy) return;
    setBusy(decision);
    setError('');
    const error = await sendDecision(pairing, session.id, approval.id, decision, answerMap);
    if (error) {
      setError(error);
      setBusy(undefined);
    }
  }
  return (
    <section className="approval" aria-live="polite">
      <div className="approval-head"><ShieldAlert size={18} /><span>{questions.length ? `${agentLabels[session.agent]} has a question` : `${agentLabels[session.agent]} wants permission`}</span></div>
      <code className="approval-summary">{approval.summary}</code>
      {approval.detail && <p className="approval-detail">{approval.detail}</p>}
      {questions.map((question) => (
        <div className="approval-question" key={question.question}>
          {question.header && <strong>{question.header}</strong>}
          <p>{question.question}</p>
          <div className="approval-options">
            {question.options.map((option) => {
              const selected = (answers[question.question] ?? []).includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  className={`secondary approval-option${selected ? ' selected' : ''}`}
                  aria-pressed={selected}
                  disabled={Boolean(busy)}
                  onClick={() => setAnswers((current) => {
                    const chosen = current[question.question] ?? [];
                    const next = question.multiSelect
                      ? chosen.includes(option.label) ? chosen.filter((label) => label !== option.label) : [...chosen, option.label]
                      : [option.label];
                    return { ...current, [question.question]: next };
                  })}
                >
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {error && <div className="alert small">{error}</div>}
      <div className="approval-actions">
        <button className="secondary deny" disabled={Boolean(busy)} onClick={() => void decide('deny')}>
          {busy === 'deny' ? <LoaderCircle className="spin" size={18} /> : <X size={18} />} Deny
        </button>
        <button className="primary allow" disabled={Boolean(busy) || (questions.length > 0 && !answersComplete)} onClick={() => {
          if (!questions.length) { void decide('allow'); return; }
          void decide('allow', Object.fromEntries(questions.map((question) => [
            question.question, (answers[question.question] ?? []).join(', '),
          ])));
        }}>
          {busy === 'allow' ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />} {questions.length ? 'Send answer' : 'Allow'}
        </button>
      </div>
    </section>
  );
}

function ToolBlock({ messages }: { messages: SessionMessage[] }) {
  const [open, setOpen] = useState(false);
  const first = previewText(messages[0]?.text || '').slice(0, 70);
  return (
    <div className="tool">
      <button className="tool-head" onClick={() => setOpen((value) => !value)}>
        <TerminalSquare size={15} />
        <span>{messages.length === 1 ? first || 'Ran a tool' : `Ran ${messages.length} tools`}</span>
        <ChevronRight size={15} className={open ? 'rot' : ''} />
      </button>
      {open && <div className="tool-steps">{messages.map((message, index) => <pre key={index}>{message.text.slice(0, 4000)}</pre>)}</div>}
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
    }}>{text}</ReactMarkdown>
  );
}
