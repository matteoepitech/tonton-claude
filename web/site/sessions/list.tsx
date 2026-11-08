// The account's sessions, grouped by machine, under a search that also finds a tool ("codex"). A click on a machine folds
// its sessions, as in the notch; a search shows every match, folded or not.
import { ChevronDownIcon, ChevronRightIcon, SearchIcon } from 'lucide-react'
import { useState } from 'react'
import {
  type ClientState,
  displayStatusText,
  foldSummary,
  isLive,
  machineFoldKey,
  mixesTools,
  needsAttention,
  type Session,
  STATUS_LABELS,
  sessionMatches,
} from '../../../shared'
import { Empty, StatusDot, ToolIcon } from '../common'
import { cn } from '../ui/cn'
import { Input } from '../ui/fields'

interface SessionListProps {
  state: ClientState
  folded: ReadonlySet<string>
  onPick(session: Session): void
  onFold(key: string): void
}

export function SessionList(props: SessionListProps) {
  const [query, setQuery] = useState('')
  if (!props.state.sessions.length) return <Empty>{props.state.connection === 'connected' ? 'No sessions yet.' : 'Connecting…'}</Empty>
  return (
    <div className="flex flex-col gap-0.5">
      <div className="relative mx-1 mt-1">
        <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search sessions"
          aria-label="Search sessions"
          title="By project, machine, title or tool"
          className="h-8 ps-8 text-sm"
        />
      </div>
      <SessionGroups {...props} query={query} />
    </div>
  )
}

/** The sessions the search keeps, by machine. */
export function SessionGroups({ state, folded, onPick, onFold, query }: SessionListProps & { query: string }) {
  const searching = query.trim() !== ''
  const shown = state.sessions.filter(session => sessionMatches(session, query))
  // The tool of each session only says something when several are listed.
  const mixed = mixesTools(state.sessions)
  const groups = new Map<string, Session[]>()
  for (const session of shown) groups.set(session.machine, [...(groups.get(session.machine) ?? []), session])
  if (!shown.length) return <Empty>No session matches “{query.trim()}”.</Empty>
  return [...groups].map(([machine, sessions]) => {
    const key = machineFoldKey(machine)
    const isFolded = !searching && folded.has(key)
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
                <span className="flex min-w-0 items-center gap-1.5">
                  {mixed && <ToolIcon tool={session.tool} />}
                  <strong className="truncate font-medium">{session.name ?? session.project}</strong>
                </span>
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
  })
}
