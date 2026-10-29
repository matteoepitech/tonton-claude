// A few squares in the site's indigo, staggered like the pixels at the corners of Lightdash's sections: a mark on a page's
// corner, nothing a reader needs.
import { cn } from './ui/cn'

/** Column, row and shade of each square, on a grid of 18-pixel cells. */
const SQUARES: [number, number, string][] = [
  [0, 0, '#1b1464'],
  [2, 0, '#7d6cf7'],
  [3, 0, '#c9c2fb'],
  [1, 1, '#5b4cf5'],
  [2, 1, '#3a2bd1'],
]

export function Mosaic({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 72 36" className={cn('h-9 w-[72px]', className)} aria-hidden="true">
      {SQUARES.map(([x, y, color]) => (
        <rect key={`${x}-${y}`} x={x * 18} y={y * 18} width="18" height="18" fill={color} />
      ))}
    </svg>
  )
}
