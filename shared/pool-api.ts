// The pool routes of the relay, for the apps and the website: create a pool with a new key, invite, join with an invite,
// leave. The pool key is made and wrapped here; the relay only ever gets it sealed with each member's account key.

import type { AccountKey } from './crypto'
import { grantPoolKey, newPoolId, newPoolKey, PoolVault } from './pool'
import type { PoolInvite } from './pool-link'
import type { PoolInfo, PoolMemberProfile, PoolRole, PoolSummary } from './pool-protocol'

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

export class PoolApi {
  constructor(private readonly options: PoolApiOptions) {}

  /** Makes the pool and its key. The key comes back to the caller only: keep it, it is in every invite. */
  async create(accountKey: AccountKey, info: PoolInfo, profile?: PoolMemberProfile): Promise<{ pool: PoolSummary; key: string }> {
    const key = newPoolKey()
    const vault = new PoolVault(key)
    // The client picks the id, so that the member's copy of the key names its pool; the relay refuses one in use.
    const id = newPoolId()
    const body = {
      id,
      info: await vault.seal(info),
      key: await grantPoolKey(accountKey, id, key, 1),
      profile: profile ? await vault.seal(profile) : undefined,
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
  async join(accountKey: AccountKey, invite: PoolInvite, profile?: PoolMemberProfile): Promise<PoolSummary> {
    const grant = await grantPoolKey(accountKey, invite.pool, invite.key, invite.version)
    const sealedProfile = profile ? await new PoolVault(invite.key).seal(profile) : undefined
    const joined = await this.request<{ pool: PoolSummary }>('POST', '/api/pools/join', {
      invite: invite.token,
      key: grant,
      profile: sealedProfile,
    })
    return joined.pool
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
