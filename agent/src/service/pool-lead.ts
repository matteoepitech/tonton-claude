// The orchestrator machine's session (docs/pool-autopilot.md). When the admin makes one of their own pool machines the
// orchestrator machine, its background service starts a Claude Code session in `<workdir>/repo` and puts it in the pool
// as the orchestrator: the relay makes it the pool's orchestrator, its agent gives it the guide, and the admin talks to
// it from the website, as to any of their own sessions. A session that ends is started again, later each time; once the
// machine is not the orchestrator's any more, its session ends.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../config'
import { endPoolSession, launchForPool, poolSessionRuns } from '../launch'
import { log } from '../log'
import type { MachinePools } from './pool-machines'
import { prepareRepository, repositoryName } from './pool-worktree'

const CHECK_MS = 10_000
/** After a session that ended or did not start, the next start waits this long, then longer. */
const RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000]

/** The orchestrator session this machine runs for a pool, kept on disk so that a restarted service finds it again. */
interface Lead {
  poolId: string
  sessionId: string
  tmux: string
  /** The session is in the pool. */
  joined: boolean
}

export interface PoolLeadOptions {
  machineName: string
  home?: string
  launch?: typeof launchForPool
  runs?: (tmux: string) => boolean
  end?: (tmux: string) => void
  prepare?: typeof prepareRepository
  /** How long the next start waits after each failure in a row. */
  retryMs?: number[]
}

export class PoolLead {
  private readonly leads = new Map<string, Lead>()
  private readonly starting = new Map<string, Promise<void>>()
  /** Once stopped, for another relay or account, nothing more is started or ended: the next one takes over. */
  private stopped = false
  /** Starts that failed in a row per pool, and when the next one may come. */
  private readonly retries = new Map<string, { failures: number; next: number }>()
  private queue: Promise<void> = Promise.resolve()
  private readonly timer: ReturnType<typeof setInterval>
  private readonly folder: string

  constructor(
    private readonly pools: MachinePools,
    private readonly options: PoolLeadOptions,
  ) {
    this.folder = join(options.home ?? paths.home, 'pool-leads')
    for (const lead of this.read()) this.leads.set(lead.poolId, lead)
    this.timer = setInterval(() => {
      for (const poolId of new Set([...this.pools.ids(), ...this.leads.keys()])) this.changed(poolId)
    }, CHECK_MS)
    this.timer.unref?.()
  }

  stop() {
    this.stopped = true
    clearInterval(this.timer)
  }

  changed(poolId: string) {
    if (this.stopped) return
    this.queue = this.queue.then(() => this.reconcile(poolId)).catch(error => log('pool orchestrator session failed', String(error)))
  }

  /** Resolves once what was asked so far is done, the starts going on included. */
  async settled(): Promise<void> {
    await this.queue
    await Promise.all(this.starting.values())
  }

  /** The orchestrator session this machine runs for the pool, if it does. */
  session(poolId: string): string | null {
    return this.leads.get(poolId)?.sessionId ?? null
  }

  private async reconcile(poolId: string) {
    if (this.starting.has(poolId)) return
    const lead = this.leads.get(poolId)
    const state = this.pools.state(poolId)
    const account = this.pools.account(poolId)
    const order = this.pools.order(poolId)
    const ours = Boolean(
      order &&
        state &&
        account &&
        state.orchestratorMachine?.machine === this.pools.machineId &&
        state.orchestratorMachine.account === account,
    )
    // Before the first snapshot, nothing is known yet: a session of an earlier run is left as it is.
    if (order && !state) return
    if (!ours || !state) {
      if (lead) this.end(lead)
      this.retries.delete(poolId)
      return
    }
    const runs = this.options.runs ?? poolSessionRuns
    if (lead && runs(lead.tmux) && (!lead.joined || state.sessions.some(session => session.session === lead.sessionId))) return
    // It ended, or the pool took it out: another one, after a while.
    if (lead) {
      this.end(lead)
      this.failed(poolId)
    }
    if ((this.retries.get(poolId)?.next ?? 0) > Date.now()) return
    this.starting.set(poolId, this.start(poolId))
  }

  private async start(poolId: string) {
    try {
      const why = await this.run(poolId)
      if (why) {
        log('pool orchestrator session could not start', { pool: poolId })
        this.failed(poolId)
        await this.pools.event(
          poolId,
          'orchestrator_failed',
          undefined,
          `${this.options.machineName} could not start the orchestrator: ${why.split('\n')[0]}`,
        )
      } else this.retries.delete(poolId)
    } finally {
      this.starting.delete(poolId)
      // What changed while it started (it ended already, or the machine is not the orchestrator's any more) is seen now.
      this.changed(poolId)
    }
  }

  /** The repository, the session, the pool: null once the session is the pool's orchestrator, otherwise why not. */
  private async run(poolId: string): Promise<string | null> {
    const order = this.pools.order(poolId)
    const repo = this.pools.state(poolId)?.info?.repo
    if (!order) return 'the machine left the pool.'
    if (!repo) return 'the pool has no repository to clone.'
    const prepared = await (this.options.prepare ?? prepareRepository)(order.profile.workdir, repo)
    if (typeof prepared === 'string') return prepared
    // Always Claude Code: it plans, merges and answers the admin.
    const launched = await (this.options.launch ?? launchForPool)(`lead-${poolId}`, prepared.clone, 'claude')
    if (typeof launched === 'string') return launched
    const lead: Lead = { poolId, sessionId: launched.sessionId, tmux: launched.tmux, joined: false }
    this.leads.set(poolId, lead)
    this.save(lead)
    const profile = { tool: 'claude' as const, machine: this.options.machineName, project: repositoryName(repo) }
    if (!(await this.pools.joinSession(poolId, launched.sessionId, profile, true))) {
      this.end(lead)
      return 'its session did not reach the relay.'
    }
    lead.joined = true
    this.save(lead)
    log('pool orchestrator session started', { pool: poolId })
    return null
  }

  private failed(poolId: string) {
    const failures = (this.retries.get(poolId)?.failures ?? 0) + 1
    const delays = this.options.retryMs ?? RETRY_MS
    const delay = delays[Math.min(failures, delays.length) - 1]
    this.retries.set(poolId, { failures, next: Date.now() + delay })
    // Looked at again once the wait is over, whether or not the pool changed meanwhile.
    setTimeout(() => this.changed(poolId), delay + 50).unref?.()
  }

  private end(lead: Lead) {
    ;(this.options.end ?? endPoolSession)(lead.tmux)
    if (lead.joined) this.pools.leaveSession(lead.poolId, lead.sessionId)
    this.leads.delete(lead.poolId)
    rmSync(join(this.folder, `${lead.poolId}.json`), { force: true })
    log('pool orchestrator session ended', { pool: lead.poolId })
  }

  private read(): Lead[] {
    try {
      return readdirSync(this.folder)
        .filter(file => file.endsWith('.json'))
        .flatMap(file => {
          try {
            const lead = JSON.parse(readFileSync(join(this.folder, file), 'utf8')) as Lead
            return typeof lead.poolId === 'string' && typeof lead.tmux === 'string' && typeof lead.sessionId === 'string' ? [lead] : []
          } catch {
            return []
          }
        })
    } catch {
      return []
    }
  }

  private save(lead: Lead) {
    try {
      mkdirSync(this.folder, { recursive: true, mode: 0o700 })
      writeFileSync(join(this.folder, `${lead.poolId}.json`), JSON.stringify(lead), { mode: 0o600 })
    } catch (error) {
      log('could not record the pool orchestrator session', String(error))
    }
  }
}
