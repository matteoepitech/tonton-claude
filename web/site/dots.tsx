// The page's background, seen only where nothing is written: a grid of small dots, and around the pointer the dots become
// little crosses, fading out with the distance. Whatever holds text sits on white over it. One canvas behind everything, drawn again only when the pointer moves or the window changes size; nothing to
// see for a screen reader, nothing that takes a click.
import { useEffect, useRef } from 'react'

/** Between two dots, in CSS pixels. */
const STEP = 18
/** How far from the pointer dots turn into crosses. */
const REACH = 110
const DOT = 'rgba(30, 29, 43, 0.16)'
/** The crosses, in the site's indigo. */
const CROSS = [91, 76, 245]

export function DotField() {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const node = canvas.current
    const context = node?.getContext('2d')
    if (!node || !context) return
    let pointer: { x: number; y: number } | null = null
    let frame = 0

    const draw = () => {
      frame = 0
      const width = window.innerWidth
      const height = window.innerHeight
      context.clearRect(0, 0, width, height)
      for (let y = STEP / 2; y < height; y += STEP) {
        for (let x = STEP / 2; x < width; x += STEP) {
          const distance = pointer ? Math.hypot(x - pointer.x, y - pointer.y) : Number.POSITIVE_INFINITY
          if (distance < REACH) {
            // Closer: a larger, darker cross.
            const near = 1 - distance / REACH
            const arm = 1.5 + near * 2.5
            context.strokeStyle = `rgba(${CROSS.join(',')}, ${0.2 + near * 0.5})`
            context.lineWidth = 1.2
            context.beginPath()
            context.moveTo(x - arm, y - arm)
            context.lineTo(x + arm, y + arm)
            context.moveTo(x + arm, y - arm)
            context.lineTo(x - arm, y + arm)
            context.stroke()
          } else {
            context.fillStyle = DOT
            context.fillRect(x - 0.75, y - 0.75, 1.5, 1.5)
          }
        }
      }
    }
    const redraw = () => {
      if (!frame) frame = requestAnimationFrame(draw)
    }
    const resize = () => {
      const ratio = window.devicePixelRatio || 1
      node.width = Math.round(window.innerWidth * ratio)
      node.height = Math.round(window.innerHeight * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      redraw()
    }
    const move = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY }
      redraw()
    }
    const leave = () => {
      pointer = null
      redraw()
    }
    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', move, { passive: true })
    document.documentElement.addEventListener('pointerleave', leave)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', move)
      document.documentElement.removeEventListener('pointerleave', leave)
    }
  }, [])
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10">
      <canvas ref={canvas} className="size-full" />
    </div>
  )
}
