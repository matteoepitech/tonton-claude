// The cluster routes of the relay, for the apps and the website: create a cluster with a new key, invite, join with an
// invite, leave, kick. The cluster key is made and wrapped here; the relay only ever gets it sealed with each member's
// account key, or wrapped for each member when it rotates.

import { ClusterVault, clusterKeyScope, grantClusterKey, newClusterId, newClusterKey, openClusterGrant } from './cluster'
import type { ClusterInvite } from './cluster-link'
import type { ClusterInfo, ClusterMemberProfile, ClusterMemberWire, ClusterSummary } from './cluster-protocol'
import type { AccountKey } from './crypto'
import {
  newPoolMemberSecret,
  PoolKeyring,
  preparePoolRotation,
  resolvePoolKeyring,
  sealPoolMemberKey,
  sealPoolMemberSecret,
} from './pool-keys'

export interface ClusterApiOptions {
  relay: string
  /** The account token, `ta_…`; or a machine's token, `tm_…`, with `agent`. */
  token: string
  /** An enrolled machine's agent: only `list` and `members` work, read only, under `/api/agent/clusters`. */
  agent?: boolean
  fetch?: typeof fetch
}

export interface ClusterInviteSummary {
  id: string
  usesLeft: number
  createdAt: string
  expiresAt: string
}

export class ClusterApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** A new key pair for this member: its private key sealed with the account key, its public key with the cluster key. */
async function memberKeys(accountKey: AccountKey, keyring: PoolKeyring, clusterId: string, account: string) {
  const scope = clusterKeyScope(clusterId)
  const secret = await newPoolMemberSecret(scope)
  return { secret: await sealPoolMemberSecret(accountKey, secret), publicKey: await sealPoolMemberKey(keyring, scope, account, secret) }
}

/** Every version of the cluster key this member holds, and its private key, from its summary and the members' keys. */
export async function resolveClusterKeyring(
  accountKey: AccountKey,
  account: string,
  summary: Pick<ClusterSummary, 'id' | 'key' | 'secret' | 'wraps'>,
  members: readonly Pick<ClusterMemberWire, 'account' | 'publicKeys'>[],
) {
  const grant = await openClusterGrant(accountKey, summary.key, summary.id)
  if (!grant) return null
  return resolvePoolKeyring({
    accountKey,
    poolId: clusterKeyScope(summary.id),
    account,
    grant,
    secret: summary.secret,
    wraps: summary.wraps,
    members,
  })
}

export class ClusterApi {
  constructor(private readonly options: ClusterApiOptions) {}

  /**
   * Makes the cluster and its key, and this member's key pair for it. The key comes back to the caller only: it is in
   * every invite. `account` is this account's id: the public key is bound to it.
   */
  async create(
    accountKey: AccountKey,
    account: string,
    info: ClusterInfo,
    profile?: ClusterMemberProfile,
  ): Promise<{ cluster: ClusterSummary; key: string }> {
    const key = newClusterKey()
    const vault = new ClusterVault(key)
    // The client picks the id, so that the member's copy of the key names its cluster; the relay refuses one in use.
    const id = newClusterId()
    const body = {
      id,
      info: await vault.seal(info),
      key: await grantClusterKey(accountKey, id, key, 1),
      profile: profile ? await vault.seal(profile) : undefined,
      ...(await memberKeys(accountKey, vault.keyring, id, account)),
    }
    const created = await this.request<{ cluster: ClusterSummary }>('POST', '/api/clusters', body)
    return { cluster: created.cluster, key }
  }

  list(): Promise<ClusterSummary[]> {
    return this.request('GET', this.options.agent ? '/api/agent/clusters' : '/api/clusters')
  }

  /** The owner deletes the cluster for everyone. */
  async remove(clusterId: string): Promise<void> {
    await this.request('DELETE', `/api/clusters/${clusterId}`)
  }

  /** A member leaves; its sessions leave with it. */
  async leave(clusterId: string): Promise<void> {
    await this.request('POST', `/api/clusters/${clusterId}/leave`, {})
  }

  /** The owner. `uses` from 1 to 100, `hours` from 1 to 720. */
  createInvite(clusterId: string, options: { uses: number; hours: number }): Promise<ClusterInviteSummary & { token: string }> {
    return this.request('POST', `/api/clusters/${clusterId}/invites`, { uses: options.uses, hours: options.hours })
  }

  invites(clusterId: string): Promise<ClusterInviteSummary[]> {
    return this.request('GET', `/api/clusters/${clusterId}/invites`)
  }

  async revokeInvite(clusterId: string, inviteId: string): Promise<void> {
    await this.request('DELETE', `/api/clusters/${clusterId}/invites/${inviteId}`)
  }

  /** Joins with an invite, keeping the cluster key wrapped with this account's key for its other devices and machines. */
  async join(accountKey: AccountKey, account: string, invite: ClusterInvite, profile?: ClusterMemberProfile): Promise<ClusterSummary> {
    const grant = await grantClusterKey(accountKey, invite.cluster, invite.key, invite.version)
    const keyring = new PoolKeyring(invite.key, invite.version)
    const sealedProfile = profile ? await new ClusterVault(keyring).seal(profile) : undefined
    const joined = await this.request<{ cluster: ClusterSummary }>('POST', '/api/clusters/join', {
      invite: invite.token,
      key: grant,
      profile: sealedProfile,
      ...(await memberKeys(accountKey, keyring, invite.cluster, account)),
    })
    return joined.cluster
  }

  /** The cluster's members, with their roles and their public keys, sealed. */
  members(clusterId: string): Promise<ClusterMemberWire[]> {
    return this.request('GET', `/api/${this.options.agent ? 'agent/' : ''}clusters/${clusterId}/members`)
  }

  /** The owner kicks a member and rotates the cluster key, so that it reads nothing written from now on. */
  kick(accountKey: AccountKey, account: string, clusterId: string, member: string) {
    return this.rotate(accountKey, account, clusterId, member)
  }

  /**
   * The owner: a new version of the cluster key, wrapped for every member whose public key it can read, minus `kick`.
   * Returns the new key and version, and who could not be wrapped for: they need a new invite. Open invites are revoked.
   */
  async rotate(
    accountKey: AccountKey,
    account: string,
    clusterId: string,
    kick?: string,
  ): Promise<{ key: string; version: number; skipped: string[] }> {
    const summary = (await this.list()).find(cluster => cluster.id === clusterId)
    if (!summary) throw new ClusterApiError(404, 'No such cluster.')
    const members = await this.members(clusterId)
    const resolved = await resolveClusterKeyring(accountKey, account, summary, members)
    if (!resolved) throw new ClusterApiError(400, 'The cluster key does not open with this account key.')
    if (!resolved.secret) throw new ClusterApiError(400, 'This member has no key pair for the cluster: join it again.')
    const key = newClusterKey()
    const rotation = await preparePoolRotation({
      keyring: resolved.keyring,
      admin: resolved.secret,
      poolId: clusterKeyScope(clusterId),
      account,
      members,
      kick,
      newKey: key,
    })
    const path = kick ? `/api/clusters/${clusterId}/members/${kick}/kick` : `/api/clusters/${clusterId}/rotate`
    await this.request('POST', path, { version: rotation.version, wraps: rotation.wraps })
    return { key, version: rotation.version, skipped: rotation.skipped }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const run = this.options.fetch ?? fetch
    const response = await run(this.options.relay.replace(/\/+$/, '') + path, {
      method,
      headers: { authorization: `Bearer ${this.options.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {}
    if (!response.ok) {
      const message = (parsed as { error?: unknown } | null)?.error
      // Relays before clusters answer 404 to every cluster route.
      throw new ClusterApiError(response.status, typeof message === 'string' ? message : `HTTP ${response.status}`)
    }
    return parsed as T
  }
}
