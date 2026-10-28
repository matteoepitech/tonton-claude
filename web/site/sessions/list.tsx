// The account's sessions, grouped by machine. A click on a machine folds its sessions, as in the notch.
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import {
  type ClientState,
  displayStatusText,
  foldSummary,
  isLive,
  machineFoldKey,
  needsAttention,
  type Session,
  STATUS_LABELS,
} from '../../../shared'
import { Empty, StatusDot } from '../common'
import { cn } from '../ui/cn'

export function SessionList({
  state,
  folded,
  onPick,
  onFold,
}: {
  state: ClientState
  folded: ReadonlySet<string>
  onPick(session: Session): void
  onFold(key: string): void
}) {
  const groups = new Map<string, Session[]>()
  for (const session of state.sessions) groups.set(session.machine, [...(groups.get(session.machine) ?? []), session])
  if (!state.sessions.length) return <Empty>{state.connection === 'connected' ? 'No sessions yet.' : 'Connecting…'}</Empty>
  return (
    <div className="flex flex-col gap-0.5">
      {[...groups].map(([machine, sessions]) => {
        const key = machineFoldKey(machine)
        const isFolded = folded.has(key)
        const summary = isFolded ? foldSummary(sessions) : null
        return (
          <section key={machine} aria-label={machine}>
            <button
              type="button"
              onClick={() => onFold(key)}
              aria-expanded={!isFolded}
              title={isFolded ? 'Show its sessions' : 'Fold its sessions'}
              className="mt-2 flex w-full items-center gap-1 rounded px-2 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
            >
              {isFolded ? <ChevronRightIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
              <span className="truncate">{machine}</span>
              {summary && (
                <span className="ms-auto flex items-center gap-1 normal-case" title={`${summary.hidden} sessions folded`}>
                  {summary.attention && <StatusDot status={summary.attention} />}
                  {summary.hidden}
                </span>
              )}
            </button>
            {!isFolded &&
              sessions.map(session => (
                <button
                  type="button"
                  key={session.id}
                  onClick={() => onPick(session)}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-accent',
                    session.id === state.selectedId && 'bg-accent',
                    !isLive(session.status) && 'opacity-55',
                  )}
                >
                  <StatusDot status={session.status} className="mt-1.5" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <strong className="truncate font-medium">{session.name ?? session.project}</strong>
                    <small className="truncate text-xs text-muted-foreground">
                      {needsAttention(session.status) ? displayStatusText(session) : (session.title ?? STATUS_LABELS[session.status])}
                    </small>
                  </span>
                  {session.tasks && (
                    <em className="text-xs text-muted-foreground not-italic" title="Tasks done in Claude’s list">
                      {session.tasks.done}/{session.tasks.total}
                    </em>
                  )}
                </button>
              ))}
          </section>
        )
      })}
    </div>
  )
}
