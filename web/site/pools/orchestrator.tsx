// The orchestrator's chat (docs/pool-autopilot.md). The orchestrator is one of the admin's own sessions, sealed with
// the admin's account key: only the admin reads it and writes to it, here, as any of their sessions. Beside it: the
// dispatch, the board at a glance, and what the control loop did. The other members see who runs it and what it does.
import { BotIcon, PauseIcon, PlayIcon } from 'lucide-react'
import { useEffect } from 'react'
import { BOARD_COLUMNS, board, memberName, type PoolState, poolAbilities } from '../../../shared'
import { Empty } from '../common'
import { ago } from '../format'
import { Chat } from '../sessions/chat'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { cn } from '../ui/cn'
import type { TabProps } from './page'

/** The events the control loop posts as the orchestrator machine. */
const LOOP_KINDS = new Set(['dispatched', 'retried', 'blocked', 'dispatch_waiting', 'dispatch_done', 'orchestrator_failed'])

export function Orchestrator({ pool, state }: TabProps) {
  const store = useStore()
  const lead = state.orchestrator
  const mine = lead && lead.account === store.account
  const session = mine ? store.state?.sessions.find(s => s.id === lead.session) : undefined
  // The relay sends the conversation of the session the client follows: the orchestrator's while this tab shows, and
  // the one the Sessions page had open again after.
  const sessionId = session?.id
  useEffect(() => {
    const client = store.client
    if (!sessionId || !client) return
    const before = client.state.selectedId
    if (before !== sessionId) client.select(sessionId)
    return () => {
      if (before !== sessionId && client.state.selectedId === sessionId) client.select(before)
    }
  }, [sessionId, store])

  return (
    // On phones the chat and its side column scroll as one page; side by side, each scrolls on its own.
    <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[1fr_300px] lg:overflow-hidden">
      <section className="flex min-h-[65dvh] flex-col border-e lg:min-h-0" aria-label="Orchestrator chat">
        {session && store.state ? (
          <Chat
            key={session.id}
            session={session}
            state={store.state}
            client={store.client}
            placeholder="Tell the orchestrator what to build, then “Go”… (Enter sends)"
          />
        ) : (
          <div className="m-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
            <BotIcon className="size-8 text-muted-foreground" />
            <NoChat state={state} mine={Boolean(mine)} account={store.account} />
          </div>
        )}
      </section>
      <aside className="flex flex-col gap-3 p-4 lg:min-h-0 lg:overflow-y-auto">
        <Dispatch poolId={pool.id} state={state} canSet={poolAbilities(pool.role).chooseOrchestrator} />
        <BoardGlance state={state} />
        <LoopNotices state={state} />
      </aside>
    </div>
  )
}

function NoChat({ state, mine, account }: { state: PoolState; mine: boolean; account: string | null }) {
  const lead = state.orchestrator
  if (!lead) {
    return (
      <>
        <strong>No orchestrator yet</strong>
        <p className="text-sm text-muted-foreground">
          An admin picks one of their machines as the orchestrator machine (Machines), whose agent starts the orchestrator session, or makes
          one of their sessions the orchestrator. It plans the work and hands it to the others.
        </p>
      </>
    )
  }
  if (mine) {
    return (
      <>
        <strong>The orchestrator session is not running</strong>
        <p className="text-sm text-muted-foreground">
          It is one of your sessions, but it is not live right now. Its machine starts it again once it is online.
        </p>
      </>
    )
  }
  return (
    <>
      <strong>{memberName(state, lead.account)} runs the orchestrator</strong>
      <p className="text-sm text-muted-foreground">
        Its conversation is sealed with their account key: only they talk to it.
        {account ? ' You follow what it does in Tasks and Activity.' : ''}
      </p>
    </>
  )
}

function Dispatch({ poolId, state, canSet }: { poolId: string; state: PoolState; canSet: boolean }) {
  const store = useStore()
  const on = state.dispatch?.value?.on === true
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <span className={cn('size-2 rounded-full', on ? 'bg-success' : 'bg-faint')} />
        <strong className="text-sm">Dispatch {on ? 'on' : 'off'}</strong>
      </div>
      <p className="text-xs text-muted-foreground">
        {on
          ? 'Every free slot of every online machine gets the next task that fits.'
          : 'Tasks wait on the board. The orchestrator starts the dispatch when you say “Go”.'}
      </p>
      {state.dispatch?.value?.note && <p className="text-xs">{state.dispatch.value.note}</p>}
      {canSet && (
        <Button
          size="sm"
          variant={on ? 'outline' : 'default'}
          onClick={() => void store.pools?.setDispatch(poolId, { on: !on })}
          disabled={!state.orchestrator && !state.orchestratorMachine}
          title={!state.orchestrator && !state.orchestratorMachine ? 'The pool needs an orchestrator first' : undefined}
        >
          {on ? <PauseIcon /> : <PlayIcon />}
          {on ? 'Pause the dispatch' : 'Start the dispatch'}
        </Button>
      )}
    </Card>
  )
}

function BoardGlance({ state }: { state: PoolState }) {
  const columns = board(state.tasks).columns
  const store = useStore()
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-center">
        <strong className="text-sm">Tasks</strong>
        <Button variant="link" size="sm" className="ms-auto h-auto p-0" onClick={() => store.setPoolTab('tasks')}>
          Board
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {BOARD_COLUMNS.map(column => (
          <div key={column.state} className="rounded-md bg-secondary px-2 py-1.5">
            <div className="text-base font-semibold">{columns.find(c => c.state === column.state)?.tasks.length ?? 0}</div>
            <div className="truncate text-[11px] text-muted-foreground">{column.label}</div>
          </div>
        ))}
      </div>
    </Card>
  )
}

/** What the control loop did, newest first: it posts as the orchestrator machine. */
function LoopNotices({ state }: { state: PoolState }) {
  const machine = state.orchestratorMachine?.machine
  const notices = state.events
    .filter(event => event.body && LOOP_KINDS.has(event.body.kind) && (!machine || event.machine === machine))
    .slice(-30)
    .reverse()
  return (
    <Card className="flex flex-col gap-2 p-3">
      <strong className="text-sm">What the dispatch did</strong>
      {notices.length ? (
        <ol className="flex flex-col gap-2">
          {notices.map(event => (
            <li key={event.id} className="text-xs">
              <span className="text-muted-foreground">{ago(event.ts)} · </span>
              {event.body?.text ?? event.body?.kind}
            </li>
          ))}
        </ol>
      ) : (
        <Empty className="py-2 text-xs">Nothing yet.</Empty>
      )}
    </Card>
  )
}
