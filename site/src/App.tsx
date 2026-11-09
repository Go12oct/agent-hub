import { MotionConfig, motion } from 'motion/react'
import { ChevronDown, Download, Smartphone } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { LiveDemo } from './demo/LiveDemo'
import { ease } from './demo/ui'

const REPO = 'https://github.com/Go12oct/agent-hub'
const WIN = `${REPO}/releases/latest/download/agent-hub-windows.zip`
const APK = `${REPO}/releases/latest/download/agent-hub-android.apk`

function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-80px' }} transition={{ duration: 0.5, ease }}>
      {children}
    </motion.div>
  )
}

const agents = [
  { name: 'Claude Code', color: 'var(--color-claude)', feed: 'Yes', reply: 'Yes', approvals: 'Allow or Deny on the phone' },
  { name: 'Codex', color: 'var(--color-codex)', feed: 'Yes', reply: 'Yes', approvals: 'Allow or Deny through Codex hooks' },
  { name: 'Devin', color: 'var(--color-devin)', feed: 'Cloud and local', reply: 'Devin Local chats', approvals: 'Shown on the phone, answered in Devin' },
  { name: 'Antigravity', color: 'var(--color-agy)', feed: 'Yes', reply: 'CLI chats', approvals: 'Not available' },
]

const steps = [
  { title: 'Install on your PC', body: <>Download <a className="underline decoration-line-2 underline-offset-4 hover:decoration-text-2" href={WIN}>agent-hub-windows.zip</a>, unzip it and double-click <code className="rounded-md border border-line bg-raised px-1.5 py-0.5 font-mono text-[13px] text-text">Install-AgentHub.cmd</code>. It starts with Windows and adds a tray icon. No admin rights needed.</> },
  { title: 'Install the phone app', body: <>Open <a className="underline decoration-line-2 underline-offset-4 hover:decoration-text-2" href={APK}>agent-hub-android.apk</a> on your phone. Android asks once to allow installs from your browser.</> },
  { title: 'Pair', body: <>Right-click the tray icon, choose Pair phone, and scan the QR code with the app.</> },
  { title: 'Optional: alerts and away from home', body: <>Add a private ntfy topic for notifications, and Tailscale to reach your PC on mobile data. The <a className="underline decoration-line-2 underline-offset-4 hover:decoration-text-2" href={`${REPO}#readme`}>README</a> has both.</> },
]

const faqs = [
  { q: 'Is my code uploaded anywhere?', a: 'No. Agent Hub reads chats on your PC and sends them straight to your paired phone over your network. Notifications carry a one-line summary, never the transcript.' },
  { q: 'Why not the Play Store?', a: 'To keep it free. The APK is signed with one key, so each update installs over the last one and keeps your pairing.' },
  { q: 'Mac, Linux or iPhone?', a: 'Not yet. Agent Hub is built for Windows and Android today.' },
  { q: 'Can it approve Devin cards?', a: 'Devin has no public API for answering cards, so the phone shows the card and opens it in Devin with one tap. Claude Code and Codex approvals are answered right on the phone.' },
  { q: 'Does it work away from home?', a: 'Yes, with Tailscale on both the PC and the phone. Both are free for personal use.' },
]

function Faq({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div data-open={open} className="border-b border-line">
      <button className="flex w-full items-center justify-between gap-6 py-5 text-left text-[16px] font-medium" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {q}<ChevronDown size={18} className="acc-chev shrink-0 text-muted" />
      </button>
      <div className="acc-body"><div><p className="pb-5 pr-10 text-[15px] leading-relaxed text-text-2">{a}</p></div></div>
    </div>
  )
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <div className="mx-auto max-w-[1120px] px-5 sm:px-8">
        <nav className="flex h-16 items-center justify-between border-b border-line">
          <a href="/" className="flex items-center gap-2.5 font-semibold"><img src="/favicon.svg" alt="" className="size-7" />Agent Hub</a>
          <div className="flex items-center gap-6 text-[14px] text-text-2">
            <a className="hidden transition-colors hover:text-text sm:inline" href="#demo">Demo</a>
            <a className="hidden transition-colors hover:text-text sm:inline" href="#agents">Agents</a>
            <a className="hidden transition-colors hover:text-text sm:inline" href="#install">Install</a>
            <a className="transition-colors hover:text-text" href={REPO}>GitHub</a>
          </div>
        </nav>

        <header className="pt-16 text-center sm:pt-24">
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease }}>
            <p className="font-mono text-[12px] text-accent">Free · Local · No app store</p>
            <h1 className="mx-auto mt-5 max-w-[760px] text-[44px] font-semibold leading-[1.04] tracking-[-0.035em] sm:text-[68px]">Your coding agents, on your phone.</h1>
            <p className="mx-auto mt-6 max-w-[580px] text-[17px] leading-relaxed text-text-2 sm:text-[18px]">Agent Hub runs on your Windows PC and puts every Claude Code, Codex, Devin and Antigravity chat on your Android phone. Approve requests, reply, and get an alert when an agent needs you.</p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              <a className="btn btn-primary" href={WIN}><Download size={17} />Download for Windows</a>
              <a className="btn btn-secondary" href={APK}><Smartphone size={17} />Android app</a>
            </div>
            <p className="mt-4 font-mono text-[12px] text-muted">v0.2.3 · Windows 10 or 11 · Android 8 or later · MIT licensed</p>
          </motion.div>
        </header>

        <section id="demo" className="scroll-mt-8 pb-24 pt-16 sm:pt-20">
          <LiveDemo />
        </section>

        <section className="border-t border-line py-24">
          <Reveal>
            <h2 className="max-w-[640px] text-[32px] font-semibold leading-tight tracking-[-0.025em] sm:text-[40px]">Leave the desk. Keep the agents moving.</h2>
            <p className="mt-4 max-w-[620px] text-[16px] leading-relaxed text-text-2">A small background app on your PC reads your agents' chats where they already live and serves them to your phone. Nothing goes through a hosted service.</p>
          </Reveal>
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
            {[
              ['Approve from your phone', 'Claude Code and Codex permission requests arrive as cards. Allow or Deny, and the agent carries on.'],
              ['Reply to any chat', 'Send the next message to Claude Code, Codex, Devin Local and Antigravity CLI chats.'],
              ['Alerts that matter', 'A notification when an agent needs you, finishes or fails, through the free ntfy app.'],
              ['Devin, cloud and local', "See every Devin session and the cards it's waiting on, and jump into Devin to answer."],
              ['Works away from home', 'Add Tailscale on both devices and your agents follow you onto mobile data.'],
              ['Yours, for free', 'No account, no subscription, no store. Download, install, scan a QR code.'],
            ].map(([t, b], i) => (
              <div key={t} className="bg-bg p-6">
                <p className="font-mono text-[12px] text-muted">0{i + 1}</p>
                <h3 className="mt-3 text-[17px] font-semibold">{t}</h3>
                <p className="mt-1.5 text-[15px] leading-relaxed text-text-2">{b}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="agents" className="scroll-mt-8 border-t border-line py-24">
          <Reveal>
            <h2 className="text-[32px] font-semibold tracking-[-0.025em] sm:text-[40px]">What works with each agent</h2>
            <p className="mt-4 text-[16px] text-text-2">Agent Hub only uses each agent's official hooks, CLIs and APIs.</p>
          </Reveal>
          <div className="mt-10 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-[15px]">
              <thead><tr className="border-b border-line font-mono text-[12px] text-muted">{['Agent', 'Live feed', 'Reply', 'Approvals'].map((h) => <th key={h} className="py-3 pr-4 font-normal">{h}</th>)}</tr></thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.name} className="border-b border-line">
                    <td className="py-4 pr-4 font-semibold"><span className="mr-2.5 inline-block size-2 rounded-full" style={{ background: a.color }} />{a.name}</td>
                    <td className="py-4 pr-4">{a.feed}</td>
                    <td className="py-4 pr-4">{a.reply}</td>
                    <td className="py-4 pr-4 text-text-2">{a.approvals}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section id="install" className="scroll-mt-8 border-t border-line py-24">
          <Reveal>
            <h2 className="text-[32px] font-semibold tracking-[-0.025em] sm:text-[40px]">Set up in two minutes</h2>
            <p className="mt-4 text-[16px] text-text-2">A Windows 10 or 11 PC and an Android phone. Nothing else to install.</p>
          </Reveal>
          <ol className="mt-10 grid gap-3">
            {steps.map((s, i) => (
              <li key={s.title} className="grid grid-cols-[40px_1fr] gap-4 rounded-2xl border border-line bg-card p-5">
                <span className="grid size-9 place-items-center rounded-[9px] border border-line-2 bg-raised font-mono text-[13px]">{i + 1}</span>
                <div><p className="font-semibold">{s.title}</p><p className="mt-1 text-[15px] leading-relaxed text-text-2">{s.body}</p></div>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-t border-line py-24">
          <Reveal><h2 className="text-[32px] font-semibold tracking-[-0.025em] sm:text-[40px]">Questions</h2></Reveal>
          <div className="mt-8 border-t border-line">{faqs.map((f) => <Faq key={f.q} {...f} />)}</div>
        </section>

        <footer className="flex flex-wrap justify-between gap-3 border-t border-line py-8 text-[14px] text-muted">
          <span>Agent Hub · MIT licensed</span>
          <span className="flex gap-5"><a className="transition-colors hover:text-text" href={REPO}>GitHub</a><a className="transition-colors hover:text-text" href={`${REPO}/releases`}>Releases</a></span>
        </footer>
      </div>
    </MotionConfig>
  )
}
