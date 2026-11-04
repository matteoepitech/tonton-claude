// The clusters of the account: the list (a right-click leaves or deletes one), a new cluster, joining with an invite, and
// a cluster's page. Everything a cluster says is opened in this page with keys the relay never gets
// (shared/cluster-watch.ts). Apps never post: people read the feed, and their own Claudes do the talking.
import { LogOutIcon, NetworkIcon, PlusIcon, Trash2Icon, UsersIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { ClusterRole } from '../../../shared'
import { Empty, Loading, Problem } from '../common'
import { plural } from '../format'
import { Mosaic } from '../mosaic'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { cn } from '../ui/cn'
import { type Action, ContextMenu } from '../ui/context-menu'
import { Confirm } from '../ui/dialog'
import { JoinCluster, NewCluster } from './forms'
import { ClusterPage } from './page'

export function Clusters() {
  const store = useStore()
  const watch = store.clusters
  const view = store.clusterView
  if (!watch) {
    return store.clustersProblem ? (
      <div className="p-4">
        <Problem>{store.clustersProblem}</Problem>
      </div>
    ) : (
      <Loading>Opening the clusters…</Loading>
    )
  }
  if (!watch.supported) {
    return (
      <div className="p-4">
        <Problem>{watch.problem}</Problem>
      </div>
    )
  }
  return (
    <div className="grid min-h-0 flex-1 md:grid-cols-[260px_1fr]">
      <nav className={cn('rule-dashed flex flex-col gap-1 overflow-y-auto border-e bg-white p-2', view && 'hidden md:flex')}>
        <div className="flex gap-2 p-1">
          <Button size="sm" onClick={() => store.showCluster({ kind: 'new' })}>
            <PlusIcon />
            New cluster
          </Button>
          <Button size="sm" variant="outline" title="Join a cluster with an invite" onClick={() => store.showCluster({ kind: 'join' })}>
            <UsersIcon />
            Join
          </Button>
        </div>
        <h2 className="eyebrow mt-3 px-2">Clusters</h2>
        {!watch.clusters.length && <Empty>No clusters yet. Make one so the Claudes of several people talk, or join with an invite.</Empty>}
        {watch.clusters.map(({ summary, info }) => (
          <ClusterItem key={summary.id} id={summary.id} role={summary.role} name={info?.name ?? 'A cluster'}>
            <button
              type="button"
              onClick={() => store.showCluster({ kind: 'cluster', id: summary.id })}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:bg-white',
                view?.kind === 'cluster' && view.id === summary.id && 'raised border-border bg-white',
              )}
            >
              <span className="icon-tile size-8 text-sm font-bold">
                <NetworkIcon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-col">
                <strong className="truncate font-medium">{info?.name ?? 'A cluster'}</strong>
                <small className="text-xs text-muted-foreground">
                  {summary.role === 'owner' ? 'Owner' : 'Member'} · {plural(summary.members, 'member')}
                </small>
              </span>
            </button>
          </ClusterItem>
        ))}
        {watch.problem && view?.kind !== 'new' && view?.kind !== 'join' && (
          <Problem onDismiss={() => watch.clearProblem()}>{watch.problem}</Problem>
        )}
        <Mosaic className="mt-auto ms-1 mb-1 opacity-90" />
      </nav>
      <main className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden', view && 'bg-white', !view && 'hidden md:flex')}>
        {view?.kind === 'cluster' ? (
          <ClusterPage clusterId={view.id} />
        ) : view?.kind === 'new' ? (
          <NewCluster />
        ) : view?.kind === 'join' ? (
          <JoinCluster invite={view.invite} />
        ) : (
          <Empty className="eyebrow raised m-auto rounded-md border bg-white px-4 py-2.5">Pick a cluster, or make one</Empty>
        )}
      </main>
    </div>
  )
}

/** A cluster of the list, with its right-click menu: open, and leave or delete it, each asked first. */
function ClusterItem({ id, role, name, children }: { id: string; role: ClusterRole; name: string; children: ReactNode }) {
  const store = useStore()
  const [asking, setAsking] = useState<'leave' | 'delete' | null>(null)
  const actions: Action[] = [
    { label: 'Open', icon: NetworkIcon, onSelect: () => store.showCluster({ kind: 'cluster', id }) },
    null,
    role === 'owner'
      ? { label: 'Delete the cluster', icon: Trash2Icon, destructive: true, onSelect: () => setAsking('delete') }
      : { label: 'Leave the cluster', icon: LogOutIcon, destructive: true, onSelect: () => setAsking('leave') },
  ]
  const leaveOrDelete = async () => {
    const done = asking === 'delete' ? await store.clusters?.remove(id) : await store.clusters?.leave(id)
    if (done && store.clusterView?.kind === 'cluster' && store.clusterView.id === id) store.showCluster(null)
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
            ? 'For everyone: its posts, notes, claims and clock go, and every session leaves it. This cannot be undone.'
            : 'Your sessions leave it with you. You need a new invite to come back.'
        }
        action={asking === 'delete' ? 'Delete' : 'Leave'}
        onConfirm={() => void leaveOrDelete()}
      />
    </>
  )
}
