import { AnimatePresence, motion, useMotionValue, useTransform, type PanInfo } from 'motion/react'
import { ArrowLeft, ArrowUp, Check, ExternalLink, Lock } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { agentNames, type AgentKey, type Card, type Decision, type DemoState, type Tile } from './engine'
import { Mark, agentColor, ease } from './ui'

interface Props {
  state: DemoState
  decide: (d: Decision) => void
  send: (text: string) => void
  openDevin: () => void
  devinDecide: (d: Decision) => void
}

const statusTone: Record<Tile['status'], string> = { working: 'text-ok', needs: 'text-accent', waiting: 'text-accent', done: 'text-muted' }
const barTone: Record<Tile['status'], string> = { working: 'bg-ok', needs: 'bg-accent', waiting: 'bg-accent', done: 'bg-muted' }

function SoftSwap({ value, className }: { value: string; className?: string }) {
  return (
    <span className={`relative inline-grid ${className ?? ''}`}>
      <AnimatePresence initial={false}>
        <motion.span
          key={value}
          className="col-start-1 row-start-1 whitespace-nowrap"
          initial={{ opacity: 0, filter: 'blur(3px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, filter: 'blur(3px)' }}
          transition={{ duration: 0.25, ease }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

function DeckCard({ card, exit, countdown, decide, openDevin }: { card: Card; exit: Decision | null; countdown: number | null; decide: (d: Decision) => void; openDevin: () => void }) {
  const x = useMotionValue(0)
  const rotate = useTransform(x, [-180, 180], [-7, 7])
  const allowTint = useTransform(x, [16, 110], [0, 1])
  const denyTint = useTransform(x, [-110, -16], [1, 0])
  const draggable = card.kind === 'approval' && !exit
  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x > 90 || info.velocity.x > 600) decide('allow')
    else if (info.offset.x < -90 || info.velocity.x < -600) decide('deny')
  }
  return (
    <motion.div
      className="absolute inset-0 z-10 flex cursor-grab touch-pan-y flex-col rounded-2xl border border-line-2 bg-card p-3.5 active:cursor-grabbing"
      style={{ x, rotate }}
      drag={draggable ? 'x' : false}
      dragSnapToOrigin
      dragElastic={0.65}
      onDragEnd={onDragEnd}
      initial={{ opacity: 0, y: 18, scale: 0.97 }}
      animate={exit ? { x: exit === 'allow' ? 380 : -380, rotate: exit === 'allow' ? 10 : -10, opacity: 0 } : { opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.2 } }}
      transition={{ duration: exit ? 0.36 : 0.4, ease }}
    >
      <motion.span style={{ opacity: allowTint }} className="pointer-events-none absolute right-3 top-3 rounded-md border border-ok/40 px-2 py-0.5 font-mono text-[11px] text-ok">Allow</motion.span>
      <motion.span style={{ opacity: denyTint }} className="pointer-events-none absolute left-3 top-3 rounded-md border border-bad/40 px-2 py-0.5 font-mono text-[11px] text-bad">Deny</motion.span>
      <div className="flex items-center gap-2 text-[12px] text-text-2">
        <Mark agent={card.agent} size={20} />
        <span className="whitespace-nowrap font-medium" style={{ color: agentColor[card.agent] }}>{agentNames[card.agent]}</span>
        <span className="min-w-0 truncate text-muted">{card.project}</span>
        <span className="ml-auto whitespace-nowrap font-medium text-accent">Needs you</span>
      </div>
      <p className="mt-3 text-[15px] font-semibold">{card.title}</p>
      <p className="mt-1.5 truncate rounded-lg border border-line bg-raised px-2.5 py-2 font-mono text-[12px] text-text-2">{card.detail}</p>
      {card.kind === 'approval' ? (
        <div className="mt-auto grid grid-cols-2 gap-2 pt-3">
          <button onClick={() => decide('deny')} className="h-10 rounded-[10px] border border-line-2 bg-raised text-[14px] font-semibold transition-colors hover:bg-raised-2">Deny</button>
          <button onClick={() => decide('allow')} className="h-10 rounded-[10px] bg-accent text-[14px] font-semibold text-on-accent transition-[filter] hover:brightness-105">Allow</button>
        </div>
      ) : (
        <button onClick={openDevin} className="mt-auto flex h-10 items-center justify-center gap-2 rounded-[10px] bg-accent text-[14px] font-semibold text-on-accent transition-[filter] hover:brightness-105">
          Open in Devin <ExternalLink size={15} />
        </button>
      )}
      <p className="mt-2 h-4 text-center font-mono text-[10.5px] text-muted">
        {card.kind === 'approval' ? 'Swipe or tap' : 'Answered in Devin, one tap away'}
        {countdown !== null && <> · auto in <SoftSwap value={String(countdown)} className="tnum" />s</>}
      </p>
    </motion.div>
  )
}

function TileView({ agent, tile }: { agent: AgentKey; tile: Tile }) {
  return (
    <div className="rounded-xl border border-line bg-card p-2.5">
      <div className="flex items-center gap-1.5">
        <Mark agent={agent} size={18} />
        <span className="truncate text-[12px] font-semibold">{agentNames[agent]}</span>
      </div>
      <p className="mt-1.5 truncate text-[11px] text-muted">{tile.task}</p>
      <p className={`mt-0.5 text-[11px] font-medium ${statusTone[tile.status]}`}><SoftSwap value={tile.label} /></p>
      <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-raised-2">
        <motion.div
          className={`h-full w-full origin-left rounded-full ${barTone[tile.status]}`}
          initial={false}
          animate={{ scaleX: tile.progress }}
          transition={{ duration: 0.8, ease }}
        />
      </div>
    </div>
  )
}

function ChatView({ state, send }: { state: DemoState; send: (t: string) => void }) {
  const [text, setText] = useState('')
  const waiting = state.chips !== null
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim() || !waiting) return
    send(text.trim()); setText('')
  }
  const tile = state.tiles.codex
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 pb-3 pt-1">
        <ArrowLeft size={18} className="text-text-2" />
        <Mark agent="codex" size={24} />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold">Flaky upload test</p>
          <p className={`text-[11px] ${statusTone[tile.status]}`}><SoftSwap value={`Codex · ${tile.label}`} /></p>
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-end gap-2 overflow-hidden px-3 py-3">
        {state.chat.map((m) => (
          <motion.p
            key={m.id}
            layout="position"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease }}
            className={`max-w-[85%] rounded-2xl px-3 py-2 text-[13px] leading-snug ${m.from === 'you' ? 'self-end rounded-br-md bg-raised-2' : 'self-start rounded-bl-md border border-line bg-card text-text-2'}`}
          >
            {m.text}
          </motion.p>
        ))}
      </div>
      <div className="h-[34px] px-3">
        <AnimatePresence>
          {state.chips && (
            <motion.div className="flex gap-1.5" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }}>
              {state.chips.map((c) => (
                <button key={c} onClick={() => send(c)} className="h-8 truncate rounded-lg border border-line-2 bg-raised px-2.5 text-[12px] font-medium transition-colors hover:bg-raised-2">{c}</button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <form onSubmit={submit} className="mx-3 mb-3 mt-2 flex items-center gap-2 rounded-xl border border-line-2 bg-card p-1.5 pl-3">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={waiting ? 'Reply to Codex' : 'Codex is working'}
          aria-label="Reply to Codex"
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted"
        />
        <button type="submit" aria-label="Send" disabled={!waiting || !text.trim()} className="grid size-8 place-items-center rounded-lg bg-accent text-on-accent transition-opacity disabled:opacity-40"><ArrowUp size={16} /></button>
      </form>
      {state.countdown !== null && waiting && (
        <p className="-mt-1 mb-2 text-center font-mono text-[10.5px] text-muted">Type or tap a reply · auto in <SoftSwap value={String(state.countdown)} className="tnum" />s</p>
      )}
    </div>
  )
}

function DevinSheet({ state, devinDecide }: { state: DemoState; devinDecide: (d: Decision) => void }) {
  return (
    <div className="flex h-full flex-col bg-[#0e1016]">
      <div className="mx-3 flex h-8 items-center gap-1.5 rounded-lg bg-raised px-3 font-mono text-[11px] text-text-2"><Lock size={11} /> app.devin.ai/sessions/…</div>
      <div className="flex-1 px-4 pt-5">
        <p className="text-[12px] text-muted">Devin · Outreach automation</p>
        <div className="mt-3 rounded-xl border border-line-2 bg-card p-3.5">
          <p className="text-[12px] text-text-2">Update automation</p>
          <p className="mt-1 text-[15px] font-semibold">Outreach autopilot</p>
          <div className="mt-3 rounded-lg border border-line bg-raised px-3 py-2 font-mono text-[12px]">
            <span className="text-muted">enabled </span><span className="text-bad line-through">true</span> <span className="text-ok">false</span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button onClick={() => devinDecide('deny')} className="h-10 rounded-[10px] border border-line-2 bg-raised text-[14px] font-semibold transition-colors hover:bg-raised-2">Deny</button>
            <button onClick={() => devinDecide('allow')} className="h-10 rounded-[10px] bg-text text-[14px] font-semibold text-bg transition-opacity hover:opacity-90">Update automation</button>
          </div>
        </div>
        {state.countdown !== null && <p className="mt-3 text-center font-mono text-[10.5px] text-muted">auto in <SoftSwap value={String(state.countdown)} className="tnum" />s</p>}
      </div>
    </div>
  )
}

export function Phone({ state, decide, send, openDevin, devinDecide }: Props) {
  const needs = Object.values(state.tiles).filter((t) => t.status === 'needs' || t.status === 'waiting').length
  const agents = Object.keys(state.tiles) as AgentKey[]
  const page = { duration: 0.42, ease }
  return (
    <div className="relative h-[620px] w-[300px] shrink-0 rounded-[42px] border border-line-2 bg-deep p-2.5 shadow-[0_40px_120px_rgb(0_0_0/0.5)]">
      <div className="relative h-full overflow-hidden rounded-[33px] bg-bg">
        <div className="relative z-30 flex h-9 items-center justify-between px-6 font-mono text-[11px] text-text-2">
          <span>9:41</span><span className="h-4 w-16 rounded-full bg-deep" /><span>100%</span>
        </div>

        <motion.div className="absolute inset-x-0 bottom-0 top-9 px-3" animate={{ x: state.view === 'home' ? 0 : -60, opacity: state.view === 'home' ? 1 : 0 }} transition={page}>
          <div className="flex items-center gap-2 pt-1 text-[11px] text-text-2"><span className="size-1.5 rounded-full bg-ok" />Live from your PC</div>
          <p className="mt-2 h-7 text-[21px] font-semibold tracking-tight">
            {needs > 0 ? <><span className="tnum text-accent">{needs}</span> needs you</> : 'All clear'}
          </p>
          <div className="relative mt-3 h-[228px]">
            <div className="absolute inset-x-3 -bottom-2 top-2 rounded-2xl border border-line bg-card/60" />
            <div className="absolute inset-x-1.5 -bottom-1 top-1 rounded-2xl border border-line bg-card/80" />
            <AnimatePresence>
              {state.card && (
                <DeckCard key={state.card.id} card={state.card} exit={state.cardExit} countdown={state.countdown} decide={decide} openDevin={openDevin} />
              )}
            </AnimatePresence>
            {!state.card && (
              <div className="absolute inset-0 z-[5] grid place-items-center rounded-2xl border border-line bg-card text-center">
                <div>
                  <p className="text-[14px] font-medium">Nothing waiting</p>
                  <p className="mt-1 text-[12px] text-muted">Your agents are working</p>
                </div>
              </div>
            )}
          </div>
          <p className="mt-5 font-mono text-[11px] text-muted">Agents</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {agents.map((a) => <TileView key={a} agent={a} tile={state.tiles[a]} />)}
          </div>
        </motion.div>

        <motion.div className="absolute inset-x-0 bottom-0 top-9 z-10 bg-bg" initial={false} animate={{ x: state.view === 'chat' ? 0 : '100%' }} transition={page} aria-hidden={state.view !== 'chat'}>
          <ChatView state={state} send={send} />
        </motion.div>
        <motion.div className="absolute inset-x-0 bottom-0 top-9 z-10" initial={false} animate={{ x: state.view === 'devin' ? 0 : '100%' }} transition={page} aria-hidden={state.view !== 'devin'}>
          <DevinSheet state={state} devinDecide={devinDecide} />
        </motion.div>

        <div className="pointer-events-none absolute inset-x-2 top-10 z-40 h-20">
          <AnimatePresence>
            {state.banners.map((b, i) => (
              <motion.div
                key={b.id}
                className="absolute inset-x-0 top-0 flex items-start gap-2.5 rounded-2xl border border-line-2 bg-raised/95 p-2.5 shadow-[0_12px_30px_rgb(0_0_0/0.4)] backdrop-blur"
                style={{ zIndex: 10 - i }}
                initial={{ y: -24, opacity: 0, scale: 0.97, filter: 'blur(2px)' }}
                animate={{ y: i * 7, opacity: i === 0 ? 1 : 0.5, scale: 1 - i * 0.05, filter: 'blur(0px)' }}
                exit={{ y: -18, opacity: 0, transition: { duration: 0.25, ease } }}
                transition={{ duration: 0.35, ease }}
              >
                <Mark agent={b.agent} size={26} />
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-[12px] font-semibold">{b.title}<span className="font-normal text-muted">· now</span></p>
                  <p className="truncate text-[11.5px] text-text-2">{b.body}</p>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-6 z-40 flex justify-center">
          <AnimatePresence>
            {state.toast && (
              <motion.div
                key={state.toast.id}
                className="flex items-center gap-2 rounded-full border border-line-2 bg-raised px-3.5 py-2 text-[13px] font-medium shadow-[0_12px_30px_rgb(0_0_0/0.4)]"
                initial={{ y: 16, opacity: 0, scale: 0.97, filter: 'blur(2px)' }}
                animate={{ y: 0, opacity: 1, scale: 1, filter: 'blur(0px)' }}
                exit={{ y: 8, opacity: 0, transition: { duration: 0.25 } }}
                transition={{ duration: 0.35, ease }}
              >
                <span className="grid size-4 place-items-center rounded-full bg-ok text-bg"><Check size={11} strokeWidth={3} /></span>
                {state.toast.text}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
