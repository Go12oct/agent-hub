import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowUp, BellRing, ChevronDown, ChevronRight, ExternalLink, Folder, GitBranch, LoaderCircle, LogOut, QrCode,
  Search, Settings, Sparkles, TerminalSquare, Wifi, WifiOff, X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { agentLabels, type AgentKind, type AgentSession, type SessionMessage, sessionOrder } from '@agent-hub/shared';
import {
  candidateUrls, feedGroups, mergeKnownUrls, newNonce, parsePairingLink, previewText, verifyHubProof,
  type PairingDetails,
} from '../pairing';

const agentOrder: AgentKind[] = ['devin', 'codex', 'claude-code', 'antigravity', 'codex-cloud'];
const agentInitials: Record<AgentKind, string> = {
  devin: 'D', codex: 'C', 'codex-cloud': 'C', 'claude-code': '✳', antigravity: '✦',
};
const statusLabels: Record<AgentSession['status'], string> = {
  needs_input: 'Needs you', working: 'Working', done: 'Done', idle: 'Idle', error: 'Error',
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

function relativeTime(value?: string): string {
  if (!value) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (Number.isNaN(seconds)) return '';
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function AgentHub() {
  const [pairing, setPairing] = useState<PairingDetails>();
  const [ready, setReady] = useState(false);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const [selectedAgent, setSelectedAgent] = useState<AgentKind | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'needs_input' | 'working'>('all');
  const [selectedId, setSelectedId] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const pairingRef = useRef<PairingDetails | undefined>(undefined);
  const failingOver = useRef(false);
  const previousStatuses = useRef(new Map<string, AgentSession['status']>());
  pairingRef.current = pairing;

  useEffect(() => { void loadPairing().then((value) => { setPairing(value); setReady(true); }); }, []);

  const url = pairing?.url;
  const token = pairing?.token;

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
      setSessions(await response.json() as AgentSession[]);
      setConnection('connected');
    } catch {
      setConnection('offline');
      void failover();
    }
  }, [url, token, failover]);

  useEffect(() => {
    if (!url || !token) return;
    let alive = true;
    setConnection('connecting');
    const source = new EventSource(`${url}/api/events?token=${encodeURIComponent(token)}`);
    source.addEventListener('snapshot', (event) => {
      if (!alive) return;
      const snapshot = JSON.parse((event as MessageEvent).data) as AgentSession[];
      snapshot.forEach((session) => previousStatuses.current.set(session.id, session.status));
      setSessions(snapshot);
      setConnection('connected');
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
          await LocalNotifications.schedule({ notifications: [{ id: Math.floor(Math.random() * 2_000_000_000), title: `${agentLabels[session.agent]} needs you`, body: session.lastMessage ? previewText(session.lastMessage).slice(0, 120) : session.title }] });
        }).catch(() => {});
      }
    });
    source.addEventListener('remove', (event) => {
      if (!alive) return;
      const removed = JSON.parse((event as MessageEvent).data) as { id: string };
      setSessions((existing) => existing.filter((item) => item.id !== removed.id));
    });
    source.onopen = () => { setConnection('connected'); void refresh(); void learnUrls(); };
    source.onerror = () => { setConnection('offline'); void failover(); };
    const poll = setInterval(() => void refresh(), 15_000);
    void refresh();
    return () => { alive = false; source.close(); clearInterval(poll); };
  }, [url, token, refresh, failover, learnUrls]);

  const backState = useRef({ selectedId, settingsOpen, searchOpen });
  backState.current = { selectedId, settingsOpen, searchOpen };
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let remove: (() => void) | undefined;
    void import('@capacitor/app').then(async ({ App }) => {
      const handle = await App.addListener('backButton', () => {
        const state = backState.current;
        if (state.selectedId) setSelectedId(undefined);
        else if (state.settingsOpen) setSettingsOpen(false);
        else if (state.searchOpen) { setSearchOpen(false); setSearch(''); }
        else void App.minimizeApp();
      });
      remove = () => void handle.remove();
    }).catch(() => {});
    return () => remove?.();
  }, []);

  const filtered = useMemo(() => sessions.filter((session) =>
    (selectedAgent === 'all' || session.agent === selectedAgent) &&
    (statusFilter === 'all' || session.status === statusFilter) &&
    (!search || `${session.title} ${session.project || ''} ${session.lastMessage || ''}`.toLowerCase().includes(search.toLowerCase())),
  ).sort(sessionOrder), [sessions, selectedAgent, statusFilter, search]);
  const groups = feedGroups(filtered);
  const selectedSession = sessions.find((session) => session.id === selectedId);
  const counts = useMemo(() => {
    const map = new Map<AgentKind, number>();
    sessions.forEach((session) => map.set(session.agent, (map.get(session.agent) || 0) + 1));
    return map;
  }, [sessions]);
  const tabs = agentOrder.filter((agent) => agent !== 'codex-cloud' || counts.has(agent));

  async function disconnect() {
    if (Capacitor.isNativePlatform()) await Preferences.remove({ key: 'pairing' });
    else localStorage.removeItem('agent-hub-pairing');
    setPairing(undefined);
    setSelectedId(undefined);
    setSettingsOpen(false);
    setSessions([]);
  }

  if (!ready) return <div className="splash"><span className="logo">A</span></div>;
  if (!pairing) return <Setup onPaired={(next) => setPairing(next)} />;

  if (selectedSession) {
    return <ChatView key={selectedSession.id} session={selectedSession} pairing={pairing} onBack={() => setSelectedId(undefined)} />;
  }

  const scoped = selectedAgent === 'all' ? sessions : sessions.filter((session) => session.agent === selectedAgent);
  const needsCount = scoped.filter((session) => session.status === 'needs_input').length;
  const workingCount = scoped.filter((session) => session.status === 'working').length;

  const todayCount = scoped.filter((session) => Date.parse(session.updatedAt) >= new Date().setHours(0, 0, 0, 0)).length;
  const toggleStatus = (value: 'needs_input' | 'working') => setStatusFilter((current) => current === value ? 'all' : value);

  return (
    <main className="screen">
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
              <h1>Agents</h1>
            </div>
            <button className="icon-btn glass" aria-label="Search" onClick={() => { setStatusFilter('all'); setSearchOpen(true); }}><Search size={19} /></button>
            <button className="icon-btn glass" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings size={19} /></button>
          </>
        )}
      </header>

      {!search && (
        <section className="overview" aria-label="Overview">
          <button className={`stat needs_input${statusFilter === 'needs_input' ? ' active' : ''}`} onClick={() => toggleStatus('needs_input')}>
            <BellRing size={16} /><strong>{needsCount}</strong><span>Needs you</span>
          </button>
          <button className={`stat working${statusFilter === 'working' ? ' active' : ''}`} onClick={() => toggleStatus('working')}>
            <span className="pulse" /><strong>{workingCount}</strong><span>Working</span>
          </button>
          <div className="stat today"><Sparkles size={16} /><strong>{todayCount}</strong><span>Today</span></div>
        </section>
      )}

      <nav className="tabs" aria-label="Filter by app">
        <button className={selectedAgent === 'all' ? 'tab active' : 'tab'} onClick={() => setSelectedAgent('all')}>All <span>{sessions.length}</span></button>
        {tabs.map((agent) => (
          <button key={agent} className={selectedAgent === agent ? `tab active ${agent}` : `tab ${agent}`} onClick={() => setSelectedAgent(agent)}>
            <i className={`tab-dot ${agent}`} />{agentLabels[agent]} <span>{counts.get(agent) || 0}</span>
          </button>
        ))}
      </nav>

      <div className="list">
        {filtered.length === 0 ? (
          statusFilter !== 'all' && connection !== 'offline'
            ? <div className="empty"><h2>{statusFilter === 'needs_input' ? 'Nothing needs you' : 'No agent is working'}</h2><p>{statusFilter === 'needs_input' ? 'Approvals and questions from your agents show up here.' : 'Running sessions show up here live.'}</p></div>
            : <Empty connection={connection} agent={selectedAgent} />
        ) : (
          <>
            {groups.needsYou.length > 0 && <Group title="Needs you" tone="needs_input" sessions={groups.needsYou} onOpen={setSelectedId} />}
            {groups.working.length > 0 && <Group title="Working now" tone="working" sessions={groups.working} onOpen={setSelectedId} />}
            {dayGroups(groups.recent).map(([title, items]) => <Group key={title} title={title} sessions={items} onOpen={setSelectedId} />)}
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
          </div>
        </div>
      )}
    </main>
  );
}

function Setup({ onPaired }: { onPaired: (pairing: PairingDetails) => void }) {
  const [manual, setManual] = useState(false);
  const [pairInput, setPairInput] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);

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
        <span className="logo big">A</span>
        <h1>Agent Hub</h1>
        <p>All your Devin, Codex, Claude Code and Antigravity chats in one place.</p>
      </div>
      <div className="setup-actions">
        {Capacitor.isNativePlatform() && (
          <button className="primary" onClick={() => void scanQr()} disabled={connecting}>
            {connecting ? <><LoaderCircle className="spin" size={20} /> Connecting…</> : <><QrCode size={20} /> Scan QR code</>}
          </button>
        )}
        <p className="hint">On your PC, open <b>Agent Hub - Pair Phone</b> on the Desktop to show the QR code.</p>
        {error && <div className="error">{error}</div>}
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

function Avatar({ agent, status, size = 'md' }: { agent: AgentKind; status?: AgentSession['status']; size?: 'sm' | 'md' }) {
  return <span className={`avatar ${agent} ${size}`}>{agentInitials[agent]}{status && (status === 'working' || status === 'needs_input') && <i className={`badge ${status}`} />}</span>;
}

function Group({ title, tone, sessions, onOpen }: { title: string; tone?: string; sessions: AgentSession[]; onOpen: (id: string) => void }) {
  return (
    <section className={`group ${tone || ''}`}>
      <h2>{title} <span>{sessions.length}</span></h2>
      <div className="cards">
        {sessions.map((session) => <Row key={session.id} session={session} onOpen={() => onOpen(session.id)} />)}
      </div>
    </section>
  );
}

function Row({ session, onOpen }: { session: AgentSession; onOpen: () => void }) {
  const preview = session.lastMessage ? previewText(session.lastMessage) : '';
  return (
    <button className={`row ${session.status}`} onClick={onOpen}>
      <Avatar agent={session.agent} status={session.status} />
      <span className="row-body">
        <span className="row-top">
          <span className={`agent-name ${session.agent}`}>{agentLabels[session.agent]}</span>
          {(session.status === 'needs_input' || session.status === 'working' || session.status === 'error') && <span className={`status ${session.status}`}>{statusLabels[session.status]}</span>}
          <span className="row-time">{relativeTime(session.updatedAt)}</span>
        </span>
        <span className="row-title">{session.title}</span>
        {preview && <span className="row-preview">{session.lastRole === 'user' ? <b>You: </b> : ''}{preview}</span>}
        {(session.project || session.branch) && (
          <span className="row-meta">
            {session.project && <span className="chip"><Folder size={12} />{session.project}</span>}
            {session.branch && <span className="chip"><GitBranch size={12} />{session.branch}</span>}
          </span>
        )}
      </span>
    </button>
  );
}

function Empty({ connection, agent }: { connection: string; agent: AgentKind | 'all' }) {
  if (connection === 'offline') return <div className="empty"><WifiOff size={30} /><h2>Can't reach your PC</h2><p>Make sure the PC is on and Agent Hub is running. Away from home, use Tailscale.</p></div>;
  if (agent === 'devin') return <div className="empty"><span className="avatar devin">D</span><h2>No Devin sessions</h2><p>Add your Devin API key on the PC: <code>agent-hub config set devinApiKey &lt;key&gt;</code></p></div>;
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

function ChatView({ session, pairing, onBack }: { session: AgentSession; pairing: PairingDetails; onBack: () => void }) {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
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

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError('');
    setMessages((existing) => [...existing, { role: 'user', text, at: new Date().toISOString() }]);
    stick.current = true;
    try {
      const response = await fetch(`${pairing.url}/api/sessions/${encodeURIComponent(session.id)}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pairing.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        setSendError(typeof body.error === 'string' ? body.error : 'Message not sent. Try again.');
        return;
      }
      setDraft('');
      setTimeout(() => void load(), 2500);
    } catch {
      setSendError('Message not sent. Try again.');
    } finally { setSending(false); }
  }

  const items = groupMessages(messages);
  const openLabel = session.agent === 'devin' ? 'Open in Devin' : `Open in ${agentLabels[session.agent]}`;

  return (
    <main className="chat">
      <header className="chat-bar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}><ArrowLeft size={22} /></button>
        <div className="chat-heading">
          <strong>{session.title}</strong>
          <span>
            <span className={`agent-name ${session.agent}`}>{agentLabels[session.agent]}</span>
            <span className={`dot ${session.status}`} />{statusLabels[session.status]}
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
        {!loading && !items.length && <div className="chat-empty">No messages in this chat yet.</div>}
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
        {session.status === 'working' && <div className="thinking"><Avatar agent={session.agent} size="sm" /><span>{agentLabels[session.agent]} is working…</span></div>}
        <div ref={bottom} />
      </div>

      {canReply ? (
        <footer className="composer">
          {sendError && <div className="error small">{sendError}</div>}
          <div className="composer-box">
            <textarea value={draft} rows={1} placeholder={`Message ${agentLabels[session.agent]}`}
              onChange={(event) => { setDraft(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 140)}px`; }} />
            <button className="send" aria-label="Send" disabled={!draft.trim() || sending} onClick={() => void send()}>
              {sending ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={20} />}
            </button>
          </div>
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
