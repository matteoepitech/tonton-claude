// The small panels behind the icon bar: hero upgrades bought with sparks, the arena (played in the Mac app), the team
// standings (in each pool) and the achievements that grant boosters.
import { SwordsIcon, UsersIcon } from 'lucide-react'
import { claimRPGMilestones, RPG_UPGRADES, type RPGState, rpgMilestones, rpgStats, upgradeRPG } from '../../../shared'
import { number } from '../../hero'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { cn } from '../ui/cn'

type Change = (apply: (hero: RPGState) => RPGState) => Promise<RPGState | null>

const UPGRADE_LABELS = { health: 'Health', attack: 'Attack', movement: 'Movement' } as const
const UPGRADE_STEPS = { health: 15, attack: 3, movement: 6 } as const
const MAX_RANK = 10

export function Upgrades({ hero, busy, change }: { hero: RPGState; busy: boolean; change: Change }) {
  const stats = rpgStats(hero)
  return (
    <section className="flex flex-col gap-2" aria-label="Hero upgrades">
      <p className="text-sm text-muted-foreground">
        Sparks buy permanent ranks for the arena. You have {number(hero.sparks)} {hero.sparks === 1 ? 'spark' : 'sparks'}.
      </p>
      {RPG_UPGRADES.map(stat => {
        const rank = hero.upgrades[stat] ?? 0
        const cost = (rank + 1) * 10
        return (
          <div key={stat} className="flex flex-wrap items-center gap-3 rounded-lg border bg-white p-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {UPGRADE_LABELS[stat]} {stats[stat]}
                {rank < MAX_RANK && <span className="text-muted-foreground"> → {stats[stat] + UPGRADE_STEPS[stat]}</span>}
              </p>
              <div className="mt-1 flex gap-0.5" role="img" aria-label={`Rank ${rank} of ${MAX_RANK}`}>
                {Array.from({ length: MAX_RANK }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: ten fixed pips.
                  <span key={i} className={cn('h-1.5 w-3 rounded-[1px]', i < rank ? 'bg-primary' : 'bg-border')} />
                ))}
              </div>
            </div>
            <Button
              size="sm"
              disabled={busy || rank === MAX_RANK || hero.sparks < cost}
              onClick={() => void change(h => upgradeRPG(h, stat, rank + 1))}
            >
              {rank === MAX_RANK ? 'Highest rank' : `Upgrade · ${cost} sparks`}
            </Button>
          </div>
        )
      })}
    </section>
  )
}

export function Arena({ hero }: { hero: RPGState }) {
  const stats = rpgStats(hero)
  return (
    <section className="flex flex-col items-start gap-3 rounded-lg border bg-white p-4" aria-label="Arena">
      <span className="icon-tile size-8">
        <SwordsIcon className="size-4" aria-hidden="true" />
      </span>
      <p className="text-sm">
        Play the arena in the Mac app: open Tonton in the notch, then <strong>Arena</strong>. Victories, bosses and boosters sync here.
      </p>
      <p className="text-sm text-muted-foreground">
        Health {stats.health} · attack {stats.attack} · movement {stats.movement}
      </p>
    </section>
  )
}

export function Team() {
  const store = useStore()
  return (
    <section className="flex flex-col items-start gap-3 rounded-lg border bg-white p-4" aria-label="Team">
      <span className="icon-tile size-8">
        <UsersIcon className="size-4" aria-hidden="true" />
      </span>
      <p className="text-sm">
        Each pool ranks its members by the work they finished, and shares goals that give everyone who helped a booster. It lives in the
        pool's <strong>Leaderboard</strong> tab.
      </p>
      <Button variant="outline" size="sm" onClick={() => store.setMode('pools')}>
        Open the pools
      </Button>
    </section>
  )
}

const MILESTONES: Record<string, string> = {
  rpgWorker: 'Team player · 10 work rewards',
  rpgVeteran: 'Veteran Tonton · 1,000 XP',
  rpgBoss: 'Boss slayer · first victory',
}

export function Achievements({ hero, busy, change }: { hero: RPGState; busy: boolean; change: Change }) {
  const milestones = rpgMilestones(hero)
  const claimable = claimRPGMilestones(hero) !== hero
  return (
    <section className="flex flex-col gap-3" aria-label="Achievements">
      {milestones.map(m => (
        <div key={m.id} className="space-y-1">
          <p className="flex justify-between text-sm">
            <span>{MILESTONES[m.id] ?? m.id}</span>
            <span className="tabular-nums text-muted-foreground">
              {number(Math.min(m.done, m.target))}/{number(m.target)}
            </span>
          </p>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-border"
            role="progressbar"
            aria-label={MILESTONES[m.id] ?? m.id}
            aria-valuemin={0}
            aria-valuemax={m.target}
            aria-valuenow={Math.min(m.done, m.target)}
          >
            <div className="h-full bg-primary" style={{ width: `${Math.min(100, (m.done / m.target) * 100)}%` }} />
          </div>
        </div>
      ))}
      <Button className="self-start" disabled={busy || !claimable} onClick={() => void change(claimRPGMilestones)}>
        {claimable ? 'Claim achievement boosters' : 'Nothing to claim'}
      </Button>
    </section>
  )
}
