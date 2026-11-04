// Tonton in the 24 × 24 art of shared/rpg-art.json, as an SVG of crisp rectangles: the hero card, the wardrobe's tiles,
// a reveal and the pool standings. Each run of one color in a row is one rectangle.
import { useMemo } from 'react'
import type { RPGSlot } from '../../../shared'
import { HERO_ART, type HeroPose, heroPixels, heroRuns } from '../../hero'
import { usePoseTick, useReducedMotion } from './motion'

export interface HeroAvatarProps {
  equipped: Partial<Record<RPGSlot, string>>
  size?: number
  pose?: HeroPose
  /** Plays the pose's frames, unless the reader asked for reduced motion. Tiles stay still. */
  moving?: boolean
  label?: string
  className?: string
}

export function HeroAvatar({
  equipped,
  size = 48,
  pose = 'idle',
  moving = false,
  label = "Tonton's equipped appearance",
  className,
}: HeroAvatarProps) {
  const reduced = useReducedMotion()
  const tick = usePoseTick(pose, moving && !reduced)
  const runs = useMemo(() => heroRuns(heroPixels(equipped, pose, tick)), [equipped, pose, tick])
  const pixels = runs.map(run => <rect key={`${run.x}-${run.y}`} x={run.x} y={run.y} width={run.width} height={1} fill={run.color} />)
  const box = `0 0 ${HERO_ART.size} ${HERO_ART.size}`
  // An empty label: what is around it says what it is.
  if (!label)
    return (
      <svg viewBox={box} width={size} height={size} aria-hidden="true" shapeRendering="crispEdges" className={className}>
        {pixels}
      </svg>
    )
  return (
    <svg viewBox={box} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges" className={className}>
      {pixels}
    </svg>
  )
}
