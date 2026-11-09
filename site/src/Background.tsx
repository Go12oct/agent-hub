import { useEffect, useRef } from 'react'

export function Background() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const gap = 28
    let w = 0, h = 0, dpr = 1, raf = 0, last = 0
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
      const cx1 = w * (0.3 + 0.2 * Math.sin(s * 0.11)), cy1 = h * (0.35 + 0.15 * Math.cos(s * 0.09))
      const cx2 = w * (0.75 + 0.15 * Math.cos(s * 0.07)), cy2 = h * (0.7 + 0.1 * Math.sin(s * 0.13))
      for (let y = gap / 2; y < h; y += gap) {
        for (let x = gap / 2; x < w; x += gap) {
          const d1 = Math.hypot(x - cx1, y - cy1), d2 = Math.hypot(x - cx2, y - cy2)
          const wave = Math.max(0, Math.sin(d1 / 46 - s * 1.1)) * Math.exp(-d1 / 520) + Math.max(0, Math.sin(d2 / 52 - s * 0.9)) * Math.exp(-d2 / 460)
          const a = 0.08 + wave * 0.5
          ctx.fillStyle = wave > 0.55 ? `rgba(229,168,75,${a})` : `rgba(238,240,245,${a * 0.7})`
          ctx.fillRect(x - 1, y - 1, 2, 2)
        }
      }
    }
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop)
      if (t - last < 33) return
      last = t
      draw(t)
    }
    resize()
    window.addEventListener('resize', resize)
    if (reduce) draw(0)
    else raf = requestAnimationFrame(loop)
    const vis = () => { cancelAnimationFrame(raf); if (!document.hidden && !reduce) raf = requestAnimationFrame(loop) }
    document.addEventListener('visibilitychange', vis)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', vis) }
  }, [])
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
      <canvas ref={ref} className="absolute inset-0" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,transparent_30%,var(--color-bg)_95%)]" />
    </div>
  )
}
