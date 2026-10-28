// The pools this machine works for (docs/pool-autopilot.md), as its background service follows them. The order its
// owner sealed with the account key says how: the folder, the tool, how many sessions, the mode. It is only taken when it
// opens with the account key and names this machine and that pool, and never when it is older than one already taken:
// the relay could hand an order to another machine, or bring an old one back, it could not make one. The pool itself is
// opened with the key the order brought, and the later versions wrapped for the member, like a session's pools.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type PoolState, PoolVault } from '../../../shared/pool'
import { needsRepublish, PoolKeyring, resolvePoolKeyring, sealPoolMemberKey } from '../../../shared/pool-keys'
import { openPoolMachineOrder } from '../../../shared/pool-machines'
import type { PoolMachineOrder, PoolUpdate } from '../../../shared/pool-protocol'
import type { AgentMessage } from '../../../shared/protocol'
import { paths } from '../config'
import { log } from '../log'

type Post = (build: () => Promise<AgentMessage | null>) => void

interface Membership {
  order: PoolMachineOrder
  vault: PoolVault
  /** Null until the snapshot that follows the acknowledgement. */
  state: PoolState | null
}

/** The newest order taken per pool, kept on disk: an older one the relay brings back after a restart is refused. */
type Taken = Record<string, { issuedAt: string; left?: boolean }>

export class MachinePools {
  private readonly pools = new Map<string, Membership>()
  private readonly listeners = new Set<(update: PoolUpdate) => void>()
  /** Updates are opened one after the other, so the state follows the relay's order. */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly accountKey: string,
    readonly machineId: string,
    private readonly post: Post,
    /** Told whenever a pool's state or order changes, or the machine joins or leaves one. */
    private readonly changed: (poolId: string) => void,
    private readonly file = join(paths.home, 'pool-machines.json'),
  ) {}

  /** The machine's order for a pool, from the relay: kept and acknowledged if it is this machine's, and not an old one. */
  receive(poolId: string, sealed: string) {
    // Pool ids name the files the machine keeps for the pool.
    if (!/^[A-Za-z0-9_-]{12}$/.test(poolId)) return
    this.post(async () => {
      const order = await openPoolMachineOrder(this.accountKey, sealed, this.machineId, poolId)
      if (!order) {
        log('dropped a pool machine order that is not for this machine or does not open with the account key')
        return null
      }
      const taken = this.taken()[poolId]
      // The app writes dates without milliseconds, the website with them: compared as dates.
      const age = taken ? Date.parse(order.issuedAt) - Date.parse(taken.issuedAt) : 1
      // The same order again is the relay resending it on connecting, unless the machine was taken out since.
      if (Number.isNaN(age) || age < 0 || (age === 0 && taken?.left)) {
        log('dropped an older pool machine order', { pool: poolId })
        return null
      }
      this.remember(poolId, { issuedAt: order.issuedAt })
      const known = this.pools.get(poolId)
      if (known?.order.key === order.key && known.order.version === order.version) known.order = order
      else this.pools.set(poolId, { order, vault: new PoolVault(new PoolKeyring(order.key, order.version)), state: null })
      log('machine joined a pool', { pool: poolId })
      this.changed(poolId)
      return { t: 'pool_machine_ack', machineId: this.machineId, poolId }
    })
  }

  /** The machine is out of the pool: an order taken before does not bring it back. */
  remove(poolId: string) {
    const taken = this.taken()[poolId]
    if (taken) this.remember(poolId, { ...taken, left: true })
    if (!this.pools.delete(poolId)) return
    log('machine left a pool', { pool: poolId })
    this.changed(poolId)
  }

  /** A change in one of the machine's pools. */
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

  /** The member this machine is in the pool as: the relay lists it with the machine. */
  account(poolId: string): string | null {
    return this.pools.get(poolId)?.state?.machines?.find(machine => machine.machine === this.machineId)?.account ?? null
  }

  /** Opens the versions of the pool key wrapped for the member, and publishes its public key under the latest one. */
  private async followKeys(poolId: string, membership: Membership): Promise<boolean> {
    const state = membership.state
    const account = this.account(poolId)
    if (!state || !account) return false
    const { keyring, secret } = await resolvePoolKeyring({
      accountKey: this.accountKey,
      poolId,
      account,
      grant: { key: membership.order.key, version: membership.order.version },
      secret: state.own.secret,
      wraps: state.own.wraps,
      members: state.members,
    })
    const held = membership.vault.keyring
    const added = keyring.versions().filter(version => !held.key(version))
    for (const version of added) held.add(version, keyring.key(version) as string)
    const self = state.members.find(member => member.account === account)
    if (secret && self && needsRepublish(held, self.publicKeys)) {
      this.post(async () => ({
        t: 'pool_member_key',
        machineId: this.machineId,
        poolId,
        publicKey: await sealPoolMemberKey(held, poolId, account, secret),
      }))
    }
    return added.length > 0
  }

  ids(): string[] {
    return [...this.pools.keys()]
  }

  order(poolId: string): PoolMachineOrder | null {
    return this.pools.get(poolId)?.order ?? null
  }

  state(poolId: string): PoolState | null {
    return this.pools.get(poolId)?.state ?? null
  }

  vault(poolId: string): PoolVault | null {
    return this.pools.get(poolId)?.vault ?? null
  }

  /** Every update of the machine's pools, as it arrives; returns how to stop listening. */
  listen(listener: (update: PoolUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Resolves once every update received so far was applied. */
  settled(): Promise<void> {
    return this.queue
  }

  private taken(): Taken {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Taken
    } catch {
      return {}
    }
  }

  private remember(poolId: string, entry: Taken[string]) {
    try {
      const next = { ...this.taken(), [poolId]: entry }
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(`${this.file}.tmp`, JSON.stringify(next), { mode: 0o600 })
      renameSync(`${this.file}.tmp`, this.file)
    } catch (error) {
      log('could not record the pool machine order', String(error))
    }
  }
}
