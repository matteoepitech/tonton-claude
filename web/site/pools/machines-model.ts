// What the Machines tab shows of each machine in a pool (docs/pool-autopilot.md), worked out from the pool's state alone:
// whose it is, whether it runs the orchestrator, and its slots, each with the task dispatched to it and the session that
// works on it.
import { memberName, type PoolMachine, type PoolSession, type PoolState, type PoolTaskItem, type PoolTaskState } from '../../../shared'

/** A task holds a slot while its machine works on it: dispatched, started, or stuck. */
const HOLDS_A_SLOT: readonly PoolTaskState[] = ['assigned', 'in_progress', 'blocked']

/**
 * Where a slot's session is. The machine's agent names the session in the task only once it joined the pool
 * (agent/src/service/pool-worker.ts), so a named session missing from the pool has left it.
 */
export type SlotPhase = 'working' | 'starting' | 'waiting' | 'left' | 'none'

export interface MachineSlot {
  task: PoolTaskItem
  /** The session the machine started for it; null until it joins the pool. */
  session: PoolSession | null
  phase: SlotPhase
}

export interface MachineCard {
  machine: PoolMachine
  name: string
  owner: string
  mine: boolean
  orchestrator: boolean
  slots: MachineSlot[]
  /** Slots its capacity leaves free; none while it takes no tasks (offline, stopped, its agent too old, or its profile unread). */
  free: number
}

/** Every machine of the pool, this account's first, then by name. `names`: this account's machines, by id. */
export function machineCards(state: PoolState, account: string | null, names: ReadonlyMap<string, string> = new Map()): MachineCard[] {
  const lead = state.orchestratorMachine
  return (state.machines ?? [])
    .map(machine => {
      const takesTasks = machine.online && machine.ready && machine.profile !== null && !machine.stopped
      const slots = state.tasks
        .filter(item => {
          const task = item.task
          return task?.machine?.account === machine.account && task.machine.machine === machine.machine && HOLDS_A_SLOT.includes(task.state)
        })
        .map(task => {
          const assignee = task.task?.assignee
          const session = assignee
            ? (state.sessions.find(s => s.account === assignee.account && s.session === assignee.session) ?? null)
            : null
          return { task, session, phase: slotPhase(task, session, takesTasks && !state.paused) }
        })
      return {
        machine,
        name: machine.profile?.name ?? names.get(machine.machine) ?? 'A machine',
        owner: memberName(state, machine.account),
        mine: machine.account === account,
        orchestrator: lead?.account === machine.account && lead.machine === machine.machine,
        slots,
        free: takesTasks && machine.profile ? Math.max(0, machine.profile.capacity - slots.length) : 0,
      }
    })
    .sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name))
}

/** `starts`: the machine starts sessions now (online, not stopped, its agent recent enough, the pool not paused). */
function slotPhase(item: PoolTaskItem, session: PoolSession | null, starts: boolean): SlotPhase {
  if (session) return 'working'
  if (item.task?.assignee) return 'left'
  if (item.task?.state !== 'assigned') return 'none'
  return starts ? 'starting' : 'waiting'
}
