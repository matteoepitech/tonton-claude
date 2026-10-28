// The pools one session is in (docs/pools.md): the join order its owner's app sealed with the account key, the pool key
// that came with it, and the pool as it changes, opened with that key. The order is only taken when it opens with the
// account key and names this session: the relay could hand an order to another session, it could not make one.
// When the pool key is rotated, the session opens the new version from the wrap an admin made for its member, with the
// member's private key, and publishes the member's public key under it: agents hold the account key, like the apps.
// Used by the channel of a Claude Code session and by the OpenCode bridge alike; Claude's pool tools read it (#220).

import { openPoolRulesAcceptance, openPoolSessionOrder, type PoolState, PoolVault } from '../../../shared/pool'
import { needsRepublish, PoolKeyring, resolvePoolKeyring, sealPoolMemberKey } from '../../../shared/pool-keys'
import type { PoolMachineMode, PoolRulesAcceptance, PoolUpdate } from '../../../shared/pool-protocol'
import type { AgentMessage, PermissionRule } from '../../../shared/protocol'
import { log } from '../log'

type Post = (build: () => Promise<AgentMessage | null>) => void

interface Membership {
  key: string
  version: number
  /** The machine owner's choice, from the order: start pool tasks at once, or ask the user first. */
  autoStart: boolean
  /** A session a pool machine started for a task: the machine, and the mode its owner chose (docs/pool-autopilot.md). */
  worker: PoolWorkerSession | null
  vault: PoolVault
  /** Null until the relay sent the snapshot that follows the acknowledgement. */
  state: PoolState | null
  /** The pool rules the machine owner accepted for this session, if it did. */
  acceptance: PoolRulesAcceptance | null
}

/** A pool machine's session, from the order its service sealed with the account key: never what the pool says. */
export interface PoolWorkerSession {
  machine: string
  mode: PoolMachineMode
}

/** What pool safety (agent/src/channel/pool-safety.ts) is told of. */
export interface PoolSafetyHooks {
  /** The accepted pool rules changed: an acceptance came, or the session left a pool. */
  rulesChanged(): void
  /** The owner or an admin stopped this session's work in the pool: interrupt the turn. */
  stopped(poolId: string): void
  /** The session left the pool, whatever the reason. */
  left(poolId: string): void
}

export class SessionPools {
  private readonly pools = new Map<string, Membership>()
  /** Told of every update as it comes, conflicts and errors included: the pool tools wait on them. */
  private readonly listeners = new Set<(update: PoolUpdate) => void>()
  /** Updates are opened one after the other, so the state follows the relay's order. */
  private queue: Promise<void> = Promise.resolve()
  private safety: PoolSafetyHooks = { rulesChanged: () => {}, stopped: () => {}, left: () => {} }

  constructor(
    private readonly sessionId: () => string,
    private readonly accountKey: string,
    private readonly post: Post,
    /** Told whenever a pool's state changes, or the session joins or leaves one. */
    private changed: (poolId: string) => void = () => {},
  ) {}

  /** A join order from the relay: kept and acknowledged if it is this session's, with the rules accepted for it. */
  receive(poolId: string, order: string, acceptance?: string) {
    this.post(async () => {
      const sessionId = this.sessionId()
      const opened = await openPoolSessionOrder(this.accountKey, order, sessionId, poolId)
      if (!opened) {
        log('dropped a pool order that is not for this session or does not open with the account key')
        return null
      }
      const known = this.pools.get(poolId)
      const autoStart = opened.autoStart === true
      const worker = opened.machine && opened.mode ? { machine: opened.machine, mode: opened.mode } : null
      const workerBefore = known?.worker ?? null
      if (known?.key !== opened.key) {
        const keyring = new PoolKeyring(opened.key, opened.version)
        const vault = new PoolVault(keyring)
        this.pools.set(poolId, { key: opened.key, version: opened.version, autoStart, worker, vault, state: null, acceptance: null })
      } else {
        known.autoStart = autoStart
        known.worker = worker
      }
      log('session joined a pool', { pool: poolId })
      // A pool machine's mode is applied like the rules its owner accepted.
      if (JSON.stringify(worker) !== JSON.stringify(workerBefore)) this.safety.rulesChanged()
      if (acceptance) await this.openAcceptance(poolId, acceptance)
      this.changed(poolId)
      return { t: 'pool_ack', sessionId, poolId }
    })
  }

  /** The machine owner accepted pool rules for this session, or newer ones. */
  accept(poolId: string, acceptance: string) {
    this.post(async () => {
      await this.openAcceptance(poolId, acceptance)
      return null
    })
  }

  /** Taken only if it opens with the account key and names this session and this pool: the relay could not make one. */
  private async openAcceptance(poolId: string, sealed: string) {
    const membership = this.pools.get(poolId)
    if (!membership) return
    const opened = await openPoolRulesAcceptance(this.accountKey, sealed, this.sessionId(), poolId)
    if (!opened) {
      log('dropped pool rules that are not for this session or do not open with the account key')
      return
    }
    // An older acceptance the relay hands again never replaces a newer one.
    if (membership.acceptance && membership.acceptance.issuedAt > opened.issuedAt) return
    membership.acceptance = opened
    log('pool rules accepted for this session', { pool: poolId, rules: opened.rules.length })
    this.safety.rulesChanged()
  }

  /** The owner or an admin stopped this session's work in the pool. The relay takes it out next (`pool_left`). */
  stop(poolId: string) {
    if (!this.pools.has(poolId)) return
    log('pool work stopped', { pool: poolId })
    this.safety.stopped(poolId)
  }

  remove(poolId: string) {
    const membership = this.pools.get(poolId)
    if (!membership) return
    this.pools.delete(poolId)
    log('session left a pool', { pool: poolId })
    this.safety.left(poolId)
    if (membership.acceptance || membership.worker) this.safety.rulesChanged()
    this.changed(poolId)
  }

  /** Every pool rule the machine owner accepted for this session, in every pool it is in. */
  acceptedRules(): PermissionRule[] {
    return [...this.pools.values()].flatMap(membership => membership.acceptance?.rules ?? [])
  }

  useSafety(hooks: PoolSafetyHooks) {
    this.safety = hooks
  }

  /** A change in one of the session's pools. */
  apply(update: PoolUpdate) {
    const poolId = update.t === 'pool_snapshot' ? update.pool.id : update.poolId
    const membership = this.pools.get(poolId)
    if (!membership) return
    for (const listener of this.listeners) listener(update)
    this.queue = this.queue
      .then(async () => {
        // The keys first: the snapshot and the rotation bring the wraps that open the newer blobs.
        if (update.t === 'pool_snapshot') {
          membership.state = await membership.vault.snapshot(update.pool)
          if (await this.followKeys(poolId, membership)) membership.state = await membership.vault.snapshot(update.pool)
        } else if (membership.state) {
          const next = await membership.vault.apply(membership.state, update)
          if (!next) {
            this.remove(poolId)
            return
          }
          membership.state = next
          if (update.t === 'pool_key' || update.t === 'pool_member') await this.followKeys(poolId, membership)
        } else return
        this.changed(poolId)
      })
      .catch(error => log('pool update failed', String(error)))
  }

  /**
   * Opens the versions of the pool key wrapped for the session's member, and publishes its public key under the latest
   * one when nobody did yet. True when a version was added.
   */
  private async followKeys(poolId: string, membership: Membership): Promise<boolean> {
    const state = membership.state
    const account = state?.sessions.find(session => session.session === this.sessionId())?.account
    if (!state || !account) return false
    const { keyring, secret } = await resolvePoolKeyring({
      accountKey: this.accountKey,
      poolId,
      account,
      grant: { key: membership.key, version: membership.version },
      secret: state.own.secret,
      wraps: state.own.wraps,
      members: state.members,
    })
    const held = membership.vault.keyring
    const added = keyring.versions().filter(version => !held.key(version))
    for (const version of added) held.add(version, keyring.key(version) as string)
    if (added.length) log('pool key rotated', { pool: poolId, version: held.version })
    const self = state.members.find(member => member.account === account)
    if (secret && self && needsRepublish(held, self.publicKeys)) {
      const sessionId = this.sessionId()
      this.post(async () => ({
        t: 'pool_member_key',
        sessionId,
        poolId,
        publicKey: await sealPoolMemberKey(held, poolId, account, secret),
      }))
    }
    return added.length > 0
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

  /** Set when a pool machine started this session for one of the pool's tasks. */
  worker(poolId: string): PoolWorkerSession | null {
    return this.pools.get(poolId)?.worker ?? null
  }

  /**
   * The mode this session works in, when a pool machine started it on this very machine: a worker order the relay moved
   * from another machine names that one, and counts for nothing here. In several pools, the narrowest mode wins.
   */
  workerMode(machineId: string): PoolMachineMode | null {
    const modes = [...this.pools.values()].flatMap(membership =>
      membership.worker && membership.worker.machine === machineId ? [membership.worker.mode] : [],
    )
    return (['ask', 'edits', 'full'] as const).find(mode => modes.includes(mode)) ?? null
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
