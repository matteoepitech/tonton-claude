// The pools one session is in (docs/pools.md): the join order its owner's app sealed with the account key, the pool key
// that came with it, and the pool as it changes, opened with that key. The order is only taken when it opens with the
// account key and names this session: the relay could hand an order to another session, it could not make one.
// Used by the channel of a Claude Code session and by the OpenCode bridge alike; Claude's pool tools read it (#220).

import { openPoolSessionOrder, type PoolState, PoolVault } from '../../../shared/pool'
import type { PoolUpdate } from '../../../shared/pool-protocol'
import type { AgentMessage } from '../../../shared/protocol'
import { log } from '../log'

type Post = (build: () => Promise<AgentMessage | null>) => void

interface Membership {
  key: string
  version: number
  vault: PoolVault
  /** Null until the relay sent the snapshot that follows the acknowledgement. */
  state: PoolState | null
}

export class SessionPools {
  private readonly pools = new Map<string, Membership>()
  /** Updates are opened one after the other, so the state follows the relay's order. */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly sessionId: () => string,
    private readonly accountKey: string,
    private readonly post: Post,
    /** Told whenever a pool's state changes, or the session joins or leaves one. */
    private readonly changed: (poolId: string) => void = () => {},
  ) {}

  /** A join order from the relay: kept and acknowledged if it is this session's. */
  receive(poolId: string, order: string) {
    this.post(async () => {
      const sessionId = this.sessionId()
      const opened = await openPoolSessionOrder(this.accountKey, order, sessionId, poolId)
      if (!opened) {
        log('dropped a pool order that is not for this session or does not open with the account key')
        return null
      }
      const known = this.pools.get(poolId)
      if (known?.key !== opened.key) {
        this.pools.set(poolId, { key: opened.key, version: opened.version, vault: new PoolVault(opened.key), state: null })
      }
      log('session joined a pool', { pool: poolId })
      this.changed(poolId)
      return { t: 'pool_ack', sessionId, poolId }
    })
  }

  remove(poolId: string) {
    if (!this.pools.delete(poolId)) return
    log('session left a pool', { pool: poolId })
    this.changed(poolId)
  }

  /** A change in one of the session's pools. */
  apply(update: PoolUpdate) {
    const poolId = update.t === 'pool_snapshot' ? update.pool.id : update.poolId
    const membership = this.pools.get(poolId)
    if (!membership) return
    this.queue = this.queue
      .then(async () => {
        if (update.t === 'pool_snapshot') membership.state = await membership.vault.snapshot(update.pool)
        else if (membership.state) {
          const next = await membership.vault.apply(membership.state, update)
          if (!next) {
            this.remove(poolId)
            return
          }
          membership.state = next
        } else return
        this.changed(poolId)
      })
      .catch(error => log('pool update failed', String(error)))
  }

  /** The pools the session is in. */
  ids(): string[] {
    return [...this.pools.keys()]
  }

  state(poolId: string): PoolState | null {
    return this.pools.get(poolId)?.state ?? null
  }

  /** Seals with the pool's key, for what the session posts to it. */
  vault(poolId: string): PoolVault | null {
    return this.pools.get(poolId)?.vault ?? null
  }

  /** Resolves once every update received so far was applied. */
  settled(): Promise<void> {
    return this.queue
  }
}
