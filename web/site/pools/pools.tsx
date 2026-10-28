// The pools of the account: the list, a new pool, joining with an invite, and a pool's page. Everything a pool says is
// opened in this page with keys the relay never gets (shared/pool-watch.ts).
import { PlusIcon, UsersIcon } from 'lucide-react'
import { Empty, Loading, Problem } from '../common'
import { plural } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { cn } from '../ui/cn'
import { JoinPool, NewPool } from './forms'
import { PoolPage } from './page'
import { roleLabel } from './roles'

export function Pools() {
  const store = useStore()
  const watch = store.pools
  const view = store.poolView
  if (!watch) {
    return store.poolsProblem ? (
      <div className="p-4">
        <Problem>{store.poolsProblem}</Problem>
      </div>
    ) : (
      <Loading>Opening the pools…</Loading>
    )
  }
  return (
    <div className="grid min-h-0 flex-1 md:grid-cols-[280px_1fr]">
      <nav className={cn('flex flex-col gap-1 overflow-y-auto border-e p-2', view && 'hidden md:flex')}>
        <div className="flex gap-2 p-1">
          <Button size="sm" onClick={() => store.showPool({ kind: 'new' })}>
            <PlusIcon />
            New pool
          </Button>
          <Button size="sm" variant="outline" title="Join a pool with an invite" onClick={() => store.showPool({ kind: 'join' })}>
            <UsersIcon />
            Join
          </Button>
        </div>
        <h2 className="mt-2 px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Pools</h2>
        {!watch.pools.length && <Empty>No pools yet. Make one, or join with an invite from a teammate.</Empty>}
        {watch.pools.map(({ summary, info }) => (
          <button
            type="button"
            key={summary.id}
            onClick={() => store.showPool({ kind: 'pool', id: summary.id })}
            className={cn(
              'flex flex-col rounded-lg px-2 py-2 text-left hover:bg-accent',
              view?.kind === 'pool' && view.id === summary.id && 'bg-accent',
            )}
          >
            <strong className="truncate font-medium">{info?.name ?? 'A pool'}</strong>
            <small className="text-xs text-muted-foreground">
              {roleLabel(summary.role)} · {plural(summary.members, 'member')}
              {summary.paused ? ' · paused' : ''}
            </small>
          </button>
        ))}
        {watch.problem && <Problem>{watch.problem}</Problem>}
      </nav>
      <main className={cn('flex min-h-0 min-w-0 flex-col', !view && 'hidden md:flex')}>
        {view?.kind === 'pool' ? (
          <PoolPage poolId={view.id} />
        ) : view?.kind === 'new' ? (
          <NewPool />
        ) : view?.kind === 'join' ? (
          <JoinPool invite={view.invite} />
        ) : (
          <Empty className="m-auto">Pick a pool, or make one.</Empty>
        )}
      </main>
    </div>
  )
}
