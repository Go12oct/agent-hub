import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { ease } from './demo/ui'

export interface Beat { time: string; title: string; body: string; shot: string; alt: string }

function DeviceFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative aspect-[9/20] w-full max-w-[300px] rounded-[44px] border border-line-2 bg-deep p-2.5 shadow-[0_40px_120px_rgb(0_0_0/0.55)]">
      <div className="relative h-full overflow-hidden rounded-[34px] bg-bg">{children}</div>
    </div>
  )
}

function Shot({ beat, eager }: { beat: Beat; eager?: boolean }) {
  return <img src={beat.shot} alt={beat.alt} width={1080} height={2400} loading={eager ? 'eager' : 'lazy'} decoding="async" className="absolute inset-0 size-full object-cover object-top" />
}

export function Story({ beats }: { beats: Beat[] }) {
  const [active, setActive] = useState(0)
  const refs = useRef<Array<HTMLLIElement | null>>([])
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i)) }),
      { rootMargin: '-45% 0px -45% 0px' },
    )
    refs.current.forEach((el) => el && io.observe(el))
    return () => io.disconnect()
  }, [])
  const beat = beats[active]
  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-20">
      <ol className="grid">
        {beats.map((b, i) => (
          <li
            key={b.time}
            ref={(el) => { refs.current[i] = el }}
            data-i={i}
            className="flex flex-col justify-center border-l border-line py-10 pl-6 lg:min-h-[640px] lg:py-0 lg:pl-8"
          >
            <div className={`transition-opacity duration-500 ${i === active ? 'lg:opacity-100' : 'lg:opacity-35'}`}>
              <p className={`font-mono text-[13px] tnum transition-colors duration-500 ${i === active ? 'text-accent' : 'text-muted'}`}>{b.time}</p>
              <h3 className="mt-3 max-w-[440px] text-[26px] font-medium leading-tight tracking-[-0.02em] sm:text-[30px]">{b.title}</h3>
              <p className="mt-3 max-w-[460px] text-[16px] leading-relaxed text-text-2">{b.body}</p>
            </div>
            <div className="mt-8 flex justify-center lg:hidden"><DeviceFrame><Shot beat={b} /></DeviceFrame></div>
          </li>
        ))}
      </ol>
      <div className="hidden lg:block">
        <div className="sticky top-[max(24px,calc(50vh-333px))] flex justify-center">
          <DeviceFrame>
            <AnimatePresence initial={false}>
              <motion.div
                key={beat.shot}
                className="absolute inset-0"
                initial={{ opacity: 0, scale: 1.015 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.45, ease }}
              >
                <Shot beat={beat} eager />
              </motion.div>
            </AnimatePresence>
          </DeviceFrame>
        </div>
      </div>
    </div>
  )
}
