// Tonton as pixel art: a small robot head with its antenna, drawn in squares like the arcade the site takes after. One
// row per string, `#` filled in indigo, `o` the eyes, left white.
import { cn } from './ui/cn'

const ROWS = ['....#....', '....#....', '.#######.', '#########', '##o###o##', '##o###o##', '#########', '.##...##.', '.#######.']

export function PixelLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 9 9" shapeRendering="crispEdges" className={cn('size-6', className)} aria-hidden="true">
      {ROWS.flatMap((row, y) =>
        [...row].map((cell, x) =>
          cell === '.' ? null : (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing.
              key={`${x}-${y}`}
              x={x}
              y={y}
              width="1"
              height="1"
              className={cell === 'o' ? 'fill-white' : 'fill-primary'}
            />
          ),
        ),
      )}
    </svg>
  )
}
