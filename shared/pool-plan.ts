// The plan the orchestrator proposes and an admin accepts (docs/pool-autopilot.md, The plan). The orchestrator writes
// the tasks, then `plan_propose` posts them with where each one starts; the pool's page and the notch show it as a card,
// task by machine, with **Accept**. Accepting turns the dispatch on: the control loop then hands the tasks out by the same
// rules the proposal was worked out with. Mirrors app/Sources/TontonCore/PoolPlan.swift.

import type { PoolMachine, PoolPostItem, PoolState, PoolTaskItem } from './pool'
import { decodePoolMachineRef, machinePlanLabel } from './pool-machines'
import type { PoolEventBody, PoolPlanProposal } from './pool-protocol'

/** Tasks a proposal names at most: a sealed event stays well under the relay's size for a post. */
export const MAX_PLAN_TASKS = 100
/** What each step of a plan posts, as event kinds. */
export const PLAN_PROPOSED = 'plan_proposed'
export const PLAN_ACCEPTED = 'plan_accepted'
/** Events after a proposal that say the work started, and the proposal is not waiting any more. */
const STARTED = new Set([PLAN_ACCEPTED, 'dispatched', 'dispatch_done'])

const ID = /^[A-Za-z0-9_-]{1,64}$/

/** A proposal as another member's agent sealed it: entries of the wrong shape are dropped. */
export function decodePlanProposal(value: unknown): PoolPlanProposal | undefined {
  const tasks = typeof value === 'object' && value !== null ? (value as { tasks?: unknown }).tasks : undefined
  if (!Array.isArray(tasks)) return undefined
  return {
    tasks: tasks.slice(0, MAX_PLAN_TASKS).flatMap(entry => {
      const id = typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined
      if (typeof id !== 'string' || !ID.test(id)) return []
      const machine = decodePoolMachineRef((entry as { machine?: unknown }).machine)
      return [machine ? { id, machine } : { id }]
    }),
  }
}

export type PendingPlan = PoolPostItem<PoolEventBody> & { body: PoolEventBody & { proposal: PoolPlanProposal } }

/**
 * The plan waiting for an admin: the orchestrator's latest proposal, as the relay attests its sender, while the dispatch
 * is off and nothing since says the work started. Null otherwise.
 */
export function pendingPlan(state: Pick<PoolState, 'events' | 'orchestrator' | 'dispatch'>): PendingPlan | null {
  if (state.dispatch?.value?.on) return null
  const lead = state.orchestrator
  for (let index = state.events.length - 1; index >= 0; index--) {
    const event = state.events[index]
    const kind = event.body?.kind ?? ''
    if (STARTED.has(kind)) return null
    if (kind !== PLAN_PROPOSED || !event.body?.proposal) continue
    if (!lead || event.account !== lead.account || event.session !== lead.session) continue
    return event as PendingPlan
  }
  return null
}

/** One machine of the plan and the tasks it starts with, or the tasks that start later (`machine` null). */
export interface PlanLane {
  machine: PoolMachine | null
  /** `Studio`, or `Later` for the tasks that wait. */
  name: string
  /** Its member's name. */
  owner?: string
  /** `Claude Max 20x · 3 at once`. */
  detail?: string
  tasks: PoolTaskItem[]
}

/** The proposal as the card shows it: each machine with what it starts, in the pool's order, then what comes later. */
export function planLanes(state: Pick<PoolState, 'tasks' | 'machines' | 'members'>, proposal: PoolPlanProposal): PlanLane[] {
  const lanes = new Map<string, PlanLane>()
  const later: PoolTaskItem[] = []
  for (const entry of proposal.tasks) {
    const item = state.tasks.find(task => task.id === entry.id)
    if (!item?.task) continue
    const machine = entry.machine && state.machines?.find(m => m.machine === entry.machine?.machine && m.account === entry.machine.account)
    if (!machine) {
      later.push(item)
      continue
    }
    const lane = lanes.get(machine.machine) ?? {
      machine,
      name: machine.profile?.name ?? 'A machine',
      owner: state.members.find(member => member.account === machine.account)?.profile?.name,
      detail: machine.profile ? `${machinePlanLabel(machine.profile)} · ${machine.profile.capacity} at once` : undefined,
      tasks: [],
    }
    lane.tasks.push(item)
    lanes.set(machine.machine, lane)
  }
  return [...lanes.values(), ...(later.length ? [{ machine: null, name: 'Later', tasks: later }] : [])]
}
