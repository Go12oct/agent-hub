import { AnimatePresence, motion } from 'motion/react'
import type { DemoState, LineKind } from './engine'
import { Mark, ease } from './ui'

const tone: Record<LineKind, string> = {
  cmd: 'text-text', out: 'text-text-2', dim: 'text-muted', warn: 'text-accent', ok: 'text-ok', bad: 'text-bad', user: 'text-devin',
}
const prefix: Partial<Record<LineKind, string>> = { cmd: '>', ok: '✓', bad: '✕', warn: '!', user: '↳' }

export function Pc({ state }: { state: DemoState }) {
  return (
    <div className="w-full overflow-hidden rounded-2xl border border-line-2 bg-card shadow-[0_30px_80px_rgb(0_0_0/0.35)]">
      <div className="flex h-10 items-center gap-3 border-b border-line px-4">
        <Mark agent={state.pcAgent} size={18} />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={state.pcTitle}
            className="truncate text-[13px] text-text-2"
            initial={{ opacity: 0, filter: 'blur(2px)' }}
            animate={{ opacity: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, filter: 'blur(2px)' }}
            transition={{ duration: 0.2, ease }}
          >
            {state.pcTitle}
          </motion.span>
        </AnimatePresence>
        <span className="ml-auto flex items-center gap-4 font-mono text-[12px] text-muted" aria-hidden>
          <span>—</span><span>▢</span><span>✕</span>
        </span>
      </div>
      <div className="flex h-[230px] flex-col justify-end gap-1.5 overflow-hidden px-4 py-4 font-mono text-[12.5px] leading-5 sm:h-[300px] sm:px-5 sm:text-[13px]">
        {state.lines.map((line) => (
          <motion.div
            key={line.id}
            layout="position"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease, layout: { duration: 0.3, ease } }}
            className={`flex gap-2.5 ${tone[line.kind]}`}
          >
            <span className="w-3 shrink-0 text-muted">{prefix[line.kind] ?? ''}</span>
            <span className="min-w-0 break-words">{line.text}</span>
          </motion.div>
        ))}
        <div className="flex h-5 gap-2.5">
          <span className="w-3 shrink-0" />
          <AnimatePresence mode="wait" initial={false}>
            {state.thinking ? (
              <motion.span
                key={state.thinking}
                initial={{ opacity: 0, y: 8, filter: 'blur(2px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -8, filter: 'blur(2px)' }}
                transition={{ duration: 0.18, ease }}
                className="think"
                data-text={`${state.thinking}…`}
              >
                {state.thinking}…
              </motion.span>
            ) : (
              <motion.span key="caret" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-4 w-2 translate-y-0.5 bg-text-2/60" />
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
