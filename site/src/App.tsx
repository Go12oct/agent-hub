import { MotionConfig, motion } from 'motion/react'
import { ChevronDown, Download, Smartphone } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { LiveDemo } from './demo/LiveDemo'
import { Background } from './Background'
import { Story, type Beat } from './Story'
import { ease } from './demo/ui'

const REPO = 'https://github.com/Go12oct/agent-hub'
const WIN = `${REPO}/releases/latest/download/agent-hub-windows.zip`
const APK = `${REPO}/releases/latest/download/agent-hub-android.apk`
const VERSION = 'v0.2.3'

const link = 'underline decoration-line-2 underline-offset-4 transition-colors hover:decoration-text-2'
const code = 'rounded-md border border-line bg-raised px-1.5 py-0.5 font-mono text-[13px] text-text'

function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-80px' }} transition={{ duration: 0.5, ease }}>
      {children}
    </motion.div>
  )
}

function SectionHead({ title, body }: { title: string; body?: ReactNode }) {
  return (
    <Reveal>
      <h2 className="max-w-[720px] text-[32px] font-medium leading-[1.1] tracking-[-0.025em] sm:text-[42px]">{title}</h2>
      {body && <p className="mt-4 max-w-[640px] text-[16px] leading-relaxed text-text-2 sm:text-[17px]">{body}</p>}
    </Reveal>
  )
}

const tools = ['VS Code', 'Cursor', 'Windsurf', 'Antigravity', 'JetBrains', 'Windows Terminal']

const beats: Beat[] = [
  { time: '09:40', title: 'Start the job where you always do', body: 'Kick off Claude Code in Cursor or the terminal and walk away. Your phone shows every chat running on the PC, grouped by agent.', shot: '/shots/home-working.webp', alt: 'Agent Hub home screen with four agents working' },
  { time: '09:52', title: 'Claude stops to ask. Your phone buzzes', body: 'The exact command arrives as a card with an alert. Swipe right to allow, left to deny, and Claude carries on at your desk.', shot: '/shots/home-approval.webp', alt: 'Claude Code asking to run npm run db:migrate, with Allow and Deny' },
  { time: '10:15', title: 'Codex finished and has a question', body: 'Type the answer on your phone. It goes into the same chat on your PC, exactly as if you had typed it there.', shot: '/shots/chat-reply.webp', alt: 'Codex chat with a question and a reply being typed' },
  { time: '11:30', title: 'Devin is waiting on a card', body: "You see what Devin wants and open the card in Devin with one tap. Devin's API can't answer cards, so Agent Hub doesn't pretend to.", shot: '/shots/devin-card.webp', alt: 'Devin card asking to update an automation, with Open in Devin' },
  { time: '13:05', title: 'Across town, on mobile data', body: 'With Tailscale on both devices, the phone reaches your PC from anywhere. No ports opened to the internet, no account to sign up for.', shot: '/shots/home-away.webp', alt: 'Agent Hub home screen connected over Tailscale' },
]

const agents = [
  { name: 'Claude Code', color: 'var(--color-claude)', feed: 'Yes', reply: 'Yes', approvals: 'Allow or Deny on the phone' },
  { name: 'Codex', color: 'var(--color-codex)', feed: 'Yes', reply: 'Yes', approvals: 'Allow or Deny through Codex hooks' },
  { name: 'Devin', color: 'var(--color-devin)', feed: 'Cloud and local', reply: 'Devin Local chats', approvals: 'Shown on the phone, answered in Devin' },
  { name: 'Antigravity', color: 'var(--color-agy)', feed: 'Yes', reply: 'CLI chats', approvals: 'Not available yet' },
]

const steps = [
  { title: 'Install on your PC', body: <>Download <a className={link} href={WIN}>agent-hub-windows.zip</a>, unzip it and double-click <code className={code}>Install-AgentHub.cmd</code>. It starts with Windows and sits in the tray. No admin rights needed.</> },
  { title: 'Install the phone app', body: <>Open <a className={link} href={APK}>agent-hub-android.apk</a> on your phone. Android asks once to allow installs from your browser.</> },
  { title: 'Scan to pair', body: <>Right-click the tray icon, choose Pair phone and scan the QR code. For alerts and away-from-home access, the <a className={link} href={`${REPO}#readme`}>README</a> covers ntfy and Tailscale.</> },
]

const faqs = [
  { q: 'Do I have to change how I work?', a: "No. Keep your editor, your terminal and each agent's own CLI and settings. Agent Hub reads the chats where they already live and adds a small approval hook to Claude Code and Codex." },
  { q: 'Is my code uploaded anywhere?', a: 'No. The PC app serves chats straight to your paired phone over Wi-Fi or Tailscale. Alerts go through ntfy and carry a one-line summary, never the transcript.' },
  { q: 'How is this different from T3 Code?', a: 'T3 Code is a new place to run your agents. Agent Hub is not an IDE and runs nothing itself. It watches the agents you already run and puts them on your phone.' },
  { q: 'Can it approve Devin cards?', a: "Not from the phone. Devin has no public API for answering cards, so the phone shows the card and opens it in Devin with one tap. Claude Code and Codex approvals are answered right on the phone." },
  { q: 'Why not the Play Store?', a: 'To keep it free. The APK is signed with one key, so every update installs over the last one and keeps your pairing.' },
  { q: 'Mac, Linux or iPhone?', a: 'Not yet. Agent Hub is built for Windows and Android today.' },
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

function Ctas() {
  return (
    <div className="flex flex-wrap justify-center gap-3">
      <a className="btn btn-primary" href={WIN}><Download size={17} />Download for Windows</a>
      <a className="btn btn-secondary" href={APK}><Smartphone size={17} />Get the Android app</a>
    </div>
  )
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <Background />
      <div className="relative mx-auto max-w-[1120px] px-5 sm:px-8">
        <nav className="flex h-16 items-center justify-between border-b border-line">
          <a href="/" className="flex items-center gap-2.5 font-medium"><img src="/favicon.svg" alt="" className="size-7" />Agent Hub</a>
          <div className="flex items-center gap-6 text-[14px] text-text-2">
            <a className="hidden transition-colors hover:text-text md:inline" href="#story">How it works</a>
            <a className="hidden transition-colors hover:text-text md:inline" href="#agents">Agents</a>
            <a className="hidden transition-colors hover:text-text md:inline" href="#install">Install</a>
            <a className="transition-colors hover:text-text" href={REPO}>GitHub</a>
            <a className="btn btn-secondary btn-sm" href="#install">Download</a>
          </div>
        </nav>

        <header className="pt-16 text-center sm:pt-24">
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease }}>
            <p className="font-mono text-[12px] text-muted">Free and open source · Windows and Android</p>
            <h1 className="mx-auto mt-5 max-w-[820px] text-[44px] font-medium leading-[1.04] tracking-[-0.035em] sm:text-[70px]">Leave your desk.<br /><span className="text-text-2">Your agents keep going.</span></h1>
            <p className="mx-auto mt-6 max-w-[600px] text-[17px] leading-relaxed text-text-2 sm:text-[18px]">Agent Hub puts every Claude Code, Codex, Devin and Antigravity chat from your PC on your Android phone. Allow a command, answer a question, get pinged when one stops. Your IDE and agents stay exactly as they are.</p>
            <div className="mt-9"><Ctas /></div>
            <p className="mt-4 font-mono text-[12px] text-muted">{VERSION} · Windows 10 or 11 · Android 8 or later · MIT licensed</p>
          </motion.div>
        </header>

        <section id="demo" className="scroll-mt-8 pb-20 pt-16 sm:pt-20">
          <LiveDemo />
        </section>

        <section className="border-t border-line py-14">
          <Reveal className="flex flex-col items-center gap-5 text-center">
            <p className="text-[15px] text-text-2">Works next to the tools you already use</p>
            <ul className="flex flex-wrap justify-center gap-x-8 gap-y-3 font-mono text-[14px] text-muted">
              {tools.map((t) => <li key={t} className="transition-colors hover:text-text">{t}</li>)}
            </ul>
          </Reveal>
        </section>

        <section id="story" className="scroll-mt-8 border-t border-line pt-24">
          <SectionHead title="One morning away from the desk" body="This is the real app, on a real phone, following four agents through a morning." />
          <div className="mt-6 lg:-mt-6"><Story beats={beats} /></div>
        </section>

        <section className="border-t border-line py-24">
          <SectionHead title="Not another IDE" body="Agent IDEs like T3 Code ask you to move your work into their window. Agent Hub stays out of the way: your editor, each agent's own CLI and settings, and a phone that knows when they need you." />
          <div className="mt-10 grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div className="rounded-2xl border border-line bg-card/80 p-6">
              <p className="font-mono text-[12px] text-muted">A new agent IDE</p>
              <ul className="mt-4 grid gap-2.5 text-[15px] text-text-2">
                <li>Move projects and habits into one app</li><li>Learn its chat window for every agent</li><li>Useful while you sit in front of it</li>
              </ul>
            </div>
            <div className="rounded-2xl border border-accent/40 bg-card/80 p-6">
              <p className="font-mono text-[12px] text-accent">Agent Hub</p>
              <ul className="mt-4 grid gap-2.5 text-[15px]">
                <li>Your IDE, agents and settings stay untouched</li><li>Reads chats where they already live, nothing to migrate</li><li>Follows you to the sofa, the café or the train</li>
              </ul>
            </div>
          </div>
        </section>

        <section id="agents" className="scroll-mt-8 border-t border-line py-24">
          <SectionHead title="What works with each agent" body="Only each agent's official hooks, CLIs and APIs. Where an agent has no way to answer from outside, the table says so." />
          <div className="mt-10 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-[15px]">
              <thead><tr className="border-b border-line font-mono text-[12px] text-muted">{['Agent', 'Live feed', 'Reply', 'Approvals'].map((h) => <th key={h} className="py-3 pr-4 font-normal">{h}</th>)}</tr></thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.name} className="border-b border-line transition-colors hover:bg-card/60">
                    <td className="py-4 pr-4 font-medium"><span className="mr-2.5 inline-block size-2 rounded-full" style={{ background: a.color }} />{a.name}</td>
                    <td className="py-4 pr-4">{a.feed}</td>
                    <td className="py-4 pr-4">{a.reply}</td>
                    <td className="py-4 pr-4 text-text-2">{a.approvals}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="border-t border-line py-24">
          <SectionHead title="Your PC, your phone, nothing in between" />
          <div className="mt-10 grid gap-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Reveal className="rounded-2xl border border-line bg-card/80 p-6 md:row-span-2">
              <p className="font-mono text-[12px] text-muted">How it connects</p>
              <div className="mt-6 grid grid-cols-[auto_1fr_auto] items-center gap-4 font-mono text-[13px]">
                <span className="rounded-[10px] border border-line-2 bg-raised px-3 py-2">Your PC</span>
                <span className="relative h-px bg-line-2"><span className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[12px] text-muted">Wi-Fi or Tailscale</span></span>
                <span className="rounded-[10px] border border-accent/40 bg-raised px-3 py-2 text-accent">Your phone</span>
              </div>
              <p className="mt-6 text-[15px] leading-relaxed text-text-2">A small tray app reads each agent's chats on the PC and serves them to the phone you paired with a QR code. There's no Agent Hub server and no account. Alerts go through the free ntfy app and carry a one-line summary, never the transcript.</p>
            </Reveal>
            <Reveal className="rounded-2xl border border-line bg-card/80 p-6">
              <p className="text-[17px] font-medium">Free, for real</p>
              <p className="mt-1.5 text-[15px] leading-relaxed text-text-2">MIT licensed, no subscription, no store. Updates come from GitHub Releases.</p>
            </Reveal>
            <Reveal className="rounded-2xl border border-line bg-card/80 p-6">
              <p className="text-[17px] font-medium">Honest alerts</p>
              <p className="mt-1.5 text-[15px] leading-relaxed text-text-2">“Needs you” only for a real approval. Finished turns say “Waiting on you”.</p>
            </Reveal>
          </div>
        </section>

        <section id="install" className="scroll-mt-8 border-t border-line py-24">
          <SectionHead title="Set up in three steps" body="A Windows 10 or 11 PC and an Android phone. Nothing else to install." />
          <ol className="mt-10 grid gap-3 md:grid-cols-3">
            {steps.map((s, i) => (
              <Reveal key={s.title} className="rounded-2xl border border-line bg-card/80 p-6">
                <span className="grid size-9 place-items-center rounded-[9px] border border-line-2 bg-raised font-mono text-[13px]">{i + 1}</span>
                <p className="mt-5 font-medium">{s.title}</p>
                <p className="mt-1.5 text-[15px] leading-relaxed text-text-2">{s.body}</p>
              </Reveal>
            ))}
          </ol>
        </section>

        <section className="border-t border-line py-24">
          <SectionHead title="Questions" />
          <div className="mt-8 border-t border-line">{faqs.map((f) => <Faq key={f.q} {...f} />)}</div>
        </section>

        <section className="border-t border-line py-28 text-center">
          <Reveal>
            <h2 className="mx-auto max-w-[680px] text-[36px] font-medium leading-[1.08] tracking-[-0.03em] sm:text-[52px]">Your agents are still running.<br /><span className="text-text-2">Go for a walk.</span></h2>
            <div className="mt-9"><Ctas /></div>
          </Reveal>
        </section>

        <footer className="flex flex-wrap justify-between gap-3 border-t border-line py-8 text-[14px] text-muted">
          <span>Agent Hub · MIT licensed</span>
          <span className="flex gap-5"><a className="transition-colors hover:text-text" href={REPO}>GitHub</a><a className="transition-colors hover:text-text" href={`${REPO}/releases`}>Releases</a></span>
        </footer>
      </div>
    </MotionConfig>
  )
}
