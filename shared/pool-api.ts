// The pool routes of the relay, for the apps and the website: create a pool with a new key, invite, join with an invite,
// leave. The pool key is made and wrapped here; the relay only ever gets it sealed with each member's account key.

import type { AccountKey } from './crypto'
import { grantPoolKey, newPoolId, newPoolKey, openPoolGrant, PoolVault } from './pool'
import {
  newPoolMemberSecret,
  PoolKeyring,
  preparePoolRotation,
  resolvePoolKeyring,
  sealPoolMemberKey,
  sealPoolMemberSecret,
} from './pool-keys'
import type { PoolInvite } from './pool-link'
import type { PoolInfo, PoolMemberProfile, PoolMemberWire, PoolRole, PoolSummary } from './pool-protocol'

export interface PoolApiOptions {
  relay: string
  /** The account token, `ta_…`. */
  token: string
  fetch?: typeof fetch
}

export interface InviteSummary {
  id: string
  role: PoolRole
  usesLeft: number
  createdAt: string
  expiresAt: string
}

export class PoolApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** A new key pair for this member: its private key sealed with the account key, its public key with the pool key. */
async function memberKeys(accountKey: AccountKey, keyring: PoolKeyring, poolId: string, account: string) {
  const secret = await newPoolMemberSecret(poolId)
  return { secret: await sealPoolMemberSecret(accountKey, secret), publicKey: await sealPoolMemberKey(keyring, poolId, account, secret) }
}

export class PoolApi {
  constructor(private readonly options: PoolApiOptions) {}

  /**
   * Makes the pool and its key, and this member's key pair for it. The key comes back to the caller only: keep it, it is
   * in every invite. `account` is this account's id: the public key is bound to it.
   */
  async create(
    accountKey: AccountKey,
    account: string,
    info: PoolInfo,
    profile?: PoolMemberProfile,
  ): Promise<{ pool: PoolSummary; key: string }> {
    const key = newPoolKey()
    const vault = new PoolVault(key)
    // The client picks the id, so that the member's copy of the key names its pool; the relay refuses one in use.
    const id = newPoolId()
    const body = {
      id,
      info: await vault.seal(info),
      key: await grantPoolKey(accountKey, id, key, 1),
      profile: profile ? await vault.seal(profile) : undefined,
      ...(await memberKeys(accountKey, vault.keyring, id, account)),
    }
    const created = await this.request<{ pool: PoolSummary }>('POST', '/api/pools', body)
    return { pool: created.pool, key }
  }

  list(): Promise<PoolSummary[]> {
    return this.request('GET', '/api/pools')
  }

  /** The owner deletes the pool for everyone. */
  async remove(poolId: string): Promise<void> {
    await this.request('DELETE', `/api/pools/${poolId}`)
  }

  /** A member leaves; its sessions leave with it. */
  async leave(poolId: string): Promise<void> {
    await this.request('POST', `/api/pools/${poolId}/leave`, {})
  }

  /** Owner and admins. `uses` from 1 to 100, `hours` from 1 to 720. */
  createInvite(poolId: string, options: { uses: number; hours: number; role?: PoolRole }): Promise<InviteSummary & { token: string }> {
    return this.request('POST', `/api/pools/${poolId}/invites`, {
      uses: options.uses,
      hours: options.hours,
      role: options.role ?? 'member',
    })
  }

  invites(poolId: string): Promise<InviteSummary[]> {
    return this.request('GET', `/api/pools/${poolId}/invites`)
  }

  async revokeInvite(poolId: string, inviteId: string): Promise<void> {
    await this.request('DELETE', `/api/pools/${poolId}/invites/${inviteId}`)
  }

  /** Joins with an invite, keeping the pool key wrapped with this account's key for its other devices and machines. */
  async join(accountKey: AccountKey, account: string, invite: PoolInvite, profile?: PoolMemberProfile): Promise<PoolSummary> {
    const grant = await grantPoolKey(accountKey, invite.pool, invite.key, invite.version)
    const keyring = new PoolKeyring(invite.key, invite.version)
    const sealedProfile = profile ? await new PoolVault(keyring).seal(profile) : undefined
    const joined = await this.request<{ pool: PoolSummary }>('POST', '/api/pools/join', {
      invite: invite.token,
      key: grant,
      profile: sealedProfile,
      ...(await memberKeys(accountKey, keyring, invite.pool, account)),
    })
    return joined.pool
  }

  /** The pool's members, with their roles and their public keys, sealed. */
  members(poolId: string): Promise<PoolMemberWire[]> {
    return this.request('GET', `/api/pools/${poolId}/members`)
  }

  /** Owner: anyone to admin, member or viewer. Admins: members and viewers. */
  async setRole(poolId: string, account: string, role: Exclude<PoolRole, 'owner'>): Promise<void> {
    await this.request('POST', `/api/pools/${poolId}/members/${account}/role`, { role })
  }

  /** The owner hands the pool to another member and stays as an admin. */
  async transferOwnership(poolId: string, account: string): Promise<void> {
    await this.request('POST', `/api/pools/${poolId}/owner`, { account })
  }

  /** Kicks a member and rotates the pool key, so that it reads nothing written from now on. */
  kick(accountKey: AccountKey, account: string, poolId: string, member: string) {
    return this.rotate(accountKey, account, poolId, member)
  }

  /**
   * A new version of the pool key, wrapped for every member this admin can read the public key of, minus `kick`. Returns
   * the new key and version, and who could not be wrapped for: they need a new invite. Every open invite is revoked.
   */
  async rotate(
    accountKey: AccountKey,
    account: string,
    poolId: string,
    kick?: string,
  ): Promise<{ key: string; version: number; skipped: string[] }> {
    const summary = (await this.list()).find(pool => pool.id === poolId)
    if (!summary) throw new PoolApiError(404, 'No such pool.')
    const grant = await openPoolGrant(accountKey, summary.key, poolId)
    if (!grant) throw new PoolApiError(400, 'The pool key does not open with this account key.')
    const members = await this.members(poolId)
    const { keyring, secret } = await resolvePoolKeyring({
      accountKey,
      poolId,
      account,
      grant,
      secret: summary.secret,
      wraps: summary.wraps,
      members,
    })
    if (!secret) throw new PoolApiError(400, 'This member has no key pair for the pool: join it again.')
    const key = newPoolKey()
    const rotation = await preparePoolRotation({ keyring, admin: secret, poolId, account, members, kick, newKey: key })
    const path = kick ? `/api/pools/${poolId}/members/${kick}/kick` : `/api/pools/${poolId}/rotate`
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
      // Relays before pools answer 404 to every pool route.
      throw new PoolApiError(response.status, typeof message === 'string' ? message : `HTTP ${response.status}`)
    }
    return parsed as T
  }
}
