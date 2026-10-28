// The pool's machines, live (docs/pool-autopilot.md): one card per machine, with what it runs, how many sessions at once
// and what they may do without asking, and its slots: the task dispatched to each and the session working on it. A
// member opens its own sessions from here; the owner and admins, or the session's owner, stop one, and its machine puts
// the task back on the board. A machine's owner, the owner and admins stop a whole machine; the owner and admins every
// machine at once, with the dispatch.
import { BotIcon, CpuIcon, MessageSquareIcon, PowerIcon, PowerOffIcon, SquareIcon } from 'lucide-react'
import {
  type OpenPool,
  type PoolMachineMode,
  type PoolState,
  poolAbilities,
  type SessionStatus,
  sessionName,
  TASK_STATE_LABELS,
} from '../../../shared'
import { Empty, StatusDot, Toolbar } from '../common'
import { plural } from '../format'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Badge, Card } from '../ui/card'
import { cn } from '../ui/cn'
import { Confirm } from '../ui/dialog'
import { type MachineCard, type MachineSlot, machineCards, type SlotPhase } from './machines-model'
import type { TabProps } from './page'

const MODE_LABELS: Record<PoolMachineMode, string> = { ask: 'Asks for everything', edits: 'File edits pass', full: 'Everything passes' }

/** A slot without a session in the pool. */
const PHASE_TEXTS: Record<SlotPhase, string> = {
  working: '',
  starting: 'Its machine is starting a session',
  waiting: 'Waiting for its machine',
  left: 'Its session left the pool',
  none: 'No session on it',
}
const PHASE_DOTS: Record<SlotPhase, SessionStatus | null> = {
  working: null,
  starting: 'starting',
  waiting: null,
  left: 'ended',
  none: null,
}

export function Machines({ pool, state }: TabProps) {
  const store = useStore()
  const names = new Map(store.state?.machines.map(machine => [machine.id, machine.name]))
  const cards = machineCards(state, store.account, names)
  // Older relays have no pool machines.
  if (!state.machines) return <Empty>This relay is older than pool machines: update it to use the autopilot.</Empty>
  const online = cards.filter(card => card.machine.online).length
  const stopped = cards.filter(card => card.machine.stopped).length
  // Every machine at once: the relay takes it from the owner and admins only.
  const manages = poolAbilities(pool.role).kick
  return (
    <div className="flex flex-col gap-4">
      <Toolbar
        title="Machines"
        detail={cards.length ? `${online} of ${cards.length} online${stopped ? `, ${stopped} stopped` : ''}` : undefined}
      >
        {manages && stopped > 0 && (
          <Button
            variant="outline"
            size="sm"
            title="The dispatch stays as it is: turn it on in the Orchestrator tab."
            onClick={() => store.client?.sendPool({ t: 'pool_stop_machine', poolId: pool.id, machine: null, stopped: false })}
          >
            <PowerIcon />
            Start every machine
          </Button>
        )}
        {manages && stopped < cards.length && (
          <Confirm
            trigger={
              <Button variant="outline" size="sm" className="text-destructive">
                <PowerOffIcon />
                Stop every machine
              </Button>
            }
            title="Stop every machine?"
            description="The dispatch stops, and every machine ends its pool sessions and puts their tasks back on the board. Nothing starts again until you start the machines and the dispatch."
            action="Stop every machine"
            onConfirm={() => void store.pools?.stopAllMachines(pool.id)}
          />
        )}
      </Toolbar>
      {cards.length ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {cards.map(card => (
            <MachineCardView key={`${card.machine.account}/${card.machine.machine}`} card={card} pool={pool} state={state} />
          ))}
        </div>
      ) : (
        <Empty>No machine in the pool yet. Members add theirs from Settings › Machines in the Mac app.</Empty>
      )}
    </div>
  )
}

function MachineCardView({ card, pool, state }: { card: MachineCard; pool: OpenPool; state: PoolState }) {
  const store = useStore()
  const can = poolAbilities(pool.role)
  // The relay lets its owner, and the pool's owner and admins, stop a machine or take it out.
  const manages = card.mine || can.kick
  const { machine } = card
  const profile = machine.profile
  const status = machine.stopped ? 'stopped' : !machine.online ? 'offline' : machine.ready ? 'ready' : 'update the agent'
  const variant = machine.stopped ? 'destructive' : !machine.online ? 'secondary' : machine.ready ? 'success' : 'warning'
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <CpuIcon className="size-4 text-muted-foreground" />
        <strong className="truncate">{card.name}</strong>
        <span className="text-xs text-muted-foreground">
          {card.owner}
          {card.mine ? ' (you)' : ''}
        </span>
        {card.orchestrator && (
          <Badge>
            <BotIcon className="size-3" />
            orchestrator
          </Badge>
        )}
        <Badge className="ms-auto" variant={variant}>
          {status}
        </Badge>
      </div>
      {profile ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{profile.tool === 'opencode' ? 'OpenCode' : 'Claude Code'}</span>
          <span>{plural(profile.capacity, 'session')} at once</span>
          {profile.takes && <span>takes {profile.takes} tasks</span>}
          {profile.areas?.length ? <span>{profile.areas.join(', ')}</span> : null}
          <Badge variant={profile.mode === 'full' ? 'destructive' : 'outline'}>{MODE_LABELS[profile.mode]}</Badge>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Its settings could not be read.</p>
      )}
      {machine.stopped && <p className="text-xs text-muted-foreground">Stopped: it takes no tasks until it is started again.</p>}
      {machine.online && !machine.ready && !machine.stopped && (
        <p className="text-xs text-warning">Its agent is too old to take tasks: its owner clicks Update agent in Settings › Machines.</p>
      )}
      <div className="flex flex-col gap-2">
        {card.slots.map(slot => (
          <Slot key={slot.task.id} slot={slot} pool={pool} state={state} />
        ))}
        {Array.from({ length: card.free }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: free slots have nothing else to tell them apart.
          <div key={index} className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
            <SquareIcon className="size-3.5" />
            Free slot
          </div>
        ))}
      </div>
      {manages && (
        <div className="flex flex-wrap gap-2">
          {machine.stopped ? (
            <Button variant="outline" size="sm" onClick={() => store.pools?.stopMachine(pool.id, machine.machine, false)}>
              <PowerIcon />
              Start machine
            </Button>
          ) : (
            <Confirm
              trigger={
                <Button variant="outline" size="sm" className="text-destructive">
                  <PowerOffIcon />
                  Stop machine
                </Button>
              }
              title={`Stop ${card.name}?`}
              description="Its pool sessions end, and it puts their tasks back on the board. It takes no tasks until it is started again."
              action="Stop machine"
              onConfirm={() => store.pools?.stopMachine(pool.id, machine.machine, true)}
            />
          )}
          {card.mine && can.chooseOrchestrator && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                store.pools?.setOrchestratorMachine(
                  pool.id,
                  card.orchestrator ? null : { account: machine.account, machine: machine.machine },
                )
              }
            >
              {card.orchestrator ? 'Not the orchestrator machine' : 'Make it the orchestrator machine'}
            </Button>
          )}
          <Confirm
            trigger={
              <Button variant="outline" size="sm" className="text-destructive">
                Remove from the pool
              </Button>
            }
            title={`Take ${card.name} out of the pool?`}
            description={`Its pool sessions end and it takes no more tasks. The control loop puts the tasks it held back on the board while the dispatch is on.${card.orchestrator ? ' It stops being the orchestrator machine.' : ''}`}
            action="Remove"
            onConfirm={() => store.pools?.removeMachine(pool.id, machine.machine)}
          />
        </div>
      )}
    </Card>
  )
}

function Slot({ slot, pool, state }: { slot: MachineSlot; pool: OpenPool; state: PoolState }) {
  const store = useStore()
  const task = slot.task.task
  const session = slot.session
  const assignee = task?.assignee
  const own = assignee?.account === store.account
  // The owner and admins stop anyone's pool session; a member its own. Only one in the pool: the relay refuses others.
  const canStop = session !== null && (poolAbilities(pool.role).kick || own)
  const status = session ? (session.status ?? (session.online ? 'idle' : 'offline')) : PHASE_DOTS[slot.phase]
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-secondary/60 px-3 py-2">
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <strong className="truncate text-sm font-medium">{task?.title ?? 'A task'}</strong>
        <span className={cn('ms-auto text-xs', task?.state === 'blocked' ? 'text-destructive' : 'text-muted-foreground')}>
          {task ? TASK_STATE_LABELS[task.state] : ''}
          {task?.attempts ? ` · ${plural(task.attempts, 'failed attempt')}` : ''}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{session ? sessionName(state, session) : PHASE_TEXTS[slot.phase]}</span>
        {task?.branch && <span className="font-mono">{task.branch}</span>}
        <span className="ms-auto flex gap-1.5">
          {own && assignee && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => {
                store.setMode('sessions')
                store.select(assignee.session)
              }}
            >
              <MessageSquareIcon />
              Open
            </Button>
          )}
          {canStop && assignee && (
            <Confirm
              trigger={
                <Button variant="ghost" size="sm" className="h-7 text-destructive">
                  Stop
                </Button>
              }
              title="Stop this session's pool work?"
              description="Its session ends and leaves the pool. Its machine puts the task back on the board, for another slot, once it is online."
              action="Stop"
              onConfirm={() => store.client?.sendPool({ t: 'pool_stop', poolId: pool.id, target: assignee })}
            />
          )}
        </span>
      </div>
    </div>
  )
}
