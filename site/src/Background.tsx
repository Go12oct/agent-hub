import { useEffect, useRef } from 'react'

export const PULSE_EVENT = 'agenthub:pulse'

export function pulseBackground(el: Element | null) {
  if (!el) return
  const r = el.getBoundingClientRect()
  window.dispatchEvent(new CustomEvent(PULSE_EVENT, { detail: { x: r.left + r.width / 2, y: r.top + r.height / 2 } }))
}

export function Background() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const fine = window.matchMedia('(pointer: fine)').matches
    const gap = 28
    let w = 0, h = 0, dpr = 1, raf = 0
    const ptr = { x: -9999, y: -9999, tx: -9999, ty: -9999, k: 0, tk: 0 }
    const pulses: Array<{ x: number; y: number; t0: number }> = []

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = window.innerWidth; h = window.innerHeight
      canvas.width = w * dpr; canvas.height = h * dpr
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h)
      const s = t / 1000
      ptr.x += (ptr.tx - ptr.x) * 0.14; ptr.y += (ptr.ty - ptr.y) * 0.14; ptr.k += (ptr.tk - ptr.k) * 0.08
      while (pulses.length && t - pulses[0].t0 > 1800) pulses.shift()
      const cx1 = w * (0.3 + 0.2 * Math.sin(s * 0.11)), cy1 = h * (0.35 + 0.15 * Math.cos(s * 0.09))
      const cx2 = w * (0.75 + 0.15 * Math.cos(s * 0.07)), cy2 = h * (0.7 + 0.1 * Math.sin(s * 0.13))
      for (let y = gap / 2; y < h; y += gap) {
        for (let x = gap / 2; x < w; x += gap) {
          const d1 = Math.hypot(x - cx1, y - cy1), d2 = Math.hypot(x - cx2, y - cy2)
          let wave = Math.max(0, Math.sin(d1 / 46 - s * 1.1)) * Math.exp(-d1 / 520) + Math.max(0, Math.sin(d2 / 52 - s * 0.9)) * Math.exp(-d2 / 460)
          let px = x, py = y, warm = 0
          if (ptr.k > 0.01) {
            const dx = x - ptr.x, dy = y - ptr.y, dp = Math.hypot(dx, dy)
            if (dp < 180) {
              const f = (1 - dp / 180) ** 2 * ptr.k
              wave += f * 0.9
              if (dp > 0.5) { px += (dx / dp) * f * 7; py += (dy / dp) * f * 7 }
            }
          }
          for (const p of pulses) {
            const age = (t - p.t0) / 1800, r = age * 900
            const dd = Math.hypot(x - p.x, y - p.y) - r
            const ring = Math.exp(-(dd * dd) / 1800) * (1 - age)
            warm += ring
          }
          const a = Math.min(0.85, 0.08 + wave * 0.5 + warm * 0.7)
          ctx.fillStyle = wave > 0.55 || warm > 0.2 ? `rgba(229,168,75,${a})` : `rgba(238,240,245,${a * 0.7})`
          ctx.fillRect(px - 1, py - 1, 2, 2)
        }
      }
    }

    const loop = (t: number) => { draw(t); raf = requestAnimationFrame(loop) }
    const onMove = (e: PointerEvent) => { ptr.tx = e.clientX; ptr.ty = e.clientY; ptr.tk = 1; if (ptr.x < -999) { ptr.x = e.clientX; ptr.y = e.clientY } }
    const onLeave = () => { ptr.tk = 0 }
    const onPulse = (e: Event) => { const d = (e as CustomEvent<{ x: number; y: number }>).detail; pulses.push({ x: d.x, y: d.y, t0: performance.now() }) }
    const vis = () => { cancelAnimationFrame(raf); if (!document.hidden && !reduce) raf = requestAnimationFrame(loop) }

    resize()
    window.addEventListener('resize', resize)
    if (reduce) draw(0)
    else {
      raf = requestAnimationFrame(loop)
      if (fine) { window.addEventListener('pointermove', onMove, { passive: true }); document.documentElement.addEventListener('pointerleave', onLeave) }
      window.addEventListener(PULSE_EVENT, onPulse)
    }
    document.addEventListener('visibilitychange', vis)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      window.removeEventListener(PULSE_EVENT, onPulse)
      document.removeEventListener('visibilitychange', vis)
    }
  }, [])
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
      <canvas ref={ref} className="absolute inset-0" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,transparent_30%,var(--color-bg)_95%)]" />
    </div>
  )
}
