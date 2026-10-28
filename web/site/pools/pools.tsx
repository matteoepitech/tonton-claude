// The pools of the account: the list (a right-click opens a pool on a tab, leaves or deletes it), a new pool, joining
// with an invite, and a pool's page. Everything a pool says is opened in this page with keys the relay never gets
// (shared/pool-watch.ts).
import {
  ArrowRightIcon,
  LinkIcon,
  ListTodoIcon,
  LogOutIcon,
  NetworkIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
  UsersIcon,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { type PoolRole, poolAbilities } from '../../../shared'
import { Empty, Loading, Problem } from '../common'
import { plural } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { cn } from '../ui/cn'
import { type Action, ContextMenu } from '../ui/context-menu'
import { Confirm } from '../ui/dialog'
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
    <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[260px_1fr]">
      <nav className={cn('glass flex flex-col gap-1 overflow-y-auto rounded-2xl border p-2', view && 'hidden md:flex')}>
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
          <PoolItem key={summary.id} id={summary.id} role={summary.role} name={info?.name ?? 'A pool'}>
            <button
              type="button"
              onClick={() => store.showPool({ kind: 'pool', id: summary.id })}
              className={cn(
                'flex w-full flex-col rounded-xl px-3 py-2 text-left transition-colors hover:bg-accent',
                view?.kind === 'pool' && view.id === summary.id && 'bg-accent',
              )}
            >
              <strong className="truncate font-medium">{info?.name ?? 'A pool'}</strong>
              <small className="text-xs text-muted-foreground">
                {roleLabel(summary.role)} · {plural(summary.members, 'member')}
                {summary.paused ? ' · paused' : ''}
              </small>
            </button>
          </PoolItem>
        ))}
        {watch.problem && <Problem>{watch.problem}</Problem>}
      </nav>
      <main className={cn('glass flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border', !view && 'hidden md:flex')}>
        {view?.kind === 'pool' ? (
          <PoolPage poolId={view.id} />
        ) : view?.kind === 'new' ? (
          <NewPool />
        ) : view?.kind === 'join' ? (
          <JoinPool invite={view.invite} />
        ) : (
          <Empty className="m-auto font-serif text-2xl text-muted-foreground">Pick a pool, or make one.</Empty>
        )}
      </main>
    </div>
  )
}

/**
 * A pool of the list, with its right-click menu: open it on a tab, copy its link, and leave or delete it, each asked
 * first. What the relay lets the member do decides what shows.
 */
function PoolItem({ id, role, name, children }: { id: string; role: PoolRole; name: string; children: ReactNode }) {
  const store = useStore()
  const can = poolAbilities(role)
  const [asking, setAsking] = useState<'leave' | 'delete' | null>(null)
  const open = (tab?: string) => store.showPool({ kind: 'pool', id }, tab)
  const actions: Action[] = [
    { label: 'Open', icon: ArrowRightIcon, onSelect: () => open() },
    { label: 'Tasks', icon: ListTodoIcon, onSelect: () => open('tasks') },
    { label: 'Team', icon: UsersIcon, onSelect: () => open('team') },
    { label: 'Control center', icon: NetworkIcon, onSelect: () => open('control') },
    { label: 'Settings', icon: SettingsIcon, onSelect: () => open('settings') },
    null,
    {
      label: 'Copy link',
      icon: LinkIcon,
      onSelect: () => void navigator.clipboard?.writeText(`${location.origin}${location.pathname}#pool=${id}`).catch(() => {}),
    },
    null,
    can.leave ? { label: 'Leave the pool', icon: LogOutIcon, destructive: true, onSelect: () => setAsking('leave') } : null,
    can.remove ? { label: 'Delete the pool', icon: Trash2Icon, destructive: true, onSelect: () => setAsking('delete') } : null,
  ]
  const leaveOrDelete = async () => {
    const done = asking === 'delete' ? await store.pools?.remove(id) : await store.pools?.leave(id)
    if (done && store.poolView?.kind === 'pool' && store.poolView.id === id) store.showPool(null)
  }
  return (
    <>
      <ContextMenu actions={actions}>{children}</ContextMenu>
      <Confirm
        open={asking !== null}
        onOpenChange={next => !next && setAsking(null)}
        title={asking === 'delete' ? `Delete ${name}?` : `Leave ${name}?`}
        description={
          asking === 'delete'
            ? 'For everyone: its tasks, notes and messages go, and every machine leaves it. This cannot be undone.'
            : 'Your machines and sessions leave it with you. You need a new invite to come back.'
        }
        action={asking === 'delete' ? 'Delete' : 'Leave'}
        onConfirm={() => void leaveOrDelete()}
      />
    </>
  )
}
