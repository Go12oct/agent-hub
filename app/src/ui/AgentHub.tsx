import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity, ArrowLeft, ArrowUpRight, Bot, Check, ChevronRight, CircleHelp, Clock3, Code2, Command,
  GitBranch, LoaderCircle, LockKeyhole, QrCode, RefreshCw, Search, Settings2, Smartphone, Sparkles,
  Terminal, Wifi, WifiOff, X,
} from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { agentLabels, type AgentKind, type AgentSession, type SessionMessage, sessionOrder } from '@agent-hub/shared';
import { feedGroups, parsePairingLink, type PairingDetails } from '../pairing';

const agentColors: Record<AgentKind, string> = {
  devin: 'violet',
  codex: 'green',
  'codex-cloud': 'sky',
  'claude-code': 'orange',
  antigravity: 'pink',
};
const agentIcons: Record<AgentKind, string> = {
  devin: 'D',
  codex: 'C',
  'codex-cloud': 'C',
  'claude-code': '✳',
  antigravity: '✦',
};

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

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function StatusDot({ status }: { status: AgentSession['status'] }) {
  return <span className={`status-dot ${status}`} />;
}

export function AgentHub() {
  const [pairing, setPairing] = useState<PairingDetails>();
  const [ready, setReady] = useState(false);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const [selectedAgent, setSelectedAgent] = useState<AgentKind | 'all'>('all');
  const [selectedSession, setSelectedSession] = useState<AgentSession>();
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [pairInput, setPairInput] = useState('');
  const [setupError, setSetupError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const previousStatuses = useRef(new Map<string, AgentSession['status']>());
  const pullStart = useRef(0);

  useEffect(() => { void loadPairing().then((value) => { setPairing(value); setReady(true); }); }, []);

  const refresh = useCallback(async () => {
    if (!pairing) return;
    setRefreshing(true);
    try {
      const response = await fetch(`${pairing.url}/api/sessions`, { headers: { Authorization: `Bearer ${pairing.token}` } });
      if (!response.ok) throw new Error('Could not reach Agent Hub');
      setSessions(await response.json() as AgentSession[]);
      setConnection('connected');
    } catch {
      setConnection('offline');
    } finally {
      setRefreshing(false);
    }
  }, [pairing]);

  useEffect(() => {
    if (!pairing) return;
    let alive = true;
    let poll: ReturnType<typeof setInterval> | undefined;
    const source = new EventSource(`${pairing.url}/api/events?token=${encodeURIComponent(pairing.token)}`);
    source.addEventListener('snapshot', (event) => {
      if (alive) {
        const snapshot = JSON.parse((event as MessageEvent).data) as AgentSession[];
        snapshot.forEach((session) => previousStatuses.current.set(session.id, session.status));
        setSessions(snapshot);
        setConnection('connected');
      }
    });
    source.addEventListener('upsert', (event) => {
      if (!alive) return;
      const session = JSON.parse((event as MessageEvent).data) as AgentSession;
      setSessions((existing) => [session, ...existing.filter((item) => item.id !== session.id)]);
      const previous = previousStatuses.current.get(session.id);
      previousStatuses.current.set(session.id, session.status);
      if (Capacitor.isNativePlatform() && previous !== 'needs_input' && session.status === 'needs_input') {
        void import('@capacitor/local-notifications').then(async ({ LocalNotifications }) => {
          const permission = await LocalNotifications.checkPermissions();
          if (permission.display !== 'granted') await LocalNotifications.requestPermissions();
          await LocalNotifications.schedule({ notifications: [{ id: Math.floor(Math.random() * 2_000_000_000), title: `${agentLabels[session.agent]} needs you`, body: session.project || session.title }] });
        }).catch(() => {});
      }
    });
    source.addEventListener('remove', (event) => {
      if (!alive) return;
      const removed = JSON.parse((event as MessageEvent).data) as { id: string };
      setSessions((existing) => existing.filter((item) => item.id !== removed.id));
    });
    source.onopen = () => { setConnection('connected'); void refresh(); };
    source.onerror = () => { setConnection('offline'); };
    poll = setInterval(() => void refresh(), 15_000);
    void refresh();
    return () => { alive = false; source.close(); if (poll) clearInterval(poll); };
  }, [pairing, refresh]);

  useEffect(() => {
    if (!pairing || !selectedSession) return;
    let active = true;
    fetch(`${pairing.url}/api/sessions/${encodeURIComponent(selectedSession.id)}/messages?limit=30`, {
      headers: { Authorization: `Bearer ${pairing.token}` },
    }).then((response) => response.ok ? response.json() : []).then((items: SessionMessage[]) => {
      if (active) setMessages(items);
    }).catch(() => { if (active) setMessages([]); });
    return () => { active = false; };
  }, [pairing, selectedSession]);

  const filtered = useMemo(() => sessions.filter((session) =>
    (selectedAgent === 'all' || session.agent === selectedAgent) &&
    (!search || `${session.title} ${session.project || ''} ${session.lastMessage || ''}`.toLowerCase().includes(search.toLowerCase())),
  ).sort(sessionOrder), [sessions, selectedAgent, search]);
  const groups = feedGroups(filtered);

  async function connect(pairingLink = pairInput) {
    setSetupError('');
    const pair = parsePairingLink(pairingLink) || (urlInput.trim() && tokenInput.trim() ? parsePairingLink(`${urlInput.trim()}?token=${encodeURIComponent(tokenInput.trim())}`) : undefined);
    if (!pair) { setSetupError('Enter a valid pairing link, hub URL, and token.'); return; }
    setConnecting(true);
    try {
      const response = await fetch(`${pair.url}/health`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error();
      await savePairing(pair);
      setPairing(pair);
    } catch { setSetupError(`Can't reach ${pair.url} — same Wi-Fi? Windows Firewall?`); }
    finally { setConnecting(false); }
  }

  async function scanQr() {
    try {
      const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } = await import('@capacitor/barcode-scanner');
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: 'Scan the Agent Hub pairing QR code',
      });
      const value = result.ScanResult;
      if (value) {
        setPairInput(value);
        await connect(value);
      }
    } catch { setSetupError('QR scanning is unavailable. Paste the pairing link instead.'); }
  }

  async function disconnect() {
    if (Capacitor.isNativePlatform()) await Preferences.remove({ key: 'pairing' });
    else localStorage.removeItem('agent-hub-pairing');
    setPairing(undefined);
    setSelectedSession(undefined);
  }

  if (!ready) return <div className="loading-screen"><div className="brand-mark"><Activity size={24} /></div></div>;
  if (!pairing) return (
    <main className="setup-screen">
      <div className="setup-glow" />
      <div className="setup-wrap">
        <Brand />
        <div className="setup-card">
          <div className="setup-icon"><Smartphone size={22} /></div>
          <div className="eyebrow">ONE FEED. EVERY AGENT.</div>
          <h1>Your agents,<br /><span>in sync.</span></h1>
          <p className="setup-copy">Connect to the Agent Hub daemon running on your computer to see every coding session, live.</p>
          <label className="field-label">Pairing link</label>
          <div className="input-with-action">
            <input value={pairInput} onChange={(event) => setPairInput(event.target.value)} placeholder="agenthub://pair?url=…&token=…" />
            {Capacitor.isNativePlatform() && <button className="scan-button" onClick={() => void scanQr()} aria-label="Scan QR code" disabled={connecting}><QrCode size={18} /></button>}
          </div>
          <div className="field-divider"><span>OR ENTER MANUALLY</span></div>
          <label className="field-label">Hub address</label>
          <input value={urlInput} onChange={(event) => setUrlInput(event.target.value)} placeholder="http://192.168.1.42:4747" />
          <label className="field-label">Access token</label>
          <input value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="Paste token from agent-hub pair" />
          {setupError && <div className="error-note">{setupError}</div>}
          <button className="primary-button" onClick={() => void connect()} disabled={connecting}>
            {connecting ? <><LoaderCircle className="spin" size={17} /> Connecting…</> : <>Connect to Agent Hub <ChevronRight size={17} /></>}
          </button>
          <div className="secure-note"><LockKeyhole size={13} /> Your session data stays on your computer.</div>
        </div>
        <div className="setup-footer"><span><span className="live-pulse" /> LOCAL-FIRST · PRIVATE BY DESIGN</span><span>v1.0</span></div>
      </div>
    </main>
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <Brand compact />
        <div className="topbar-right">
          <button className={`connection-pill ${connection}`} onClick={() => void refresh()} title="Connection status">
            {connection === 'connected' ? <Wifi size={14} /> : connection === 'offline' ? <WifiOff size={14} /> : <LoaderCircle className="spin" size={14} />}
            <span>{connection === 'connected' ? 'Live' : connection === 'offline' ? 'Offline' : 'Connecting'}</span>
          </button>
          <button className="icon-button" aria-label="Search sessions" onClick={() => setSearchOpen((value) => !value)}><Search size={17} /></button>
          <button className="icon-button" aria-label="Settings" onClick={() => void disconnect()}><Settings2 size={17} /></button>
          <div className="avatar">AH</div>
        </div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <div className="workspace-label"><span className="workspace-symbol"><Command size={15} /></span><span>MY WORKSPACE</span><ChevronRight size={13} /></div>
          <button className="nav-item active"><Activity size={16} /><span>Live feed</span><span className="nav-count">{sessions.length}</span></button>
          <div className="side-divider" />
          <div className="sidebar-heading">AGENTS <span>{new Set(sessions.map((item) => item.agent)).size}</span></div>
          <button className={`agent-nav ${selectedAgent === 'all' ? 'selected' : ''}`} onClick={() => setSelectedAgent('all')}><span className="all-agent-icon"><Bot size={14} /></span><span>All agents</span><span className="agent-count">{sessions.length}</span></button>
          {(Object.keys(agentLabels) as AgentKind[]).map((agent) => (
            <button key={agent} className={`agent-nav ${selectedAgent === agent ? 'selected' : ''}`} onClick={() => setSelectedAgent(agent)}>
              <span className={`agent-mini ${agentColors[agent]}`}>{agentIcons[agent]}</span><span>{agentLabels[agent]}{agent === 'codex-cloud' && <span className="experimental">EXP</span>}</span>
              <span className="agent-count">{sessions.filter((item) => item.agent === agent).length}</span>
            </button>
          ))}
          <div className="sidebar-bottom">
            <div className="daemon-card"><div className="daemon-head"><span className="live-pulse" /><strong>Daemon online</strong><span className="daemon-menu">···</span></div><small>{pairing.url.replace(/^https?:\/\//, '')}</small><div className="daemon-foot"><span><span className="secure-dot" /> SECURE CONNECTION</span><span>15s sync</span></div></div>
            <div className="profile-row"><div className="avatar small">AH</div><span><strong>Agent Hub</strong><small>Personal workspace</small></span><CircleHelp size={16} /></div>
          </div>
        </aside>
        <section className="main-panel">
          {selectedSession ? (
            <SessionDetail session={selectedSession} messages={messages} onBack={() => setSelectedSession(undefined)} />
          ) : (
            <>
              <div className="page-heading">
                <div><div className="breadcrumb">WORKSPACE <ChevronRight size={12} /> LIVE FEED</div><h1>Live feed</h1><p>Every agent, every session. All in one place.</p></div>
                <button className={`refresh-button ${refreshing ? 'refreshing' : ''}`} onClick={() => void refresh()}><RefreshCw size={15} /> Refresh</button>
              </div>
              {searchOpen && <div className="search-box"><Search size={16} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search sessions, projects, messages…" /><button onClick={() => { setSearchOpen(false); setSearch(''); }}><X size={16} /></button></div>}
              <div className="stats-row">
                <Stat label="NEEDS YOU" value={groups.needsYou.length} tone="orange" icon={<Activity size={15} />} />
                <Stat label="WORKING NOW" value={groups.working.length} tone="green" icon={<Code2 size={15} />} />
                <Stat label="TOTAL SESSIONS" value={sessions.length} tone="blue" icon={<Terminal size={15} />} />
                <div className="updated-label"><span className="live-pulse" /> LIVE UPDATES <span>·</span> every 15 seconds</div>
              </div>
              <div className="filter-row">
                <div className="filter-label">FILTER BY AGENT</div>
                <div className="filter-chips">
                  <button className={`filter-chip ${selectedAgent === 'all' ? 'chosen' : ''}`} onClick={() => setSelectedAgent('all')}>All <span>{sessions.length}</span></button>
                  {(Object.keys(agentLabels) as AgentKind[]).map((agent) => <button key={agent} className={`filter-chip ${selectedAgent === agent ? 'chosen' : ''}`} onClick={() => setSelectedAgent(selectedAgent === agent ? 'all' : agent)}><i className={`chip-dot ${agentColors[agent]}`} />{agentLabels[agent]}<span>{sessions.filter((item) => item.agent === agent).length}</span></button>)}
                </div>
              </div>
              {filtered.length === 0 ? <EmptyFeed connection={connection} /> : (
                <div className="feed"
                  onTouchStart={(event) => { pullStart.current = event.touches[0]?.clientY || 0; }}
                  onTouchEnd={(event) => {
                    const pullDistance = (event.changedTouches[0]?.clientY || 0) - pullStart.current;
                    const scrollContainer = event.currentTarget.closest('.main-panel');
                    if ((scrollContainer?.scrollTop ?? window.scrollY) <= 0 && pullDistance > 70) void refresh();
                  }}>
                  {groups.needsYou.length > 0 && <FeedSection title="Needs you" caption="Waiting for your input" count={groups.needsYou.length} tint="orange" sessions={groups.needsYou} onSelect={setSelectedSession} />}
                  {groups.working.length > 0 && <FeedSection title="Working" caption="Agents are making progress" count={groups.working.length} tint="green" sessions={groups.working} onSelect={setSelectedSession} />}
                  {groups.recent.length > 0 && <FeedSection title="Recent" caption="Completed and idle sessions" count={groups.recent.length} tint="muted" sessions={groups.recent} onSelect={setSelectedSession} />}
                </div>
              )}
              <footer className="feed-footer"><span>AGENT HUB <span>·</span> PRIVATE SESSION FEED</span><button onClick={() => void disconnect()}><LockKeyhole size={12} /> Manage connection</button></footer>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'compact' : ''}`}><span className="brand-mark"><Activity size={compact ? 17 : 20} strokeWidth={2.5} /></span><span>agent<span className="brand-light">hub</span><sup>•</sup></span></div>;
}

function Stat({ label, value, tone, icon }: { label: string; value: number; tone: string; icon: ReactNode }) {
  return <div className={`stat-card ${tone}`}><div className="stat-icon">{icon}</div><div><div className="stat-label">{label}</div><div className="stat-value">{String(value).padStart(2, '0')}</div></div></div>;
}

function FeedSection({ title, caption, count, tint, sessions, onSelect }: { title: string; caption: string; count: number; tint: string; sessions: AgentSession[]; onSelect: (session: AgentSession) => void }) {
  return <section className={`feed-section ${tint}`}><div className="section-heading"><span className={`section-mark ${tint}`}>{tint === 'orange' ? <Activity size={15} /> : tint === 'green' ? <Code2 size={15} /> : <Clock3 size={15} />}</span><div><h2>{title} <span className="section-count">{count}</span></h2><p>{caption}</p></div><button className="section-more" aria-label={`More ${title}`}><span>···</span></button></div>
    <div className="session-list">{sessions.map((session) => <SessionCard key={session.id} session={session} onClick={() => onSelect(session)} />)}</div>
  </section>;
}

function SessionCard({ session, onClick }: { session: AgentSession; onClick: () => void }) {
  const color = agentColors[session.agent];
  return <button className={`session-card ${session.status}`} onClick={onClick}>
    <span className={`agent-icon ${color}`}>{agentIcons[session.agent]}{session.status === 'working' && <i />}</span>
    <span className="session-main"><span className="session-title-row"><strong>{session.title}</strong><span className={`status-label ${session.status}`}><StatusDot status={session.status} />{session.status.replace('_', ' ')}</span></span>
      <span className="session-subtitle"><span className={`text-agent ${color}`}>{agentLabels[session.agent]}</span>{session.project && <><span className="sub-separator">/</span><span>{session.project}</span></>}{session.branch && <span className="branch-tag"><GitBranch size={11} />{session.branch}</span>}</span>
      {session.lastMessage && <span className="last-message"><span className="message-prefix">↳</span> {session.lastMessage}</span>}
    </span>
    <span className="session-right"><span className="session-time">{relativeTime(session.updatedAt)}</span><ChevronRight size={16} /></span>
  </button>;
}

function EmptyFeed({ connection }: { connection: string }) {
  return <div className="empty-state"><div className="empty-orbit"><Sparkles size={23} /></div><h2>{connection === 'offline' ? 'Can’t reach your daemon' : 'Your feed is quiet'}</h2><p>{connection === 'offline' ? 'Check that Agent Hub is running and this device is on the same network.' : 'Start a coding session and it will show up here automatically.'}</p><div className="empty-agents">{(Object.keys(agentLabels) as AgentKind[]).map((agent) => <span key={agent} className={`agent-mini ${agentColors[agent]}`}>{agentIcons[agent]}</span>)}</div></div>;
}

function SessionDetail({ session, messages, onBack }: { session: AgentSession; messages: SessionMessage[]; onBack: () => void }) {
  return <div className="detail-view"><button className="back-button" onClick={onBack}><ArrowLeft size={15} /> Back to feed</button><div className="detail-header"><span className={`agent-icon large ${agentColors[session.agent]}`}>{agentIcons[session.agent]}</span><div><div className="breadcrumb">{agentLabels[session.agent].toUpperCase()} SESSION</div><h1>{session.title}</h1><p>{session.project || session.cwd || 'Local session'} · {relativeTime(session.updatedAt)}</p></div>{session.url && <a href={session.url} target="_blank" rel="noreferrer" className="open-agent">Open in Devin <ArrowUpRight size={14} /></a>}</div><div className="detail-meta"><span className={`status-label ${session.status}`}><StatusDot status={session.status} />{session.status.replace('_', ' ')}</span>{session.branch && <span className="branch-tag"><GitBranch size={12} />{session.branch}</span>}<span className="machine-label"><Bot size={13} />{session.machine}</span></div><div className="transcript"><div className="transcript-heading">RECENT ACTIVITY <span>LAST {messages.length} MESSAGES</span></div>{messages.length ? messages.map((item, index) => <div key={`${item.at}-${index}`} className={`message-row ${item.role}`}><div className="message-avatar">{item.role === 'user' ? 'YOU' : item.role === 'tool' ? '⌘' : agentIcons[session.agent]}</div><div className="message-content"><div className="message-meta"><strong>{item.role === 'user' ? 'You' : item.role === 'tool' ? 'Tool' : agentLabels[session.agent]}</strong>{item.at && <span>{relativeTime(item.at)}</span>}</div><p>{item.text}</p></div></div>) : <div className="transcript-empty">No transcript messages are available for this session.</div>}</div></div>;
}
