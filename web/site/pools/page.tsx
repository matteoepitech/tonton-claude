// A pool's page: its name, goal and countdown, then its tabs. The orchestrator's chat comes first: the admin runs the
// pool from there. Live: every change of the pool draws the page again, and forms keep what is being typed.
import { ArrowLeftIcon } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { countdown, type OpenPool, type PoolState } from '../../../shared'
import { Loading, Problem } from '../common'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Badge } from '../ui/card'
import { cn } from '../ui/cn'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'
import { Activity } from './activity'
import { Board } from './board'
import { ControlCenter } from './control'
import { Invites } from './invites'
import { Leaderboard } from './leaderboard'
import { Machines } from './machines'
import { Members } from './members'
import { Orchestrator } from './orchestrator'
import { roleLabel } from './roles'
import { Settings } from './settings'

export interface TabProps {
  pool: OpenPool
  state: PoolState
}

const TABS: { id: string; label: string; leads?: boolean; render(props: TabProps): ReactNode }[] = [
  { id: 'orchestrator', label: 'Orchestrator', render: props => <Orchestrator {...props} /> },
  { id: 'tasks', label: 'Tasks', render: props => <Board {...props} /> },
  { id: 'machines', label: 'Machines', render: props => <Machines {...props} /> },
  { id: 'control', label: 'Control center', render: props => <ControlCenter {...props} /> },
  { id: 'activity', label: 'Activity', render: props => <Activity {...props} /> },
  { id: 'leaderboard', label: 'Leaderboard', render: props => <Leaderboard {...props} /> },
  { id: 'members', label: 'Members', render: props => <Members {...props} /> },
  { id: 'invites', label: 'Invites', leads: true, render: props => <Invites {...props} /> },
  { id: 'settings', label: 'Settings', render: props => <Settings {...props} /> },
]

export function PoolPage({ poolId }: { poolId: string }) {
  const store = useStore()
  const watch = store.pools
  const pool = watch?.pool(poolId) ?? null
  const state = pool?.state ?? null
  const name = state?.info?.name ?? watch?.pools.find(listed => listed.summary.id === poolId)?.info?.name ?? 'A pool'
  const clock = useCountdown(state?.info?.deadline)
  const lead = pool?.role === 'owner' || pool?.role === 'admin'
  const tabs = TABS.filter(tab => !tab.leads || lead)
  const current = tabs.find(tab => tab.id === store.poolTab) ?? tabs[0]
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-2.5">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => store.showPool(null)} aria-label="Back to the pools">
          <ArrowLeftIcon />
        </Button>
        <span className="flex min-w-0 flex-col">
          <strong className="truncate">{name}</strong>
          {state?.info?.goal && <small className="truncate text-xs text-muted-foreground">{state.info.goal}</small>}
        </span>
        {pool && <Badge variant="secondary">{roleLabel(pool.role)}</Badge>}
        {state?.paused && <Badge variant="warning">Paused</Badge>}
        {clock && (
          <Badge
            variant={clock.ended || clock.left < 900_000 ? 'destructive' : 'outline'}
            title={`Deadline: ${new Date(state?.info?.deadline ?? '').toLocaleString()}`}
            className="ms-auto"
          >
            {clock.label}
          </Badge>
        )}
      </div>
      {!pool || !state ? (
        pool?.problem ? (
          <div className="p-4">
            <Problem>{pool.problem}</Problem>
          </div>
        ) : (
          <Loading>Opening the pool…</Loading>
        )
      ) : (
        <>
          <div className="border-b px-4 py-2">
            <Tabs value={current.id} onValueChange={tab => store.setPoolTab(tab)}>
              <TabsList className="max-w-full">
                {tabs.map(tab => (
                  <TabsTrigger key={tab.id} value={tab.id}>
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          {pool.problem && (
            <div className="px-4 pt-3">
              <Problem onDismiss={() => watch?.clearProblem(pool.id)}>{pool.problem}</Problem>
            </div>
          )}
          <div className={cn('flex min-h-0 flex-1 flex-col', current.id === 'orchestrator' ? '' : 'overflow-y-auto p-4')}>
            {current.render({ pool, state })}
          </div>
        </>
      )}
    </div>
  )
}

/** How long until the deadline, redrawn every 30 seconds while it runs. */
function useCountdown(deadline: string | undefined) {
  const [now, setNow] = useState(Date.now())
  const clock = countdown(deadline, now)
  const running = Boolean(clock && !clock.ended)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [running])
  return clock
}
