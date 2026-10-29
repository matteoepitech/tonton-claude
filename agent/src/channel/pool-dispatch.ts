// The autopilot on the orchestrator's side (docs/pool-autopilot.md). `plan_propose` shows the plan to the user, who
// accepts it; `dispatch_start` and `dispatch_stop` turn the control loop of the orchestrator machine on and off; the
// overview lists the pool's machines; and what the loop does reaches the orchestrator's Claude as short notices. The loop itself is plain code in that machine's background service
// (agent/src/service/pool-loop.ts): Claude plans, merges and answers the admin, the loop hands out the work.

import { overBudget, type PoolMachine, type PoolState } from '../../../shared/pool'
import { machinePlanLabel, planRank } from '../../../shared/pool-machines'
import type { PoolDispatch, PoolTask, PoolTaskSize } from '../../../shared/pool-protocol'
import { accountLimits, expectedHours, shortOfTime } from './pool-limits'
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
    name: 'plan_propose',
    description:
      "For the orchestrator: once the plan is in the notes and its tasks are written, show it to the user for them to accept. The pool's page and the notch show it as a card, each machine with the tasks it starts, and an Accept button: accepting starts the dispatch. Call it again after changing the plan.",
    params: {
      pool: POOL,
      summary: {
        type: 'string',
        description: 'The plan in a few sentences for the user: what gets built, in what order, and who does what.',
        required: true,
      },
    },
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
  "2. When the user says what to build, plan it at once, without asking them questions you can answer yourself: plan_create, then task_create for each task, without assigning them. Size each one: simple tasks go to OpenCode machines first, large ones to Claude Code machines and the largest plans. Keep every machine busy from the start: depends_on only when a task cannot start before another is merged, builds_on when it just uses another one's work.",
  '3. Then call plan_propose with the plan in a few sentences. The user accepts it with a button and the dispatch starts on its own: you are told. Do not ask in the chat whether to go. If they ask for changes instead, change the tasks and call plan_propose again. When they say go here, call dispatch_start; when they say pause, dispatch_stop.',
  '4. The loop hands each task whose dependencies are merged to a free machine that fits it, starts a session there with the task, and gives a task whose session or machine fails to another one, three times at most. Your own machine takes tasks too, in sessions of their own: you plan, merge and answer.',
  '5. Notices tell you what the loop did, and when machines are free while every task waits: merge what is done, or split off work that can start now. Answer the blocked tasks and the questions nobody answers, merge the finished branches with task_merge, and re-plan when tasks fail.',
  '6. The user talks to you here: answer their questions about the pool from pool_overview.',
].join('\n')

/** Whether the control loop hands out tasks. Missing: off. */
export const dispatching = (state: Pick<PoolState, 'dispatch'>): boolean => state.dispatch?.value?.on === true

/** Tasks a machine holds: they take its slots. */
const ACTIVE = new Set(['assigned', 'in_progress', 'blocked'])

/** What a machine takes: its owner's choice, else by its tool, as for sessions. */
const kindOf = (machine: PoolMachine): PoolTaskSize => machine.profile?.takes ?? (machine.profile?.tool === 'opencode' ? 'simple' : 'large')

/** How many sessions the machine runs for the pool's tasks now. */
const held = (state: PoolState, machine: string) =>
  state.tasks.filter(item => item.task?.machine?.machine === machine && ACTIVE.has(item.task.state)).length

/**
 * The machines that may take the task, best first: online, their service ready, a free slot, within their member's and
 * the pool's budgets, with time left on their account's plan for it (Claude Code), and of the kind the task needs. A
 * simple task goes to the machines that take simple tasks first, OpenCode ones before the others; a large one never
 * goes to a machine that takes simple tasks only. Within that, a machine of the task's area, then by its account's plan
 * (a large task to the largest, a simple one to the smallest), then the freest.
 */
export function machineCandidates(state: PoolState, task: Pick<PoolTask, 'area' | 'size' | 'hours'>, now = Date.now()): PoolMachine[] {
  const size = task.size ?? 'large'
  const rank = (kind: PoolTaskSize) => (size === 'simple' ? { simple: 0, large: 2 }[kind] : { large: 0, simple: 9 }[kind])
  return (state.machines ?? [])
    .filter(machine => machine.online && machine.ready && machine.profile && !machine.stopped)
    .filter(machine => !overBudget(state, machine.account))
    .map(machine => ({ machine, kind: kindOf(machine), free: (machine.profile?.capacity ?? 0) - held(state, machine.machine) }))
    .filter(c => c.free > 0 && rank(c.kind) < 9)
    .filter(c => c.machine.profile?.tool === 'opencode' || !shortOfTime(accountLimits(state, c.machine.account), expectedHours(task), now))
    .sort((a, b) => {
      const byKind = rank(a.kind) - rank(b.kind)
      if (byKind) return byKind
      const tool = (c: typeof a) => (size === 'simple' && c.machine.profile?.tool === 'opencode' ? 0 : 1)
      const area = (c: typeof a) => (task.area && c.machine.profile?.areas?.includes(task.area) ? 0 : 1)
      // A large task to the largest plan, a simple one to the smallest, which keeps the large plans for large tasks.
      const plan = (c: typeof a) => (size === 'simple' ? -planRank(c.machine.profile) : planRank(c.machine.profile))
      return (
        tool(a) - tool(b) || area(a) - area(b) || plan(a) - plan(b) || b.free - a.free || a.machine.addedAt.localeCompare(b.machine.addedAt)
      )
    })
    .map(c => c.machine)
}

/** Why no machine takes the task now, for the orchestrator. */
export function whyNoMachine(state: PoolState, task: Pick<PoolTask, 'size' | 'hours'>): string {
  const machines = (state.machines ?? []).filter(machine => machine.profile)
  if (!machines.length) return 'the pool has no machines'
  const size = task.size ?? 'large'
  const kinds = machines.filter(machine => size === 'simple' || kindOf(machine) === 'large')
  if (!kinds.length) return 'every machine of the pool takes simple tasks only'
  const working = kinds.filter(machine => !machine.stopped)
  if (!working.length) return 'every machine that takes it is stopped'
  const ready = working.filter(machine => machine.online && machine.ready)
  if (!ready.length) return 'no machine that takes it is online with an agent that runs pool machines'
  const spent = ready.map(machine => overBudget(state, machine.account))
  if (spent.every(Boolean)) return (spent[0] as string).replace(/^./, first => first.toLowerCase())
  const free = ready.filter(
    machine => (machine.profile?.capacity ?? 0) > held(state, machine.machine) && !overBudget(state, machine.account),
  )
  if (!free.length) return 'every machine that takes it is busy'
  return `no free machine has time left on its plan for it (${expectedHours(task)} h)`
}

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
