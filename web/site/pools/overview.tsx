// A pool's first page: getting it going in a few steps, the orchestrator's plan to accept, how far the work is, and the
// chat with the orchestrator (docs/pool-autopilot.md). The orchestrator is one of the admin's own sessions, sealed with
// the admin's account key: only the admin reads it and writes to it, here, as any of their sessions. Beside it: the
// machines at a glance and what the control loop did. The other members see who runs it and what it does.
import { ActivityIcon, BotIcon, CheckIcon, CpuIcon, PauseIcon, PlayIcon, PlusIcon } from 'lucide-react'
import { type ReactNode, useEffect } from 'react'
import { bestOrchestrator, machinePlanLabel, machinesToAdd, memberName, type PoolState, pendingPlan, poolAbilities } from '../../../shared'
import { Empty, StatusDot } from '../common'
import { ago, plural } from '../format'
import { Chat } from '../sessions/chat'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { cn } from '../ui/cn'
import { InviteButton } from './invites'
import type { TabProps } from './page'
import { PlanCard } from './plan'

/** The events the control loop posts as the orchestrator machine. */
const LOOP_KINDS = new Set(['dispatched', 'retried', 'blocked', 'dispatch_waiting', 'dispatch_done', 'orchestrator_failed'])

export function Overview({ pool, state }: TabProps) {
  const store = useStore()
  const lead = state.orchestrator
  const mine = lead && lead.account === store.account
  const session = mine ? store.state?.sessions.find(s => s.id === lead.session) : undefined
  const plan = pendingPlan(state)
  const started = workStarted(state)
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
    <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[1fr_320px] lg:overflow-hidden">
      <section className="flex min-h-[70dvh] flex-col border-e bg-white lg:min-h-0" aria-label="The orchestrator">
        {(!started || plan) && (
          <div className="flex max-h-[60%] shrink-0 flex-col gap-3 overflow-y-auto border-b p-3">
            {!started && !plan && <GetStarted pool={pool} state={state} />}
            {plan && <PlanCard pool={pool} state={state} plan={plan} />}
          </div>
        )}
        {session && store.state ? (
          <Chat
            key={session.id}
            session={session}
            state={store.state}
            client={store.client}
            placeholder="Tell the orchestrator what to build: it proposes a plan… (Enter sends)"
          />
        ) : (
          <div className="m-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
            <BotIcon className="size-8 text-muted-foreground" />
            <NoChat state={state} mine={Boolean(mine)} account={store.account} />
          </div>
        )}
      </section>
      <aside className="flex flex-col gap-3 p-4 lg:min-h-0 lg:overflow-y-auto">
        {started && <Progress pool={pool} state={state} />}
        <Card className="flex flex-col gap-2 p-3">
          <div className="flex items-center">
            <span className="icon-tile size-6">
              <CpuIcon className="size-3.5" />
            </span>
            <strong className="ms-2 text-sm">Machines</strong>
            <Button variant="link" size="sm" className="ms-auto h-auto p-0" onClick={() => store.setPoolTab('team')}>
              Team
            </Button>
          </div>
          {state.machines?.length ? (
            <MachineGlance state={state} />
          ) : (
            <Empty className="py-2 text-xs">No machine yet: invite your team, or add yours from Team.</Empty>
          )}
        </Card>
        <LoopNotices state={state} />
      </aside>
    </div>
  )
}

/** The work started: the dispatch is on, or a task left the board. Until then, the steps show. */
const workStarted = (state: PoolState) => state.dispatch?.value?.on === true || state.tasks.some(t => t.task && t.task.state !== 'todo')

/** The few steps from a new pool to machines at work, each ticked as it is done, with what to do for the next. */
function GetStarted({ pool, state }: TabProps) {
  const store = useStore()
  const can = poolAbilities(pool.role)
  const machines = state.machines ?? []
  const sessions = machines.reduce((sum, machine) => sum + (machine.profile?.capacity ?? 0), 0)
  const mineToAdd = machinesToAdd(store.state?.machines ?? [], { id: pool.id, name: state.info?.name, machines }).filter(
    pick => pick.machine.online,
  )
  const leadMachine = machines.find(m => m.machine === state.orchestratorMachine?.machine)
  // Its machine says why it could not start the orchestrator session: tmux missing, the repository not cloned…
  const failed =
    leadMachine && !state.orchestrator
      ? state.events.findLast(e => e.body?.kind === 'orchestrator_failed' && e.machine === leadMachine.machine)
      : undefined
  const myBest = bestOrchestrator(machines.filter(m => m.account === store.account))
  const steps: { done: boolean; optional?: boolean; problem?: boolean; title: string; detail: string; action?: ReactNode }[] = [
    {
      done: machines.length > 0,
      title: machines.length ? `${plural(machines.length, 'machine')}, ${plural(sessions, 'session')} at once` : 'Machines',
      detail: machines.length
        ? machines.map(m => `${m.profile?.name ?? 'A machine'} (${machinePlanLabel(m.profile)})`).join(', ')
        : 'Each member’s machines join with them and say what they bring.',
      action: mineToAdd.length ? (
        <Button size="sm" variant="outline" onClick={() => void store.bringMachines(pool.id, mineToAdd)}>
          <PlusIcon />
          Add {mineToAdd.length === 1 ? mineToAdd[0].machine.name : 'my machines'}
        </Button>
      ) : undefined,
    },
    {
      done: state.members.length > 1,
      optional: true,
      title: state.members.length > 1 ? plural(state.members.length, 'member') : 'Your team',
      detail: 'Optional: invite teammates, their machines work too.',
      action: can.invite ? <InviteButton pool={pool} state={state} variant="outline" /> : undefined,
    },
    {
      done: Boolean(state.orchestrator && leadMachine),
      problem: Boolean(failed),
      title: leadMachine ? `The orchestrator runs on ${leadMachine.profile?.name ?? 'a machine'}` : 'The orchestrator',
      detail: leadMachine
        ? state.orchestrator
          ? 'It plans, hands out the work and merges. Its machine takes tasks too.'
          : failed?.body?.text
            ? `It could not start: ${failed.body.text.replace(/^.*?could not start the orchestrator: /, '')} It tries again on its own.`
            : leadMachine.online
              ? 'Its session is starting…'
              : `${leadMachine.profile?.name ?? 'Its machine'} is offline: it starts once the machine is back.`
        : can.chooseOrchestrator
          ? 'One of your machines runs it: it plans, hands out the work and merges.'
          : 'The owner or an admin runs it on one of their machines.',
      action:
        !leadMachine && can.chooseOrchestrator && myBest ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => store.pools?.setOrchestratorMachine(pool.id, { account: myBest.account, machine: myBest.machine })}
          >
            Run it on {myBest.profile?.name ?? 'my machine'}
          </Button>
        ) : undefined,
    },
    {
      done: state.tasks.length > 0,
      title: 'Tell it what to build',
      detail: state.tasks.length
        ? `${plural(state.tasks.length, 'task')} written`
        : 'In the chat below, in plain words: it plans and writes the tasks.',
    },
    {
      done: false,
      title: 'Accept its plan',
      detail: 'It shows who does what. Accept, and every machine gets to work.',
    },
  ]
  // What to do next; the team is never in the way.
  const next = steps.findIndex(step => !step.done && !step.optional)
  return (
    <ol className="flex flex-col gap-1.5">
      {steps.map((step, index) => (
        <li
          key={step.title}
          className={cn(
            'flex items-center gap-3 rounded-lg border border-transparent px-2.5 py-2',
            index === next && 'raised border-border bg-white',
          )}
        >
          <span
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-[3px] text-xs font-bold',
              step.done ? 'icon-tile-ink' : index === next ? 'icon-tile' : 'border bg-white text-muted-foreground',
            )}
          >
            {step.done ? <CheckIcon className="size-3" /> : index + 1}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={cn('text-sm', step.done ? 'text-muted-foreground' : 'font-medium')}>{step.title}</span>
            {(index === next || !step.done) && (
              <span className={cn('text-xs', step.problem ? 'text-destructive' : 'truncate text-muted-foreground')}>{step.detail}</span>
            )}
          </span>
          {!step.done && step.action}
        </li>
      ))}
    </ol>
  )
}

/** Once the work started: how far it is, and the dispatch, paused or resumed by the owner and admins. */
function Progress({ pool, state }: TabProps) {
  const store = useStore()
  const tasks = state.tasks.filter(item => item.task)
  const count = (...states: string[]) => tasks.filter(item => states.includes(item.task?.state ?? '')).length
  const done = count('done')
  const on = state.dispatch?.value?.on === true
  const canSet = poolAbilities(pool.role).chooseOrchestrator
  return (
    <Card className="flex flex-col gap-2.5 p-3">
      <div className="flex items-baseline gap-2">
        <strong className="text-sm">
          {done} of {plural(tasks.length, 'task')} done
        </strong>
        <span className={cn('ms-auto flex items-center gap-1.5 text-xs', on ? 'text-success' : 'text-muted-foreground')}>
          <span className={cn('size-1.5 rounded-full', on ? 'bg-success' : 'bg-faint')} />
          {on ? 'running' : 'paused'}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }}
        />
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>{count('assigned', 'in_progress')} in progress</span>
        {count('review') > 0 && <span>{count('review')} in review</span>}
        <span>{count('todo')} to do</span>
        {count('blocked') > 0 && <span className="text-destructive">{count('blocked')} blocked</span>}
      </div>
      {state.dispatch?.value?.note && <p className="text-xs text-muted-foreground">{state.dispatch.value.note}</p>}
      <div className="flex gap-2">
        {canSet && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void store.pools?.setDispatch(pool.id, { on: !on })}
            disabled={!on && !state.orchestratorMachine}
          >
            {on ? <PauseIcon /> : <PlayIcon />}
            {on ? 'Pause' : 'Resume'}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => store.setPoolTab('tasks')}>
          The board
        </Button>
      </div>
    </Card>
  )
}

/** Each machine on a line: what it brings and how busy it is. */
function MachineGlance({ state }: { state: PoolState }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {(state.machines ?? []).map(machine => {
        const busy = state.tasks.filter(
          item => item.task?.machine?.machine === machine.machine && ['assigned', 'in_progress', 'blocked'].includes(item.task.state),
        ).length
        return (
          <li key={`${machine.account}/${machine.machine}`} className="flex min-w-0 items-center gap-2 text-xs">
            <StatusDot status={machine.stopped || !machine.online ? 'offline' : busy ? 'working' : 'idle'} className="size-1.5" />
            <span className="truncate font-medium">{machine.profile?.name ?? 'A machine'}</span>
            <span className="truncate text-muted-foreground">{memberName(state, machine.account)}</span>
            <span className="ms-auto shrink-0 text-muted-foreground">
              {machinePlanLabel(machine.profile)} · {busy}/{machine.profile?.capacity ?? 0}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function NoChat({ state, mine, account }: { state: PoolState; mine: boolean; account: string | null }) {
  const lead = state.orchestrator
  if (!lead) {
    return (
      <>
        <strong>No orchestrator yet</strong>
        <p className="text-sm text-muted-foreground">
          The owner or an admin runs it on one of their machines, from the steps above. Then you talk to it here: it plans the work and
          hands it to the machines.
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
        {account ? ' You follow what it does in Tasks, and your machines work from its plan.' : ''}
      </p>
    </>
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
      <span className="flex items-center gap-2">
        <span className="icon-tile size-6">
          <ActivityIcon className="size-3.5" />
        </span>
        <strong className="text-sm">Latest</strong>
      </span>
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
