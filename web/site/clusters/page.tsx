// A cluster's page: its name and clock, the invite for the owner, then its tabs: who is there and doing what, the feed,
// the claims, the notes, the clock and the members. Live: every change of the cluster draws the page again.
import { ArrowLeftIcon, UserPlusIcon } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import type { ClusterState, OpenCluster, RPGState } from '../../../shared'
import { Loading, Problem } from '../common'
import { InviteResult } from '../pools/invites'
import { useHero } from '../rpg'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Badge } from '../ui/card'
import { cn } from '../ui/cn'
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from '../ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'
import { Claims, Notes } from './board'
import { Clock } from './clock'
import { Feed } from './feed'
import { Leaderboard, useShareHero } from './leaderboard'
import { Members } from './members'
import { clockView } from './model'
import { Roster } from './roster'

export interface ClusterTabProps {
  cluster: OpenCluster
  state: ClusterState
  /** This account's hero, null until read or when the relay has none. */
  hero?: RPGState | null
}

const TABS: { id: string; label: string; render(props: ClusterTabProps): ReactNode }[] = [
  { id: 'roster', label: 'Roster', render: props => <Roster {...props} /> },
  { id: 'feed', label: 'Feed', render: props => <Feed {...props} /> },
  { id: 'leaderboard', label: 'Leaderboard', render: props => <Leaderboard {...props} /> },
  { id: 'claims', label: 'Claims', render: props => <Claims {...props} /> },
  { id: 'notes', label: 'Notes', render: props => <Notes {...props} /> },
  { id: 'clock', label: 'Clock', render: props => <Clock {...props} /> },
  { id: 'members', label: 'Members', render: props => <Members {...props} /> },
]

export function ClusterPage({ clusterId }: { clusterId: string }) {
  const store = useStore()
  const watch = store.clusters
  const cluster = watch?.cluster(clusterId) ?? null
  const state = cluster?.state ?? null
  const name = state?.info?.name ?? watch?.clusters.find(listed => listed.summary.id === clusterId)?.info?.name ?? 'A cluster'
  const now = useNow(30_000)
  const { hero } = useHero()
  useShareHero(clusterId, hero)
  const clock = clockView(cluster?.clock ?? null, now)
  const current = TABS.find(tab => tab.id === store.clusterTab) ?? TABS[0]
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b bg-white px-4 py-3">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => store.showCluster(null)} aria-label="Back to the clusters">
          <ArrowLeftIcon />
        </Button>
        <span className="flex min-w-0 flex-col">
          <strong className="truncate text-2xl leading-tight font-bold tracking-tight">{name}</strong>
          {state?.info?.about && <small className="truncate text-xs text-muted-foreground">{state.info.about}</small>}
        </span>
        {cluster && <Badge variant="secondary">{cluster.role === 'owner' ? 'Owner' : 'Member'}</Badge>}
        <span className="ms-auto flex items-center gap-2">
          {clock.label && (
            <Badge
              variant={clock.ended || clock.lastHour ? 'destructive' : 'outline'}
              title={`Deadline: ${new Date(cluster?.clock?.deadline ?? '').toLocaleString()}`}
            >
              {clock.label}
            </Badge>
          )}
          {cluster?.role === 'owner' && state && <InviteButton clusterId={clusterId} />}
        </span>
      </div>
      {!cluster || !state ? (
        cluster?.problem ? (
          <div className="p-4">
            <Problem>{cluster.problem}</Problem>
          </div>
        ) : (
          <Loading>Opening the cluster…</Loading>
        )
      ) : (
        <>
          <div className="flex items-center gap-2 overflow-x-auto border-b bg-white px-4 py-2">
            <Tabs value={current.id} onValueChange={tab => store.setClusterTab(tab)}>
              <TabsList className="max-w-full">
                {TABS.map(tab => (
                  <TabsTrigger key={tab.id} value={tab.id}>
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          {cluster.problem && (
            <div className="px-4 pt-3">
              <Problem onDismiss={() => watch?.clearProblem(cluster.id)}>{cluster.problem}</Problem>
            </div>
          )}
          <div className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto p-4')}>{current.render({ cluster, state, hero })}</div>
        </>
      )}
    </div>
  )
}

/** The owner invites in one click: a link for up to 20 people over a week, with its QR code. */
function InviteButton({ clusterId }: { clusterId: string }) {
  const watch = useStore().clusters
  const [link, setLink] = useState<string | null | undefined>(undefined)
  const make = async () => {
    setLink(undefined)
    const made = await watch?.invite(clusterId, { uses: 20, hours: 168 })
    setLink(made?.link ?? null)
  }
  return (
    <Dialog onOpenChange={open => open && void make()}>
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlusIcon />
          Invite
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader
          title="Invite people"
          description="Send them this link, or let them scan the code. It holds the cluster key: send it to people you trust."
        />
        {link === undefined ? (
          <Loading>Making the invite…</Loading>
        ) : link ? (
          <InviteResult link={link} />
        ) : (
          <p className="text-sm">The invite could not be made: {watch?.problem ?? 'try again in a moment.'}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** The time, redrawn every `every` milliseconds. */
export function useNow(every: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(timer)
  }, [every])
  return now
}
