// What a pool session spent and how much of its account's windows is left, shared with the pool sealed with the pool key:
// the control center, the leaderboard and the orchestrator read it (docs/pools.md). Posted as a `usage` event only when
// it changes enough to matter, and at most once a minute: a session writes its meta far more often than that.

import type { PoolUsage } from '../../../shared/pool-protocol'
import type { TokenCounts, UsageLimit } from '../../../shared/protocol'

/** The least time between two `usage` events of one session in one pool. */
export const USAGE_INTERVAL_MS = 60_000

/** A session's usage as the pool sees it, from its meta. Undefined when there is nothing to tell. */
export function poolUsage(meta: {
  costUSD?: number
  tokens?: TokenCounts
  fiveHourLimit?: UsageLimit
  sevenDayLimit?: UsageLimit
}): PoolUsage | undefined {
  const window = (limit: UsageLimit | undefined) =>
    limit ? { usedPercent: limit.usedPercent, ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}) } : undefined
  const usage: PoolUsage = {
    ...(meta.costUSD !== undefined ? { costUSD: meta.costUSD } : {}),
    // The pool counts what was read and written, cache included, as Claude Code's own total does.
    ...(meta.tokens
      ? { tokens: { input: meta.tokens.input + meta.tokens.cacheRead + meta.tokens.cacheWrite, output: meta.tokens.output } }
      : {}),
    ...(meta.fiveHourLimit ? { fiveHour: window(meta.fiveHourLimit) } : {}),
    ...(meta.sevenDayLimit ? { sevenDay: window(meta.sevenDayLimit) } : {}),
  }
  return Object.keys(usage).length ? usage : undefined
}

/** Two readings that would show the same: cents, thousands of tokens, whole percents. */
export function usageMark(usage: PoolUsage): string {
  const tokens = usage.tokens ? `${Math.round(usage.tokens.input / 1000)}/${Math.round(usage.tokens.output / 1000)}` : ''
  const window = (w: PoolUsage['fiveHour']) => (w ? `${Math.round(w.usedPercent)}@${w.resetsAt ?? ''}` : '')
  return [usage.costUSD === undefined ? '' : usage.costUSD.toFixed(2), tokens, window(usage.fiveHour), window(usage.sevenDay)].join('|')
}

/**
 * Decides when to post, per pool: right away the first time and after a quiet minute, otherwise once the minute is up,
 * with the latest reading. `post` is called with what to send.
 */
export class UsageSharing {
  private readonly pools = new Map<string, { mark: string; at: number; pending?: PoolUsage; timer?: ReturnType<typeof setTimeout> }>()

  constructor(
    private readonly post: (poolId: string, usage: PoolUsage) => void,
    private readonly now: () => number = Date.now,
    private readonly interval = USAGE_INTERVAL_MS,
  ) {}

  share(poolId: string, usage: PoolUsage | undefined) {
    if (!usage) return
    const mark = usageMark(usage)
    const known = this.pools.get(poolId)
    if (known?.mark === mark) {
      if (known.pending && usageMark(known.pending) !== mark) known.pending = undefined
      return
    }
    const wait = known ? known.at + this.interval - this.now() : 0
    if (!known || wait <= 0) {
      if (known?.timer) clearTimeout(known.timer)
      this.pools.set(poolId, { mark, at: this.now() })
      this.post(poolId, usage)
      return
    }
    known.pending = usage
    known.timer ??= setTimeout(() => {
      known.timer = undefined
      const pending = known.pending
      known.pending = undefined
      if (pending) this.share(poolId, pending)
    }, wait)
  }

  /** The session left the pool. */
  forget(poolId: string) {
    const known = this.pools.get(poolId)
    if (known?.timer) clearTimeout(known.timer)
    this.pools.delete(poolId)
  }
}
