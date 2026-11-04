// The leaderboard: the members ranked by the XP their Tonton earned since the cluster's clock started, or since they
// joined, each with its Tonton, its level and its XP today. Sharing is each member's own choice; a member who does not
// share appears without numbers. While this page is open, this member's entry follows its hero (useShareHero).
import { useEffect, useState } from 'react'
import { type ClusterRank, type RPGState, rankClusterHeroes } from '../../../shared'
import art from '../../../shared/rpg-art.json'
import { HeroAvatar } from '../rpg'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Badge } from '../ui/card'
import { cn } from '../ui/cn'
import { memberName } from './model'
import type { ClusterTabProps } from './page'

/** One title per ten levels, the same as the notch's (shared/rpg-art.json). */
export const heroTitle = (level: number): string => art.titles[Math.min(9, Math.max(0, Math.floor((level - 1) / 10)))]

/** Keeps this member's entry up to date while the cluster is open, if it shares its Tonton there. */
export function useShareHero(clusterId: string, hero: RPGState | null) {
  const watch = useStore().clusters
  const sharing = watch?.sharesHero(clusterId) ?? false
  // A new clock is ClusterWatch's to follow: it shares the entry again from its start.
  useEffect(() => {
    if (watch && hero && sharing) void watch.shareHero(clusterId, hero)
  }, [watch, clusterId, hero, sharing])
}

export function Leaderboard({ cluster, state, hero }: ClusterTabProps) {
  const store = useStore()
  const watch = store.clusters
  const [busy, setBusy] = useState(false)
  const sharing = watch?.sharesHero(cluster.id) ?? false
  const ranks = rankClusterHeroes(cluster.leaderboard, state.members)
  const toggle = async () => {
    if (!watch) return
    setBusy(true)
    await watch.shareHero(cluster.id, sharing ? null : (hero ?? null))
    setBusy(false)
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <small className="text-xs text-muted-foreground">
          XP since {cluster.clock?.startedAt ? 'the clock started' : 'each member joined'}. Only the level, the look and the XP are shared,
          never what the work was.
        </small>
        <Button
          size="sm"
          variant={sharing ? 'outline' : 'default'}
          className="ms-auto"
          disabled={busy || (!sharing && !hero)}
          onClick={() => void toggle()}
        >
          {sharing ? 'Stop sharing my Tonton' : 'Share my Tonton here'}
        </Button>
      </div>
      <LeaderboardList ranks={ranks} state={state} account={store.account} />
    </div>
  )
}

/** The ranked members, without the store: what the tab shows, and what web/test renders. */
export function LeaderboardList({
  ranks,
  state,
  account,
}: {
  ranks: ClusterRank[]
  state: ClusterTabProps['state']
  account: string | null
}) {
  return (
    <ol className="flex flex-col gap-2">
      {ranks.map(rank => (
        <Row key={rank.account} rank={rank} name={memberName(state, rank.account)} you={rank.account === account} />
      ))}
    </ol>
  )
}

function Row({ rank, name, you }: { rank: ClusterRank; name: string; you: boolean }) {
  const hero = rank.hero
  return (
    <li className={cn('raised flex items-center gap-3 rounded-lg border bg-white px-3 py-2', !hero && 'opacity-70')}>
      <span className="w-6 text-center text-lg font-bold tabular-nums text-muted-foreground">{rank.rank ?? '–'}</span>
      <span className={cn(!hero && 'opacity-40 grayscale')}>
        <HeroAvatar equipped={hero?.equipped ?? {}} size={40} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-2">
          <strong className="truncate">{name}</strong>
          {you && <Badge variant="secondary">You</Badge>}
        </span>
        {hero ? (
          <small className="text-xs text-muted-foreground">
            Level {hero.level} · {heroTitle(hero.level)}
          </small>
        ) : (
          <small className="text-xs text-muted-foreground">Doesn't share its Tonton</small>
        )}
      </span>
      {hero && (
        <span className="ms-auto flex flex-col items-end">
          <strong className="tabular-nums">{hero.since.toLocaleString()} XP</strong>
          <small className="text-xs text-muted-foreground tabular-nums">+{rank.today.toLocaleString()} today</small>
        </span>
      )}
    </li>
  )
}
