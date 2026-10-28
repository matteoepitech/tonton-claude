// The pool's control loop (docs/pool-autopilot.md), in the orchestrator machine's background service: plain code, like
// a Kubernetes controller, that costs no tokens and never forgets. While the dispatch is on, every 10 seconds and on
// every change of the pool, it looks at the pool and makes one change at a time, through the same revisions as
// everything else: a task whose machine went away, never started it, or whose session ended or stalled goes back to the
// board, three times at most, then is blocked; each task to do whose dependencies are done goes to the free slot of an
// online machine that fits it (docs/pool-orchestrator.md: simple tasks to OpenCode first, large ones to Claude Code, the
// task's area first, the account's limits and the pool's budgets). What it does goes to the pool as events, which the
// orchestrator's agent turns into notices. When every task is done, it says so and stops.

import { overBudget, type PoolMachine, type PoolState, type PoolTaskItem } from '../../../shared/pool'
import { planRank } from '../../../shared/pool-machines'
import type { PoolTask, PoolTaskSize } from '../../../shared/pool-protocol'
import { dispatching, machineName } from '../channel/pool-dispatch'
import { accountLimits, expectedHours, shortOfTime } from '../channel/pool-limits'
import { mergeQueue } from '../channel/pool-merge'
import { STALL_MS, waitingFor } from '../channel/pool-orchestrator'
import { log } from '../log'
import type { MachinePools } from './pool-machines'
import { failedTask, freedTask, MAX_ATTEMPTS } from './pool-worker'

export const LOOP_MS = 10_000
/** A machine offline this long gives its tasks back: a short loss of the network does not. */
const OFFLINE_GRACE_MS = 2 * 60_000
/**
 * A task dispatched to a machine that has not started a session for it after this goes elsewhere: the machine may clone
 * a large repository first (10 minutes at most), then start Claude Code.
 */
const START_GRACE_MS = 15 * 60_000
/** A task whose session left the pool, and that its machine did not give back by then. */
const LEFT_GRACE_MS = 2 * 60_000
/** Changes made in one look at the pool at most: the next look goes on. */
const MAX_CHANGES = 20

/** Why a task goes back to the board, and whether its session failed it (shared/pool-model.ts). */
interface Trouble {
  why: string
  setback?: boolean
}

/** Tasks a machine holds: they take its slots. */
const ACTIVE = new Set(['assigned', 'in_progress', 'blocked'])

export interface LoopOptions {
  now?: () => number
  stallMs?: number
}

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

export class DispatchLoop {
  private readonly running = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  /** When each machine was first seen offline. */
  private readonly offlineSince = new Map<string, number>()
  /** When each session was first seen doing nothing: not working, as the relay sees its status. */
  private readonly quietSince = new Map<string, number>()
  /** Why tasks wait, as the orchestrator was last told, per pool: told again when the reasons change. */
  private readonly told = new Map<string, string>()
  private readonly timer: ReturnType<typeof setInterval>
  private readonly now: () => number
  private readonly stallMs: number
  private stopped = false

  constructor(
    private readonly pools: MachinePools,
    options: LoopOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.stallMs = options.stallMs ?? STALL_MS
    this.timer = setInterval(() => {
      for (const poolId of this.pools.ids()) this.changed(poolId)
    }, LOOP_MS)
    this.timer.unref?.()
  }

  stop() {
    this.stopped = true
    clearInterval(this.timer)
  }

  /** Something changed in the pool: one look now, and another after it when more changes came meanwhile. */
  changed(poolId: string) {
    if (this.stopped) return
    if (this.running.has(poolId)) {
      this.again.add(poolId)
      return
    }
    const run = this.look(poolId)
      .catch(error => log('pool control loop failed', String(error)))
      .finally(() => {
        this.running.delete(poolId)
        if (this.again.delete(poolId)) this.changed(poolId)
      })
    this.running.set(poolId, run)
  }

  /** Resolves once the look at the pool going on, if any, is over. */
  async settled(poolId: string): Promise<void> {
    while (this.running.has(poolId)) await this.running.get(poolId)
  }

  private async look(poolId: string) {
    for (let changes = 0; changes < MAX_CHANGES; changes++) {
      if (!(await this.step(poolId))) return
    }
  }

  /** One change at most, on the pool as it is now: true when it made one. */
  private async step(poolId: string): Promise<boolean> {
    const state = this.pools.state(poolId)
    const account = this.pools.account(poolId)
    const lead = state?.orchestratorMachine
    if (!state || !account || lead?.machine !== this.pools.machineId || lead.account !== account) return false
    if (!dispatching(state) || state.paused) return false
    const now = this.now()
    for (const item of state.tasks) {
      const held = item.task?.machine && ACTIVE.has(item.task.state) ? item.task.machine.machine : null
      const machine = held ? state.machines?.find(m => m.machine === held) : undefined
      // Its machine was stopped: the task goes elsewhere as it was, uncounted, when the machine cannot give it back.
      if (machine?.stopped) return this.retry(poolId, item, { why: `${machineName(state, machine)} was stopped` }, false)
      const trouble = held ? this.trouble(state, item, now) : null
      if (trouble) return this.retry(poolId, item, trouble)
    }
    const tasks = state.tasks.filter(item => item.task)
    if (tasks.length && tasks.every(item => item.task?.state === 'done')) return this.finish(poolId, state)
    const waiting = new Map<string, string[]>()
    for (const item of tasks) {
      const task = item.task as PoolTask
      if (task.state !== 'todo' || waitingFor(state, task).length) continue
      const machine = machineCandidates(state, task, now)[0]
      if (machine) return this.dispatch(poolId, state, item, machine)
      const why = whyNoMachine(state, task)
      waiting.set(why, [...(waiting.get(why) ?? []), item.id])
    }
    await this.waits(poolId, waiting)
    return false
  }

  /**
   * Why a task held by a machine should go back to the board now, or null. A setback when its session failed it: it
   * ended or stalled, which a stronger model may not; not when the machine did.
   */
  private trouble(state: PoolState, item: PoolTaskItem, now: number): Trouble | null {
    const task = item.task as PoolTask
    const machine = state.machines?.find(m => m.machine === task.machine?.machine)
    if (!machine) return { why: 'its machine left the pool' }
    const name = machineName(state, machine)
    if (!machine.online) {
      const since = this.offlineSince.get(machine.machine) ?? now
      this.offlineSince.set(machine.machine, since)
      if (now - since > OFFLINE_GRACE_MS) return { why: `${name} went offline` }
    } else this.offlineSince.delete(machine.machine)
    const age = now - Date.parse(item.updatedAt)
    if (task.state === 'assigned' && !task.assignee && age > START_GRACE_MS) {
      return { why: machine.ready ? `${name} did not start it` : `${name} runs an agent too old for pool machines` }
    }
    const session = task.assignee?.session
    if (session && !state.sessions.some(s => s.session === session) && age > LEFT_GRACE_MS) {
      return { why: `its session on ${name} ended`, setback: true }
    }
    // A session can work for hours without touching its task: stalled is no change to the task and no work either.
    if (task.state === 'in_progress' && age > this.stallMs && this.quiet(state, session, now) > this.stallMs) {
      return { why: `it has not moved for ${Math.round(this.stallMs / 60_000)} minutes on ${name}`, setback: true }
    }
    return null
  }

  /** How long the session has not been working, as far as the loop saw; forever when the relay says nothing of it. */
  private quiet(state: PoolState, session: string | undefined, now: number): number {
    const status = state.sessions.find(s => s.session === session)?.status
    if (!session || !status) return Number.POSITIVE_INFINITY
    if (status === 'working' || status === 'starting') {
      this.quietSince.delete(session)
      return 0
    }
    const since = this.quietSince.get(session) ?? now
    this.quietSince.set(session, since)
    return now - since
  }

  /** Puts the task back on the board, counted in its attempts unless nothing failed. */
  private async retry(poolId: string, item: PoolTaskItem, { why, setback }: Trouble, counted = true): Promise<boolean> {
    const task = item.task as PoolTask
    const because = `${why[0].toUpperCase()}${why.slice(1)}.`
    const next = counted ? failedTask(task, because, setback) : freedTask(task, because)
    if (await this.pools.putTask(poolId, item, next)) return false
    const about = `${item.id} (${task.title})`
    if (!counted) {
      await this.pools.event(poolId, 'retried', item.id, `${about} went back to the board: ${why}.`)
    } else if (next.state === 'blocked') {
      // The orchestrator hears of a blocked task from its own agent: the event is for the timeline.
      await this.pools.event(poolId, 'blocked', item.id, `${about} failed ${MAX_ATTEMPTS} times: ${why}.`)
    } else {
      await this.pools.event(
        poolId,
        'retried',
        item.id,
        `${about} went back to the board: ${why}. Attempt ${(next.attempts ?? 0) + 1} of ${MAX_ATTEMPTS} next.`,
      )
    }
    log('pool task given back', { pool: poolId, task: item.id })
    return true
  }

  private async dispatch(poolId: string, state: PoolState, item: PoolTaskItem, machine: PoolMachine): Promise<boolean> {
    const { assignee: _assignee, ...task } = item.task as PoolTask
    const next: PoolTask = { ...task, state: 'assigned', machine: { account: machine.account, machine: machine.machine } }
    if (await this.pools.putTask(poolId, item, next)) return false
    const again = task.attempts ? `, attempt ${task.attempts + 1} of ${MAX_ATTEMPTS}` : ''
    await this.pools.event(
      poolId,
      'dispatched',
      item.id,
      `Dispatched ${item.id} (${task.title}) to ${machineName(state, machine)}${again}.`,
    )
    return true
  }

  /** Tells the orchestrator why tasks to do wait, once, and again when the reasons change: nothing changes in the pool. */
  private async waits(poolId: string, waiting: Map<string, string[]>) {
    const reasons = [...waiting.keys()].sort().join('|')
    if ((this.told.get(poolId) ?? '') === reasons) return
    this.told.set(poolId, reasons)
    if (!waiting.size) return
    const lines = [...waiting].map(
      ([why, ids]) =>
        `${ids.length} task${ids.length === 1 ? '' : 's'} (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? '…' : ''}) wait: ${why}.`,
    )
    await this.pools.event(poolId, 'dispatch_waiting', waiting.size === 1 ? [...waiting.values()][0][0] : undefined, lines.join(' '))
  }

  /** Every task is done: it says so, then stops. Said again only if stopping failed and the next look tries again. */
  private async finish(poolId: string, state: PoolState): Promise<boolean> {
    const toMerge = mergeQueue(state).length
    const merge = toMerge
      ? ` ${toMerge} finished branch${toMerge === 1 ? '' : 'es'} wait${toMerge === 1 ? 's' : ''} to be merged (task_merge).`
      : ''
    await this.pools.event(poolId, 'dispatch_done', undefined, `Every task is done: the dispatch stopped.${merge}`)
    return !(await this.pools.putDispatch(poolId, { on: false, note: 'Every task is done.' }))
  }
}
