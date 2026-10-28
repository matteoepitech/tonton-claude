// What keeps a pool session in its owner's hands (docs/pools.md, Control). The agent counts what the session spends in
// each pool, from its own meta, and tells the pool; past a budget it takes no more pool tasks. When the owner or an admin
// stops the session's pool work, it interrupts the turn. And it applies the pool rules its machine owner accepted for
// it, never a proposal by itself. Used by the channel of a Claude Code session and by the OpenCode bridge alike.

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memberBudget, newPoolItemId, overBudget, type PoolSpend } from '../../../shared/pool'
import type { AgentMessage, PermissionRule, TurnTime } from '../../../shared/protocol'
import { paths } from '../config'
import { log } from '../log'
import type { SessionPools } from './pools'

type Post = (build: () => Promise<AgentMessage | null>) => void

/** What the session spent so far, as its meta says: the whole session, not only its pool work. */
export interface SessionUsage {
  costUSD?: number
  turns?: TurnTime[]
}

export interface PoolSafetyActions {
  /** Stops Claude where it is, like Escape in the terminal. Null when it was, otherwise why not. */
  interrupt(): string | null
  /** A line in the conversation, for the user. */
  notice(text: string): void
  /** The pool rules the machine owner accepted for this session, all pools together, to apply from now on. */
  rulesChanged(rules: PermissionRule[]): void
}

/** What the session spent in one pool since it joined it: kept on disk, so a restart of the agent does not reset it. */
interface Ledger {
  /** The session's cost when it joined the pool. */
  baseCost: number
  since: string
  seconds: number
  /** The turns already counted, by their end. */
  counted: string[]
}

/** A spend is posted again only when it moved this much, and not more often than this. */
const SPEND_STEP_USD = 0.01
const SPEND_STEP_SECONDS = 60
const SPEND_MIN_INTERVAL_MS = 30_000
const KEPT_TURN_ENDS = 200

export class PoolSafety {
  private readonly posted = new Map<string, PoolSpend & { at: number }>()
  /** The budget each pool was told it reached, so it is told once. */
  private readonly reported = new Map<string, string>()

  constructor(
    private readonly pools: SessionPools,
    private readonly sessionId: () => string,
    private readonly post: Post,
    private readonly usage: () => SessionUsage,
    private readonly actions: PoolSafetyActions,
    private readonly file = join(paths.home, 'pool-spend.json'),
  ) {
    pools.useSafety({
      rulesChanged: () => actions.rulesChanged(pools.acceptedRules()),
      stopped: poolId => this.stopped(poolId),
      left: poolId => this.forget(poolId),
    })
  }

  /** The session's meta changed: what it spent may have moved. */
  usageChanged() {
    for (const poolId of this.pools.ids()) this.check(poolId)
  }

  /** Why this session may take no more tasks from the pool, or null. */
  blocked(poolId: string): string | null {
    const state = this.pools.state(poolId)
    const me = state?.sessions.find(session => session.session === this.sessionId())
    const spent = this.spend(poolId)
    if (!state || !me || !spent) return null
    return overBudget(state, me.account, { session: me.session, ...spent })
  }

  /** What pool_status shows of the session's spending. */
  status(poolId: string): Record<string, unknown> | undefined {
    const state = this.pools.state(poolId)
    const me = state?.sessions.find(session => session.session === this.sessionId())
    const spent = this.spend(poolId)
    const budgets = state?.budgets?.value
    if (!state || !me || !spent || !budgets) return undefined
    return {
      spent: { costUSD: round(spent.costUSD), hours: round(spent.seconds / 3600) },
      memberBudget: memberBudget(budgets, me.account),
      poolBudget: budgets.pool,
      blocked: this.blocked(poolId) ?? undefined,
    }
  }

  private stopped(poolId: string) {
    const name = this.pools.state(poolId)?.info?.name ?? 'the pool'
    const why = this.actions.interrupt()
    this.actions.notice(
      why
        ? `The owner of ${name} stopped this session's pool work. It was not interrupted: ${why}`
        : `The owner of ${name} stopped this session's pool work: Claude was interrupted, and the session left the pool.`,
    )
  }

  /** Posts the spend when it moved, and tells the pool once when a budget is reached. */
  private check(poolId: string) {
    const spent = this.spend(poolId)
    const vault = this.pools.vault(poolId)
    if (!spent || !vault) return
    const last = this.posted.get(poolId)
    const moved = !last || spent.costUSD - last.costUSD >= SPEND_STEP_USD || spent.seconds - last.seconds >= SPEND_STEP_SECONDS
    if (moved && (!last || Date.now() - last.at >= SPEND_MIN_INTERVAL_MS)) {
      this.posted.set(poolId, { ...spent, at: Date.now() })
      this.event(poolId, { kind: 'spend', costUSD: round(spent.costUSD), seconds: Math.round(spent.seconds) })
    }
    const blocked = this.blocked(poolId)
    if (blocked && this.reported.get(poolId) !== blocked) {
      this.reported.set(poolId, blocked)
      log('pool budget reached', { pool: poolId })
      this.event(poolId, { kind: 'budget_reached', text: blocked })
      this.actions.notice(`${blocked}: this session takes no more tasks from the pool.`)
    } else if (!blocked) this.reported.delete(poolId)
  }

  private event(poolId: string, body: { kind: string; text?: string; costUSD?: number; seconds?: number }) {
    const vault = this.pools.vault(poolId)
    if (!vault) return
    this.post(async () => ({ t: 'pool_event', sessionId: this.sessionId(), poolId, id: newPoolItemId(), blob: await vault.seal(body) }))
  }

  /** What the session spent in the pool since it joined it, or null before the pool is known. */
  private spend(poolId: string): PoolSpend | null {
    if (!this.pools.state(poolId)) return null
    const usage = this.usage()
    const key = `${this.sessionId()}/${poolId}`
    const ledgers = this.read()
    const ledger: Ledger = ledgers[key] ?? { baseCost: usage.costUSD ?? 0, since: new Date().toISOString(), seconds: 0, counted: [] }
    let changed = !ledgers[key]
    for (const turn of usage.turns ?? []) {
      if (turn.end <= ledger.since || ledger.counted.includes(turn.end)) continue
      ledger.seconds += turn.seconds
      ledger.counted = [...ledger.counted, turn.end].slice(-KEPT_TURN_ENDS)
      changed = true
    }
    if (changed) this.write({ ...ledgers, [key]: ledger })
    return { costUSD: Math.max(0, (usage.costUSD ?? 0) - ledger.baseCost), seconds: ledger.seconds }
  }

  /** The session left the pool: what it spent there no longer counts. */
  forget(poolId: string) {
    this.posted.delete(poolId)
    this.reported.delete(poolId)
    const ledgers = this.read()
    const key = `${this.sessionId()}/${poolId}`
    if (!ledgers[key]) return
    delete ledgers[key]
    this.write(ledgers)
  }

  private read(): Record<string, Ledger> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  private write(ledgers: Record<string, Ledger>) {
    try {
      const partial = `${this.file}.${process.pid}.tmp`
      writeFileSync(partial, JSON.stringify(ledgers), { mode: 0o600 })
      renameSync(partial, this.file)
    } catch (error) {
      log('could not keep what the session spent in its pools', String(error))
    }
  }
}

const round = (value: number) => Math.round(value * 100) / 100
