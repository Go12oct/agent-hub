import { useCallback, useEffect, useRef, useState } from 'react'

export type AgentKey = 'claude' | 'codex' | 'devin' | 'agy'
export type LineKind = 'cmd' | 'out' | 'warn' | 'ok' | 'bad' | 'user' | 'dim'
export type Scenario = 'approve' | 'reply' | 'devin'
export type Decision = 'allow' | 'deny'

export interface Line { id: number; kind: LineKind; text: string }
export interface Banner { id: number; agent: AgentKey; title: string; body: string }
export interface Card { id: number; agent: AgentKey; kind: 'approval' | 'devin'; project: string; title: string; detail: string }
export interface Tile { status: 'working' | 'needs' | 'waiting' | 'done'; label: string; task: string; progress: number }
export interface Msg { id: number; from: 'agent' | 'you'; text: string }

export interface DemoState {
  pcTitle: string
  pcAgent: AgentKey
  lines: Line[]
  thinking: string | null
  banners: Banner[]
  card: Card | null
  cardExit: Decision | null
  tiles: Record<AgentKey, Tile>
  view: 'home' | 'chat' | 'devin'
  chat: Msg[]
  chips: string[] | null
  toast: { id: number; text: string } | null
  countdown: number | null
  pulse: number
}

export const agentNames: Record<AgentKey, string> = {
  claude: 'Claude Code', codex: 'Codex', devin: 'Devin', agy: 'Antigravity',
}

const baseTiles = (): Record<AgentKey, Tile> => ({
  claude: { status: 'working', label: 'Working', task: 'Stripe webhooks', progress: 0.35 },
  codex: { status: 'working', label: 'Working', task: 'Flaky upload test', progress: 0.5 },
  devin: { status: 'working', label: 'Working', task: 'Outreach automation', progress: 0.6 },
  agy: { status: 'working', label: 'Working', task: 'Billing refactor', progress: 0.42 },
})

const initial = (): DemoState => ({
  pcTitle: 'Windows Terminal', pcAgent: 'claude', lines: [], thinking: null, banners: [], card: null,
  cardExit: null, tiles: baseTiles(), view: 'home', chat: [], chips: null, toast: null, countdown: null, pulse: 0,
})

type Pending = { key: string; done: (value: unknown) => void }
const aborted = new Error('aborted')
let seq = 1

export function useDemo(scenario: Scenario, runKey: number, active: boolean, onEnd: () => void) {
  const [state, setState] = useState<DemoState>(initial)
  const pending = useRef<Pending | null>(null)
  const endRef = useRef(onEnd)
  endRef.current = onEnd

  const resolve = useCallback((key: string, value: unknown) => {
    if (pending.current?.key === key) pending.current.done(value)
  }, [])

  useEffect(() => {
    if (!active) return
    const ctrl = new AbortController()
    const signal = ctrl.signal
    const set = (fn: (s: DemoState) => DemoState) => { if (!signal.aborted) setState(fn) }
    const sleep = (ms: number) => new Promise<void>((res, rej) => {
      const t = setTimeout(res, ms)
      signal.addEventListener('abort', () => { clearTimeout(t); rej(aborted) }, { once: true })
    })
    const later = (ms: number, fn: () => void) => {
      const t = setTimeout(fn, ms)
      signal.addEventListener('abort', () => clearTimeout(t), { once: true })
    }
    const waitFor = <T,>(key: string, autoMs: number, auto: T) => new Promise<T>((res, rej) => {
      let left = Math.round(autoMs / 1000)
      set((s) => ({ ...s, countdown: left }))
      const iv = setInterval(() => {
        left -= 1
        if (left <= 0) done(auto)
        else set((s) => ({ ...s, countdown: left }))
      }, 1000)
      const done = (value: unknown) => {
        clearInterval(iv)
        pending.current = null
        set((s) => ({ ...s, countdown: null }))
        res(value as T)
      }
      pending.current = { key, done }
      signal.addEventListener('abort', () => { clearInterval(iv); pending.current = null; rej(aborted) }, { once: true })
    })

    const say = (kind: LineKind, text: string) => set((s) => ({ ...s, lines: [...s.lines, { id: seq++, kind, text }].slice(-8) }))
    const think = (text: string | null) => set((s) => ({ ...s, thinking: text }))
    const sync = () => set((s) => ({ ...s, pulse: s.pulse + 1 }))
    const tile = (agent: AgentKey, patch: Partial<Tile>) => set((s) => ({ ...s, tiles: { ...s.tiles, [agent]: { ...s.tiles[agent], ...patch } } }))
    const toast = (text: string) => {
      const id = seq++
      set((s) => ({ ...s, toast: { id, text } }))
      later(1800, () => set((s) => (s.toast?.id === id ? { ...s, toast: null } : s)))
    }
    const banner = (agent: AgentKey, title: string, body: string) => {
      const id = seq++
      set((s) => ({ ...s, banners: [{ id, agent, title, body }, ...s.banners].slice(0, 3) }))
      later(3400, () => set((s) => ({ ...s, banners: s.banners.filter((b) => b.id !== id) })))
    }
    const card = (c: Omit<Card, 'id'> | null) => set((s) => ({ ...s, card: c ? { ...c, id: seq++ } : null, cardExit: null }))
    const reset = (pcTitle: string, pcAgent: AgentKey) => set(() => ({ ...initial(), pcTitle, pcAgent }))

    async function approve() {
      reset('Windows Terminal — claude', 'claude')
      await sleep(400)
      say('cmd', 'claude "add Stripe webhooks to api-server"')
      await sleep(500); think('Reading the codebase'); await sleep(1400); think(null)
      say('dim', 'Read src/routes/billing.ts'); tile('claude', { progress: 0.5 }); await sleep(500)
      say('dim', 'Edited 3 files  +142 −8'); tile('claude', { progress: 0.62 }); await sleep(600)
      think('Planning the migration'); await sleep(1300); think(null)
      say('warn', 'Permission needed: Bash(npm run migrate --env staging)')
      say('dim', 'Waiting for your answer on the phone')
      sync(); await sleep(450)
      tile('claude', { status: 'needs', label: 'Needs you' })
      banner('claude', 'Claude Code needs you', 'api-server · Run a command')
      card({ agent: 'claude', kind: 'approval', project: 'api-server', title: 'Run a command?', detail: 'npm run migrate --env staging' })
      const d = await waitFor<Decision>('decide', 8000, 'allow')
      set((s) => ({ ...s, cardExit: d }))
      await sleep(360); card(null)
      toast(d === 'allow' ? 'Allowed' : 'Denied'); sync(); await sleep(450)
      if (d === 'allow') {
        say('ok', 'Allowed from your phone')
        tile('claude', { status: 'working', label: 'Working', progress: 0.8 })
        think('Running the migration'); await sleep(1500); think(null)
        say('out', 'Migrated 4 tables in 1.2s'); await sleep(600)
        say('ok', 'Webhooks ready. 12 of 12 tests pass')
      } else {
        say('bad', 'Denied from your phone')
        tile('claude', { status: 'working', label: 'Working', progress: 0.8 })
        think('Finding another way'); await sleep(1500); think(null)
        say('out', 'Skipped the migration and wrote it to MIGRATION.md for review'); await sleep(600)
        say('ok', 'Webhooks ready. 12 of 12 tests pass')
      }
      tile('claude', { status: 'done', label: 'Done', progress: 1 }); sync()
      banner('claude', 'Claude Code finished', 'api-server · 12 of 12 tests pass')
      await sleep(3600)
    }

    async function reply() {
      reset('Windows Terminal — codex', 'codex')
      await sleep(400)
      say('cmd', 'codex "fix the flaky upload test"')
      await sleep(400); think('Running the test 20 times'); tile('codex', { progress: 0.65 }); await sleep(1600); think(null)
      say('dim', 'tests/upload.spec.ts  failed 3 of 20'); await sleep(500)
      say('dim', 'Cause: the retry timer races the upload'); tile('codex', { progress: 0.85 }); await sleep(600)
      say('ok', 'Fixed. 20 of 20 pass'); await sleep(400)
      say('out', 'Should I also raise the CI timeout to 60s?')
      sync(); await sleep(400)
      tile('codex', { status: 'waiting', label: 'Waiting on you', progress: 1 })
      banner('codex', 'Codex is waiting on you', 'uploads · Should I also raise the CI timeout?')
      await sleep(900)
      set((s) => ({
        ...s, view: 'chat',
        chat: [
          { id: seq++, from: 'agent', text: 'Fixed the flaky upload test. 20 of 20 pass.' },
          { id: seq++, from: 'agent', text: 'Should I also raise the CI timeout to 60s?' },
        ],
        chips: ['Yes, raise it', 'No, leave CI alone'],
      }))
      const text = await waitFor<string>('reply', 9000, 'Yes, raise it')
      set((s) => ({ ...s, chips: null, chat: [...s.chat, { id: seq++, from: 'you', text }] }))
      sync(); await sleep(500)
      say('user', `you, from your phone: ${text}`)
      tile('codex', { status: 'working', label: 'Working', progress: 0.9 })
      const no = /^\s*no\b/i.test(text)
      think(no ? 'Wrapping up' : 'Updating ci.yml'); await sleep(1500); think(null)
      const answer = no ? 'Left CI as it is. All done.' : 'Raised the CI timeout to 60s in ci.yml. All done.'
      say('ok', answer)
      set((s) => ({ ...s, chat: [...s.chat, { id: seq++, from: 'agent', text: answer }] }))
      tile('codex', { status: 'done', label: 'Done', progress: 1 }); sync()
      await sleep(2200)
      set((s) => ({ ...s, view: 'home' }))
      await sleep(2600)
    }

    async function devin() {
      reset('Devin — Outreach automation', 'devin')
      await sleep(400)
      say('cmd', 'Devin  ·  Outreach automation')
      await sleep(400); think('Drafting the email template'); tile('devin', { progress: 0.8 }); await sleep(1500); think(null)
      say('dim', 'Saved outreach/template.md'); await sleep(600)
      say('warn', 'Card: Update automation "Outreach autopilot"')
      say('dim', 'enabled: true → false, until the template is final')
      sync(); await sleep(450)
      tile('devin', { status: 'needs', label: 'Needs you' })
      banner('devin', 'Devin needs you', 'Outreach automation · Update automation')
      card({ agent: 'devin', kind: 'devin', project: 'Outreach automation', title: 'Update automation', detail: 'Outreach autopilot · enabled: true → false' })
      await waitFor<boolean>('open', 7000, true)
      set((s) => ({ ...s, view: 'devin' }))
      const d = await waitFor<Decision>('devinDecide', 6000, 'allow')
      sync(); toast(d === 'allow' ? 'Approved in Devin' : 'Denied in Devin')
      await sleep(500)
      card(null); set((s) => ({ ...s, view: 'home' }))
      say(d === 'allow' ? 'ok' : 'bad', d === 'allow' ? 'You approved the card in Devin' : 'You denied the card in Devin')
      tile('devin', { status: 'working', label: 'Working', progress: 0.9 })
      await sleep(900)
      say('out', d === 'allow' ? 'Autopilot paused until the template is final' : 'Keeping autopilot on as it is')
      await sleep(3200)
    }

    const scripts: Record<Scenario, () => Promise<void>> = { approve, reply, devin }
    scripts[scenario]().then(() => { if (!signal.aborted) endRef.current() }).catch(() => {})
    return () => ctrl.abort()
  }, [scenario, runKey, active])

  const decide = useCallback((d: Decision) => resolve('decide', d), [resolve])
  const send = useCallback((text: string) => resolve('reply', text), [resolve])
  const openDevin = useCallback(() => resolve('open', true), [resolve])
  const devinDecide = useCallback((d: Decision) => resolve('devinDecide', d), [resolve])
  return { state, decide, send, openDevin, devinDecide }
}
