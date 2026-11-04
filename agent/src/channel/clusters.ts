// The clusters one session is in (docs/cluster.md): the order its owner sealed with the account key, the cluster key that
// came with it, and the cluster as it changes, opened with that key. The order is only taken when it opens with the
// account key and names this session: the relay could hand an order to another session, it could not make one.
// When the cluster key is rotated, the session opens the new version from the wrap the owner made for its member, with
// the member's private key, and publishes the member's public key under it, as pool sessions do (channel/pools.ts).
// Used by the channel of a Claude Code session and by the OpenCode bridge alike; Claude's cluster tools read it.

import { type ClusterState, ClusterVault, clusterKeyScope, openClusterSessionOrder } from '../../../shared/cluster'
import type { ClusterSessionOrder, ClusterUpdate } from '../../../shared/cluster-protocol'
import { needsRepublish, PoolKeyring, resolvePoolKeyring, sealPoolMemberKey } from '../../../shared/pool-keys'
import type { AgentMessage } from '../../../shared/protocol'
import { log } from '../log'

type Post = (build: () => Promise<AgentMessage | null>) => void

interface Membership {
  order: ClusterSessionOrder
  vault: ClusterVault
  /** Null until the relay sent the snapshot that follows the acknowledgement. */
  state: ClusterState | null
}

export class SessionClusters {
  private readonly clusters = new Map<string, Membership>()
  /** When the session left each cluster: an order issued before that is an old one the relay hands again. */
  private readonly leftAt = new Map<string, string>()
  /** Told of every update as it comes, conflicts and errors included: the cluster tools wait on them. */
  private readonly listeners = new Set<(update: ClusterUpdate) => void>()
  /** Updates are opened one after the other, so the state follows the relay's order. */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly sessionId: () => string,
    private readonly accountKey: string,
    private readonly post: Post,
    /** Told whenever a cluster's state changes, or the session joins or leaves one. */
    private changed: (clusterId: string) => void = () => {},
  ) {}

  /** An order from the relay: kept and acknowledged if it is this session's, newer than its last leave. */
  receive(clusterId: string, sealed: string) {
    this.post(async () => {
      const sessionId = this.sessionId()
      const order = await openClusterSessionOrder(this.accountKey, sealed, sessionId, clusterId)
      if (!order) {
        log('dropped a cluster order that is not for this session or does not open with the account key')
        return null
      }
      const left = this.leftAt.get(clusterId)
      if (left && order.issuedAt <= left) {
        log('dropped a cluster order older than the session leaving it', { cluster: clusterId })
        return null
      }
      const known = this.clusters.get(clusterId)
      // An older order the relay hands again never replaces a newer one.
      if (known && known.order.issuedAt > order.issuedAt) return null
      if (known?.order.key === order.key) known.order = order
      else this.clusters.set(clusterId, { order, vault: new ClusterVault(new PoolKeyring(order.key, order.version)), state: null })
      log('session joined a cluster', { cluster: clusterId, delivery: order.delivery ?? 'default' })
      this.changed(clusterId)
      return { t: 'cluster_ack', sessionId, clusterId }
    })
  }

  remove(clusterId: string) {
    if (!this.clusters.delete(clusterId)) return
    this.leftAt.set(clusterId, new Date().toISOString())
    log('session left a cluster', { cluster: clusterId })
    this.changed(clusterId)
  }

  /** A change in one of the session's clusters. Updates of a cluster it is not in are dropped. */
  apply(update: ClusterUpdate) {
    const clusterId = update.t === 'cluster_snapshot' ? update.cluster.id : update.clusterId
    const membership = this.clusters.get(clusterId)
    if (!membership) return
    for (const listener of this.listeners) listener(update)
    this.queue = this.queue
      .then(async () => {
        if (this.clusters.get(clusterId) !== membership) return
        // The keys first: the snapshot and the rotation bring the wraps that open the newer blobs.
        if (update.t === 'cluster_snapshot') {
          membership.state = await membership.vault.snapshot(update.cluster)
          if (await this.followKeys(clusterId, membership)) membership.state = await membership.vault.snapshot(update.cluster)
        } else if (membership.state) {
          const next = await membership.vault.apply(membership.state, update)
          if (!next) {
            this.remove(clusterId)
            return
          }
          membership.state = next
          if (update.t === 'cluster_key' || update.t === 'cluster_member') await this.followKeys(clusterId, membership)
        } else return
        this.changed(clusterId)
      })
      .catch(error => log('cluster update failed', String(error)))
  }

  /**
   * Opens the versions of the cluster key wrapped for the session's member, and publishes its public key under the
   * latest one when nobody did yet. True when a version was added.
   */
  private async followKeys(clusterId: string, membership: Membership): Promise<boolean> {
    const state = membership.state
    const account = this.account(clusterId)
    if (!state || !account) return false
    const scope = clusterKeyScope(clusterId)
    const { keyring, secret } = await resolvePoolKeyring({
      accountKey: this.accountKey,
      poolId: scope,
      account,
      grant: { key: membership.order.key, version: membership.order.version },
      secret: state.own.secret,
      wraps: state.own.wraps,
      members: state.members,
    })
    const held = membership.vault.keyring
    const added = keyring.versions().filter(version => !held.key(version))
    for (const version of added) held.add(version, keyring.key(version) as string)
    if (added.length) log('cluster key rotated', { cluster: clusterId, version: held.version })
    const self = state.members.find(member => member.account === account)
    if (secret && self && needsRepublish(held, self.publicKeys)) {
      const sessionId = this.sessionId()
      this.post(async () => ({
        t: 'cluster_member_key',
        sessionId,
        clusterId,
        publicKey: await sealPoolMemberKey(held, scope, account, secret),
      }))
    }
    return added.length > 0
  }

  /** The clusters the session is in. */
  ids(): string[] {
    return [...this.clusters.keys()]
  }

  state(clusterId: string): ClusterState | null {
    return this.clusters.get(clusterId)?.state ?? null
  }

  /** Seals with the cluster's key, for what the session posts to it. */
  vault(clusterId: string): ClusterVault | null {
    return this.clusters.get(clusterId)?.vault ?? null
  }

  /** The order its owner sealed: how the session takes posts. */
  order(clusterId: string): ClusterSessionOrder | null {
    return this.clusters.get(clusterId)?.order ?? null
  }

  /** The account of this session, as the cluster lists it. */
  account(clusterId: string): string | undefined {
    return this.state(clusterId)?.sessions.find(session => session.session === this.sessionId())?.account
  }

  /** Who to tell of changes, once the cluster tools exist. */
  onChange(changed: (clusterId: string) => void) {
    this.changed = changed
  }

  /** Every update of the session's clusters, as it arrives; returns how to stop listening. */
  listen(listener: (update: ClusterUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Resolves once every update received so far was applied. */
  settled(): Promise<void> {
    return this.queue
  }
}
