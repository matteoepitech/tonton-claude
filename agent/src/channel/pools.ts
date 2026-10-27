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
  /** The machine owner's choice, from the order: start pool tasks at once, or ask the user first. */
  autoStart: boolean
  vault: PoolVault
  /** Null until the relay sent the snapshot that follows the acknowledgement. */
  state: PoolState | null
}

export class SessionPools {
  private readonly pools = new Map<string, Membership>()
  /** Told of every update as it comes, conflicts and errors included: the pool tools wait on them. */
  private readonly listeners = new Set<(update: PoolUpdate) => void>()
  /** Updates are opened one after the other, so the state follows the relay's order. */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly sessionId: () => string,
    private readonly accountKey: string,
    private readonly post: Post,
    /** Told whenever a pool's state changes, or the session joins or leaves one. */
    private changed: (poolId: string) => void = () => {},
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
      const autoStart = opened.autoStart === true
      if (known?.key !== opened.key) {
        this.pools.set(poolId, { key: opened.key, version: opened.version, autoStart, vault: new PoolVault(opened.key), state: null })
      } else known.autoStart = autoStart
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
    for (const listener of this.listeners) listener(update)
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

  /** Who to tell of changes, once the pool tools exist. */
  onChange(changed: (poolId: string) => void) {
    this.changed = changed
  }

  autoStart(poolId: string): boolean {
    return this.pools.get(poolId)?.autoStart ?? false
  }

  /** Every update of the session's pools, as it arrives; returns how to stop listening. */
  listen(listener: (update: PoolUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Resolves once every update received so far was applied. */
  settled(): Promise<void> {
    return this.queue
  }
}
