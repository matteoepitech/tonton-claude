// The autopilot on the orchestrator's side (docs/pool-autopilot.md). `dispatch_start` and `dispatch_stop` turn the
// control loop of the orchestrator machine on and off; the overview lists the pool's machines; and what the loop does
// reaches the orchestrator's Claude as short notices. The loop itself is plain code in that machine's background service
// (agent/src/service/pool-loop.ts): Claude plans, merges and answers the admin, the loop hands out the work.

import type { PoolMachine, PoolState } from '../../../shared/pool'
import { machinePlanLabel } from '../../../shared/pool-machines'
import type { PoolDispatch } from '../../../shared/pool-protocol'
import type { PoolToolSpec } from './pool-work'

const POOL = { type: 'string', description: 'The pool, by id or name. Only needed when the session is in more than one.' } as const
const NOTE = { type: 'string', description: 'Why, in a few words, for the members.' } as const

export const DISPATCH_TOOLS: PoolToolSpec[] = [
  {
    name: 'dispatch_start',
    description:
      "For the orchestrator: start the pool's control loop. It hands every task that is to do and whose dependencies are done to a free machine of the pool that fits it, retries what fails, and tells you what it did.",
    params: { pool: POOL, note: NOTE },
  },
  {
    name: 'dispatch_stop',
    description: "For the orchestrator: stop the pool's control loop. Tasks already handed out go on; nothing new is handed out.",
    params: { pool: POOL, note: NOTE },
  },
]

/** What the control loop posts, as events of the orchestrator machine: each one becomes a notice for the orchestrator. */
export const LOOP_EVENTS: ReadonlySet<string> = new Set(['dispatched', 'retried', 'dispatch_waiting', 'dispatch_done'])

/** Told to the orchestrator once, with its guide, when the pool runs on autopilot: its machine runs the control loop. */
export const AUTOPILOT_GUIDE = [
  'This pool runs on autopilot: members put whole machines in it, and the control loop of your machine hands the tasks out.',
  "1. pool_overview lists the machines: their tool and their account's plan (Claude Max 20x, Max 5x, Pro, OpenCode), how many sessions each runs, its mode, its areas and what it runs now. Their owners said nothing more: size the work by what each one brings.",
  '2. Plan with plan_create and create the tasks with task_create, without assigning them. Size each one: simple tasks go to OpenCode machines first, large ones to Claude Code machines.',
  '3. When the user says go, call dispatch_start; when they say pause, dispatch_stop. The loop hands each task whose dependencies are done to a free machine that fits it, starts a session there with the task, and gives a task whose session or machine fails to another one, three times at most.',
  '4. Notices tell you what the loop did. Answer the blocked tasks, merge the finished branches with task_merge, and re-plan when tasks fail.',
  '5. The user talks to you here: answer their questions about the pool from pool_overview.',
].join('\n')

/** Whether the control loop hands out tasks. Missing: off. */
export const dispatching = (state: Pick<PoolState, 'dispatch'>): boolean => state.dispatch?.value?.on === true

/** Tasks a machine holds: they take its slots. */
const ACTIVE = new Set(['assigned', 'in_progress', 'blocked'])

/** What the machine is called: its owner's name for it, else its member's. */
export function machineName(state: Pick<PoolState, 'members'>, machine: Pick<PoolMachine, 'account' | 'machine' | 'profile'>): string {
  const member = state.members.find(m => m.account === machine.account)?.profile?.name
  return machine.profile?.name ?? (member ? `${member}'s machine` : 'a machine')
}

/** The pool's machines as the orchestrator reads them in pool_overview. */
export function machinesView(state: PoolState) {
  return (state.machines ?? []).map(machine => {
    const held = state.tasks.filter(item => item.task?.machine?.machine === machine.machine && ACTIVE.has(item.task.state))
    return {
      machine: machine.machine,
      name: machineName(state, machine),
      tool: machine.profile?.tool,
      // `Claude Max 20x`, `Claude Pro`, `OpenCode`: what its account sustains, as its agent reported it.
      plan: machinePlanLabel(machine.profile),
      capacity: machine.profile?.capacity,
      mode: machine.profile?.mode,
      areas: machine.profile?.areas,
      takes: machine.profile?.takes,
      online: machine.online,
      // Online and never ready: its agent is older than pool machines.
      ready: machine.ready,
      orchestrator: state.orchestratorMachine?.machine === machine.machine || undefined,
      running: held.map(item => ({ id: item.id, title: item.task?.title, state: item.task?.state })),
    }
  })
}

/** The dispatch as it will be, or why the orchestrator may not change it now. */
export function nextDispatch(state: PoolState, on: boolean, note: unknown): PoolDispatch | string {
  if (on && !state.machines?.length) return 'The pool has no machines: members put theirs in from the website or Settings › Machines.'
  if (on && !state.orchestratorMachine) {
    return 'No machine runs the control loop: the admin chooses one of their own as the orchestrator machine, on the website.'
  }
  if (dispatching(state) === on) return on ? 'The dispatch is already on.' : 'The dispatch is already off.'
  return { on, ...(typeof note === 'string' && note.trim() ? { note: note.trim().slice(0, 200) } : {}) }
}
