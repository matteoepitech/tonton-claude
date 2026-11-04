// The shared documents the sessions keep: the claims (who holds which file, folder or asset, and why) and the notes
// (conventions, interfaces, decisions). Sessions write them; people read them here.
import { LockIcon } from 'lucide-react'
import { Empty, Markdown } from '../common'
import { ago } from '../format'
import { heldClaims, memberName, sessionName } from './model'
import type { ClusterTabProps } from './page'
import { useNow } from './page'

export function Claims({ cluster, state }: ClusterTabProps) {
  const now = useNow(60_000)
  const claims = heldClaims(cluster.claims?.claims ?? [], now)
  if (!claims.length) return <Empty>No claims: nobody holds a file right now.</Empty>
  return (
    <ul className="flex flex-col divide-y rounded-lg border bg-white">
      {claims.map(claim => {
        const session = state.sessions.find(s => s.account === claim.account && s.session === claim.session)
        return (
          <li key={claim.id} className="flex items-start gap-3 px-4 py-2.5">
            <LockIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-mono text-sm">{claim.paths.join(', ')}</span>
              <small className="text-xs text-muted-foreground">
                {memberName(state, claim.account)}
                {session ? ` · ${sessionName(session)}` : ''} · since {ago(claim.at, now)}
                {claim.until ? ` · until ${new Date(claim.until).toLocaleTimeString()}` : ''}
              </small>
              {claim.reason && <span className="text-sm">{claim.reason}</span>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export function Notes({ cluster }: ClusterTabProps) {
  const text = cluster.notes?.text.trim()
  if (!text) return <Empty>No notes yet. The sessions write conventions, interfaces and decisions here.</Empty>
  return <Markdown text={text} className="raised rounded-lg border bg-white p-4 text-sm" />
}
