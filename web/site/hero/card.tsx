// The hero card, in the notch's layout: Tonton in his segmented level ring on the left, the level in a capsule on its
// edge; on the right his title, what the next level needs, today's XP, the streak over the last seven days and a bar
// per hour. A gain floats into the ring; a level-up bursts around it. Neither plays with reduced motion.
import { FlameIcon, ZapIcon } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { type RPGItem, type RPGState, rpgToday } from '../../../shared'
import {
  currentHour,
  type HeroGain,
  type HeroPose,
  heroProgress,
  hourBars,
  hoursSummary,
  number,
  progressText,
  RARITY_LABELS,
  ringSegments,
  SLOT_LABELS,
  streakSquares,
  streakText,
} from '../../hero'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { cn } from '../ui/cn'
import { HeroAvatar } from './avatar'
import { useReducedMotion } from './motion'

const RING = 112
const STROKE = 7
const RADIUS = RING / 2 - STROKE / 2 - 1

/** A gain to show, with what makes it a new one each time. */
export interface ShownGain extends HeroGain {
  key: number
}

interface Props {
  hero: RPGState
  pose: HeroPose
  preview: RPGItem | null
  gain: ShownGain | null
  now: number
  onWear: () => void
  onCancelPreview: () => void
  busy: boolean
  children?: ReactNode
}

export function HeroCard({ hero, pose, preview, gain, now, onWear, onCancelPreview, busy, children }: Props) {
  const progress = heroProgress(hero.xp)
  const equipped = preview ? { ...hero.equipped, [preview.slot]: preview.id } : hero.equipped
  const owned = preview ? hero.owned.includes(preview.id) : false
  const wearing = preview ? hero.equipped[preview.slot] === preview.id : false
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-4">
        <LevelRing level={progress.level} fraction={progress.fraction} gain={gain}>
          <HeroAvatar equipped={equipped} pose={pose} moving size={72} label={`Tonton, level ${progress.level}`} />
        </LevelRing>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold tracking-tight">Tonton</h1>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">{progress.title}</span>
          </div>
          <p className="text-sm text-muted-foreground" title={`${number(hero.xp)} XP · ${number(hero.sparks)} sparks`}>
            {progressText(progress)}
          </p>
          <Today hero={hero} now={now} />
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {gain ? `${number(gain.xp)} XP earned${gain.level ? `, level ${gain.level} reached` : ''}.` : ''}
      </p>
      {preview && (
        <div className="flex flex-wrap items-center gap-2 border-t border-dashed pt-3 text-sm">
          <span className="me-auto">
            Trying on: {RARITY_LABELS[preview.rarity]} {SLOT_LABELS[preview.slot].toLowerCase()}
            {owned ? '' : ' · locked'}
          </span>
          <Button size="sm" disabled={busy || !owned} onClick={onWear}>
            {wearing ? 'Take off' : owned ? 'Wear it' : 'Find it in a booster'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancelPreview}>
            Cancel
          </Button>
        </div>
      )}
      {children}
    </Card>
  )
}

function LevelRing({ level, fraction, gain, children }: { level: number; fraction: number; gain: ShownGain | null; children: ReactNode }) {
  const reduced = useReducedMotion()
  const segments = ringSegments(RADIUS, fraction)
  return (
    <div className="relative shrink-0" style={{ width: RING, height: RING }}>
      <svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle
          cx={RING / 2}
          cy={RING / 2}
          r={RADIUS}
          fill="none"
          stroke="var(--border)"
          strokeWidth={STROKE}
          strokeDasharray={segments.track}
        />
        <circle
          cx={RING / 2}
          cy={RING / 2}
          r={RADIUS}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={STROKE}
          strokeDasharray={segments.fill}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
      <span
        className="absolute -bottom-1 left-1/2 min-w-7 -translate-x-1/2 rounded-full border-2 border-white bg-primary px-2 text-center text-sm font-bold tabular-nums text-white"
        title={`Level ${level}`}
      >
        {level}
      </span>
      {gain && !reduced && (
        <span key={gain.key} className="hero-float pointer-events-none absolute left-1/2 top-1/2 text-base font-bold text-primary">
          +{number(gain.xp)}
        </span>
      )}
      {gain?.level && !reduced && <Burst key={`burst-${gain.key}`} />}
    </div>
  )
}

/** Today's XP, the streak with its last seven days, and a bar per hour, the current one in full. */
function Today({ hero, now }: { hero: RPGState; now: number }) {
  const today = rpgToday(hero, now)
  const bars = hourBars(today.hours, today.day)
  const peak = Math.max(1, ...bars.map(bar => bar.xp))
  const hour = currentHour(today.day, now)
  return (
    <>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="flex items-center gap-1 font-semibold">
          <ZapIcon className="size-3.5 text-warning" aria-hidden="true" />+{number(today.xp)} XP today
        </span>
        <span className={cn('flex items-center gap-1', today.streak ? 'font-semibold' : 'text-muted-foreground')}>
          <FlameIcon className="size-3.5 text-orange" aria-hidden="true" />
          {today.streak ? streakText(today.streak) : 'No streak yet'}
        </span>
        <span className="flex gap-0.5" role="img" aria-label={`Last seven days: ${streakText(today.streak)}`}>
          {streakSquares(hero, today.streak, now).map((lit, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: seven fixed days.
            <span key={i} className={cn('size-2 rounded-[2px]', lit ? 'bg-orange' : 'bg-border')} />
          ))}
        </span>
      </p>
      <div className="flex h-7 items-end gap-px" role="img" aria-label={hoursSummary(bars)}>
        {bars.map(bar => (
          <span
            key={bar.hour}
            title={`${bar.label} · +${number(bar.xp)} XP`}
            className={cn('flex-1 rounded-t-[1px]', bar.xp ? 'bg-primary' : 'bg-border', bar.xp && bar.hour !== hour && 'opacity-55')}
            style={{ height: bar.xp ? `${Math.max(15, (bar.xp / peak) * 100)}%` : '2px' }}
          />
        ))}
      </div>
    </>
  )
}

/** Eight pixels thrown out of the ring once. */
function Burst() {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0">
      {Array.from({ length: 8 }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: eight fixed particles, never reordered.
          key={i}
          className="hero-burst absolute left-1/2 top-1/2 size-1.5"
          style={{ '--angle': `${i * 45}deg`, background: i % 2 ? 'var(--primary)' : '#ffcf66' } as CSSProperties}
        />
      ))}
    </span>
  )
}
