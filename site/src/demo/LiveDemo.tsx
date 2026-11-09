import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDemo, type Scenario } from './engine'
import { Pc } from './Pc'
import { Phone } from './Phone'
import { ease } from './ui'

const scenarios: Array<{ id: Scenario; label: string; caption: string }> = [
  { id: 'approve', label: 'Approve', caption: 'Claude Code wants to run a migration. Swipe the card right to allow it, left to deny, or let it play.' },
  { id: 'reply', label: 'Reply', caption: 'Codex finished and asked a question. Tap a reply or type your own, and it lands in the chat on your PC.' },
  { id: 'devin', label: 'Devin cards', caption: 'Devin raised a card. The phone shows it and opens it in Devin, where you answer it.' },
]

function useInView<T extends Element>() {
  const ref = useRef<T>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.25 })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return [ref, visible] as const
}

function usePageVisible() {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  useEffect(() => {
    const on = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

export function LiveDemo() {
  const [index, setIndex] = useState(0)
  const [run, setRun] = useState(0)
  const [stageRef, inView] = useInView<HTMLDivElement>()
  const pageVisible = usePageVisible()
  const next = useCallback(() => setIndex((i) => (i + 1) % scenarios.length), [])
  const scenario = scenarios[index]
  const demo = useDemo(scenario.id, run, inView && pageVisible, next)

  return (
    <div ref={stageRef}>
      <div className="flex flex-col items-center gap-4">
        <div role="tablist" aria-label="Demo" className="relative inline-flex rounded-xl border border-line bg-card p-1">
          {scenarios.map((s, i) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={i === index}
              onClick={() => { setIndex(i); setRun((r) => r + 1) }}
              className={`relative z-10 h-9 rounded-lg px-3 text-[13px] font-medium transition-colors sm:px-4 sm:text-[14px] ${i === index ? 'text-text' : 'text-muted hover:text-text-2'}`}
            >
              {i === index && <motion.span layoutId="tab-pill" className="absolute inset-0 -z-10 rounded-lg border border-line-2 bg-raised" transition={{ duration: 0.3, ease }} />}
              {s.label}
            </button>
          ))}
        </div>
        <div className="relative grid min-h-[44px] w-full max-w-[560px] text-center text-[14px] text-text-2">
          <AnimatePresence initial={false}>
            <motion.p
              key={scenario.id}
              className="col-start-1 row-start-1"
              initial={{ opacity: 0, y: 6, filter: 'blur(2px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -6, filter: 'blur(2px)' }}
              transition={{ duration: 0.3, ease }}
            >
              {scenario.caption}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>

      <div className="mt-8 flex flex-col items-center gap-6 lg:flex-row lg:items-center lg:gap-0">
        <div className="order-2 w-full max-w-[560px] lg:order-1 lg:max-w-none lg:flex-1">
          <p className="mb-2 font-mono text-[11px] text-muted">Your PC</p>
          <Pc state={demo.state} />
        </div>
        <div className="relative order-1 hidden h-px w-24 shrink-0 overflow-hidden bg-line lg:order-2 lg:block xl:w-32" aria-hidden>
          <motion.div
            key={demo.state.pulse}
            className="absolute inset-0"
            initial={{ x: '-100%', opacity: 0 }}
            animate={{ x: '0%', opacity: [0, 1, 1, 0] }}
            transition={{ duration: 0.7, ease }}
          >
            <span className="absolute right-0 top-1/2 h-[3px] w-10 -translate-y-1/2 rounded-full bg-accent" />
          </motion.div>
        </div>
        <div className="order-1 lg:order-3">
          <p className="mb-2 text-center font-mono text-[11px] text-muted lg:text-left">Your phone</p>
          <Phone {...demo} />
        </div>
      </div>
    </div>
  )
}
