// A pool machine's workers (docs/pool-autopilot.md). For each task dispatched to this machine, the background service
// claims it once, makes the task's worktree, starts a session there and puts it in the pool with the task, which it then
// gets as its first message. The service follows it: `task_done` moves the task on and the session ends, freeing the
// slot; a session that ends first, or that the pool stops, puts the task back on the board. The machine never runs more
// sessions for a pool than its owner allowed, and takes work only from who may hand it out.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { newPoolItemId, type PoolState, type PoolTaskItem, sealPoolSessionOrder } from '../../../shared/pool'
import type { PoolMachineOrder, PoolSessionProfile, PoolTask, PoolUpdate } from '../../../shared/pool-protocol'
import type { AgentMessage } from '../../../shared/protocol'
import { paths } from '../config'
import { endPoolSession, launchForPool, poolSessionRuns } from '../launch'
import { log } from '../log'
import { claimOnce } from '../once'
import type { MachinePools } from './pool-machines'
import { prepareTaskTree, TASK_ID, taskBranch } from './pool-worktree'

type Post = (build: () => Promise<AgentMessage | null>) => void

/** A task that failed on machines this many times is blocked, for the orchestrator to look at. */
export const MAX_ATTEMPTS = 3
/** How often the service looks at its sessions: one can end without the pool hearing of it. */
const CHECK_MS = 5000
/** The relay takes a session in the pool once it has seen it: the service asks again until then. */
const JOIN_RETRY_MS = 3000
const JOIN_TIMEOUT_MS = 2 * 60_000
/** How long a change waits for the relay to confirm it. */
const CONFIRM_MS = 10_000
/** A dispatch is claimed once, and stays claimed while the relay could replay it. */
const CLAIM_KEEP_MS = 30 * 24 * 60 * 60_000
/** The relay refused a change of the task over an older revision. */
const CHANGED = 'The task changed meanwhile.'

/** A session this machine runs for a pool task, kept on disk so that a restarted service finds it again. */
interface Slot {
  poolId: string
  taskId: string
  /** Null while it starts. */
  sessionId: string | null
  tmux: string | null
  /** The session is in the pool. */
  joined: boolean
  startedAt: string
}

export interface PoolWorkerOptions {
  /** What the machine is called in the pool's events and notes. */
  machineName: string
  /** Where slots and claims are kept. */
  home?: string
  /** How sessions start, run and end: the real launcher, or a stand-in in tests. */
  launch?: typeof launchForPool
  runs?: (tmux: string) => boolean
  end?: (tmux: string) => void
  prepare?: typeof prepareTaskTree
}

/** The task put back on the board after its machine or its session failed it: blocked once it failed too often. */
export function failedTask(task: PoolTask, why: string): PoolTask {
  const { machine: _machine, assignee: _assignee, ...rest } = task
  const attempts = (task.attempts ?? 0) + 1
  return { ...rest, attempts, summary: why, state: attempts >= MAX_ATTEMPTS ? 'blocked' : 'todo' }
}

/** Back on the board as it was, for another machine: nothing failed. */
function freedTask(task: PoolTask, why: string): PoolTask {
  const { machine: _machine, assignee: _assignee, ...rest } = task
  return { ...rest, summary: why, state: 'todo' }
}

export class PoolWorker {
  private readonly slots = new Map<string, Slot>()
  /** Slots whose session is starting: the reconciling leaves them alone. */
  private readonly starting = new Set<string>()
  /** Dispatches left alone, by `pool/task/rev`: said once in the log, not at every look. */
  private readonly ignored = new Set<string>()
  /** Reconciling runs one pool at a time, in order; starts run beside it. */
  private queue: Promise<void> = Promise.resolve()
  private readonly timer: ReturnType<typeof setInterval>
  private readonly folder: string
  private readonly claims: string

  constructor(
    private readonly pools: MachinePools,
    private readonly accountKey: string,
    private readonly post: Post,
    private readonly options: PoolWorkerOptions,
  ) {
    this.folder = join(options.home ?? paths.home, 'pool-slots')
    this.claims = join(options.home ?? paths.home, 'pool-claims')
    for (const slot of this.readSlots()) this.slots.set(key(slot.poolId, slot.taskId), slot)
    this.timer = setInterval(() => {
      for (const poolId of new Set([...this.slots.values()].map(slot => slot.poolId))) this.changed(poolId)
    }, CHECK_MS)
    this.timer.unref?.()
  }

  stop() {
    clearInterval(this.timer)
  }

  /** Something changed in a pool, or the machine joined or left one. */
  changed(poolId: string) {
    this.queue = this.queue.then(() => this.reconcile(poolId)).catch(error => log('pool worker failed', String(error)))
  }

  /** Resolves once the reconciling asked so far is done. */
  settled(): Promise<void> {
    return this.queue
  }

  /** The tasks of the pool this machine runs a session for. */
  running(poolId: string): string[] {
    return [...this.slots.values()].filter(slot => slot.poolId === poolId).map(slot => slot.taskId)
  }

  private async reconcile(poolId: string) {
    const order = this.pools.order(poolId)
    const mine = [...this.slots.values()].filter(slot => slot.poolId === poolId && !this.starting.has(key(poolId, slot.taskId)))
    if (!order) {
      // Out of the pool: its sessions end; the pool puts their tasks back, the machine cannot write to it any more.
      for (const slot of mine) this.end(slot)
      return
    }
    const before = this.pools.state(poolId)
    const account = this.pools.account(poolId)
    if (!before || !account) return
    for (const slot of mine) await this.follow(slot, before, account)
    // Following them may have put tasks back: dispatching reads the pool as it is now.
    const state = this.pools.state(poolId) ?? before
    if (state.paused) return
    for (const item of state.tasks) {
      const task = item.task
      if (task?.state !== 'assigned' || !this.isOurs(task, account)) continue
      const id = key(poolId, item.id)
      if (this.slots.has(id) || this.starting.has(id) || !TASK_ID.test(item.id)) continue
      if (!this.handedByTrusted(state, item, account)) {
        if (!this.ignored.has(`${id}/${item.rev}`))
          log('pool task not taken: dispatched by someone who may not hand out work', { task: item.id })
        this.ignored.add(`${id}/${item.rev}`)
        continue
      }
      // Once per dispatch, whichever process of the machine sees it, and never again if the relay replays it.
      const claimed = claimOnce(this.claims, `${poolId}-${item.id}-${item.rev}`, CLAIM_KEEP_MS)
      if (claimed instanceof Error) log('could not claim a pool task', String(claimed))
      if (claimed !== 'claimed') continue
      if (this.running(poolId).length >= order.profile.capacity) {
        const why = `${this.options.machineName} already runs ${order.profile.capacity} sessions for the pool, as many as its owner allows.`
        await this.putTask(poolId, item, freedTask(task, why))
        await this.event(poolId, 'refused', item.id, why)
        continue
      }
      void this.start(poolId, item, order, account)
    }
  }

  /** A session at work: it ends once its task moved on, and its task goes back when it ended first or was stopped. */
  private async follow(slot: Slot, state: PoolState, account: string) {
    const item = state.tasks.find(task => task.id === slot.taskId)
    const task = item?.task
    const active = task && this.isOurs(task, account) && ['assigned', 'in_progress', 'blocked'].includes(task.state)
    if (!item || !task || !active) {
      this.end(slot)
      return
    }
    const runs = this.options.runs ?? poolSessionRuns
    if (!slot.tmux || !runs(slot.tmux)) {
      this.end(slot)
      await this.fail(slot.poolId, item.id, `The session on ${this.options.machineName} ended before the task was done.`)
      return
    }
    // Stopped by the pool's owner or an admin: the relay took the session out.
    if (slot.joined && !state.sessions.some(session => session.session === slot.sessionId)) {
      this.end(slot)
      const latest = this.latest(slot.poolId, item.id)
      if (latest?.task && this.isOurs(latest.task, account)) {
        await this.putTask(slot.poolId, latest, freedTask(latest.task, `Its session on ${this.options.machineName} was stopped.`))
      }
    }
  }

  private async start(poolId: string, item: PoolTaskItem, order: PoolMachineOrder, account: string) {
    const id = key(poolId, item.id)
    const task = item.task as PoolTask
    const slot: Slot = { poolId, taskId: item.id, sessionId: null, tmux: null, joined: false, startedAt: new Date().toISOString() }
    this.starting.add(id)
    this.slots.set(id, slot)
    this.saveSlot(slot)
    try {
      const why = await this.run(slot, task, order, account)
      if (why) {
        // Why goes in the task, sealed: git's and the terminal's words can name the repository and its folders.
        log('pool task could not start', { pool: poolId, task: item.id })
        this.end(slot)
        // The first line says why; what follows is the end of the terminal, which stays on the machine.
        await this.fail(poolId, item.id, `${this.options.machineName} could not start it: ${why.split('\n')[0].slice(0, 500)}`)
      }
    } finally {
      this.starting.delete(id)
      this.changed(poolId)
    }
  }

  /** Worktree, session, pool, task: null once the session has the task, otherwise why not. */
  private async run(slot: Slot, task: PoolTask, order: PoolMachineOrder, account: string): Promise<string | null> {
    const { poolId, taskId } = slot
    const repo = this.pools.state(poolId)?.info?.repo
    if (!repo) return 'the pool has no repository to clone.'
    const prepare = this.options.prepare ?? prepareTaskTree
    const tree = await prepare(order.profile.workdir, repo, taskId, taskBranch(taskId, task.title, task.branch))
    if (typeof tree === 'string') return tree
    const launched = await (this.options.launch ?? launchForPool)(taskId, tree.cwd, order.profile.tool)
    if (typeof launched === 'string') return launched
    slot.sessionId = launched.sessionId
    slot.tmux = launched.tmux
    this.saveSlot(slot)
    if (!(await this.join(poolId, launched.sessionId, order, task, repo))) return 'its session did not reach the relay.'
    slot.joined = true
    this.saveSlot(slot)
    // The task is the session's from now on: its agent hands it over as its first message. Another change to the task
    // meanwhile (an event, a note) is read again; one that took it elsewhere ends the session at the next look.
    for (let tries = 0; tries < 3; tries++) {
      const latest = this.latest(poolId, taskId)
      if (!latest?.task || !this.isOurs(latest.task, account) || latest.task.state !== 'assigned') return null
      const assigned: PoolTask = { ...latest.task, assignee: { account, session: launched.sessionId }, branch: tree.branch }
      const refused = await this.putTask(poolId, latest, assigned)
      if (!refused) {
        await this.event(poolId, 'task_moved', taskId, `started on ${this.options.machineName}`)
        return null
      }
      if (refused !== CHANGED) return refused
      await this.pools.settled()
    }
    return 'the task kept changing while its session started.'
  }

  /**
   * Puts the session in the pool as a worker of this machine, with an order sealed with the account key that says so
   * and carries the machine's mode, and asks again until the relay, which must have seen the session first, takes it.
   */
  private async join(poolId: string, sessionId: string, order: PoolMachineOrder, task: PoolTask, repo: string): Promise<boolean> {
    const vault = this.pools.vault(poolId)
    const key = vault?.keyring.key(vault.keyring.version)
    if (!vault || !key) return false
    const sealedOrder = await sealPoolSessionOrder(this.accountKey, {
      poolId,
      sessionId,
      key,
      version: vault.keyring.version,
      autoStart: true,
      machine: this.pools.machineId,
      mode: order.profile.mode,
    })
    const profile: PoolSessionProfile = {
      tool: order.profile.tool,
      machine: this.options.machineName,
      project: basename(repo.replace(/\.git$/, '').replace(/[/:]+$/, '')),
      ...(task.area ? { area: task.area } : order.profile.areas?.[0] ? { area: order.profile.areas[0] } : {}),
      ...(order.profile.takes ? { takes: order.profile.takes } : {}),
    }
    const sealedProfile = await vault.seal(profile)
    const deadline = Date.now() + JOIN_TIMEOUT_MS
    while (Date.now() < deadline && this.pools.order(poolId)) {
      this.post(async () => ({
        t: 'pool_machine_session',
        machineId: this.pools.machineId,
        poolId,
        sessionId,
        order: sealedOrder,
        profile: sealedProfile,
      }))
      for (let waited = 0; waited < JOIN_RETRY_MS; waited += 250) {
        await Bun.sleep(250)
        if (this.pools.state(poolId)?.sessions.some(session => session.session === sessionId)) return true
      }
    }
    return false
  }

  /** Ends the slot: its session's tmux goes, it leaves the pool, and the slot is free. */
  private end(slot: Slot) {
    if (slot.tmux) (this.options.end ?? endPoolSession)(slot.tmux)
    if (slot.sessionId && this.pools.order(slot.poolId)) {
      const { poolId, sessionId } = slot
      this.post(async () => ({ t: 'pool_machine_session_left', machineId: this.pools.machineId, poolId, sessionId }))
    }
    this.slots.delete(key(slot.poolId, slot.taskId))
    rmSync(join(this.folder, `${slot.poolId}-${slot.taskId}.json`), { force: true })
    log('pool session ended', { pool: slot.poolId, task: slot.taskId })
  }

  /** The task back on the board, or blocked once it failed too often, unless it moved on meanwhile. */
  private async fail(poolId: string, taskId: string, why: string) {
    const latest = this.latest(poolId, taskId)
    const account = this.pools.account(poolId)
    if (!latest?.task || !account || !this.isOurs(latest.task, account)) return
    if (latest.task.state === 'done' || latest.task.state === 'review') return
    const next = failedTask(latest.task, why)
    if (!(await this.putTask(poolId, latest, next))) {
      await this.event(poolId, next.state === 'blocked' ? 'blocked' : 'task_moved', taskId, why)
    }
  }

  private isOurs(task: PoolTask, account: string): boolean {
    return task.machine?.machine === this.pools.machineId && task.machine.account === account
  }

  /**
   * Work dispatched here counts when the orchestrator's machine or session handed it out, a person did from an app or
   * the website, this machine did, or a reviewer sent it back: another member's Claude does not hand out work.
   */
  private handedByTrusted(state: PoolState, item: PoolTaskItem, account: string): boolean {
    if (item.machine) {
      if (item.machine === this.pools.machineId) return item.account === account
      return state.orchestratorMachine?.machine === item.machine && state.orchestratorMachine.account === item.account
    }
    if (item.session === null) return state.members.some(member => member.account === item.account && member.role !== 'viewer')
    if (item.task?.reviewer?.session === item.session) return true
    return state.orchestrator?.account === item.account && state.orchestrator.session === item.session
  }

  private latest(poolId: string, taskId: string): PoolTaskItem | undefined {
    return this.pools.state(poolId)?.tasks.find(task => task.id === taskId)
  }

  /**
   * Sends the task over the revision it was read at, and waits for the relay: null once it took it, otherwise why not.
   * Either way the pool's state has the answer when it returns, so what is decided next reads it.
   */
  private async putTask(poolId: string, item: Pick<PoolTaskItem, 'id' | 'rev'>, next: PoolTask): Promise<string | null> {
    const vault = this.pools.vault(poolId)
    if (!vault) return 'The machine left the pool.'
    const blob = await vault.seal(next)
    const confirmed = this.waitFor(poolId, update => {
      if (update.t === 'pool_task' && update.task.id === item.id && update.task.rev > item.rev) return null
      if (update.t === 'pool_conflict' && update.kind === 'task' && update.id === item.id) return CHANGED
      return update.t === 'pool_error' ? update.message : undefined
    })
    this.post(async () => ({ t: 'pool_task', machineId: this.pools.machineId, poolId, id: item.id, rev: item.rev, blob }))
    const result = await confirmed
    await this.pools.settled()
    return result
  }

  private async event(poolId: string, kind: string, taskId: string, text: string) {
    const vault = this.pools.vault(poolId)
    if (!vault) return
    const blob = await vault.seal({ kind, taskId, text: text.slice(0, 500) })
    this.post(async () => ({ t: 'pool_event', machineId: this.pools.machineId, poolId, id: newPoolItemId(), blob }))
  }

  private waitFor(poolId: string, check: (update: PoolUpdate) => string | null | undefined): Promise<string | null> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        stop()
        resolve('The relay has not confirmed it.')
      }, CONFIRM_MS)
      const stop = this.pools.listen(update => {
        if ((update.t === 'pool_snapshot' ? update.pool.id : update.poolId) !== poolId) return
        const result = check(update)
        if (result === undefined) return
        clearTimeout(timer)
        stop()
        resolve(result)
      })
    })
  }

  private readSlots(): Slot[] {
    try {
      return readdirSync(this.folder)
        .filter(file => file.endsWith('.json'))
        .flatMap(file => {
          try {
            const slot = JSON.parse(readFileSync(join(this.folder, file), 'utf8')) as Slot
            return typeof slot.poolId === 'string' && typeof slot.taskId === 'string' ? [slot] : []
          } catch {
            return []
          }
        })
    } catch {
      return []
    }
  }

  private saveSlot(slot: Slot) {
    try {
      mkdirSync(this.folder, { recursive: true, mode: 0o700 })
      writeFileSync(join(this.folder, `${slot.poolId}-${slot.taskId}.json`), JSON.stringify(slot), { mode: 0o600 })
    } catch (error) {
      log('could not record a pool session', String(error))
    }
  }
}

const key = (poolId: string, taskId: string) => `${poolId}/${taskId}`
