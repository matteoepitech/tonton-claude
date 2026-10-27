// The pool routes of an account (docs/pools.md): create a pool, list them, invite, join with an invite, leave, delete.
// Every field is checked here; blobs are sealed by the clients and stay opaque.

import type { PoolRole } from '../../shared/pool-protocol'
import type { RelayContext } from './context'
import { fail, json, readJson } from './http'
import { MAX_POOL_INFO_BYTES, MAX_POOL_INVITE_HOURS, MAX_POOL_INVITE_USES } from './limits'
import { isPoolId, isPoolRole, isSealed, isText } from './validate'

const POOL_PATH = /^\/api\/pools\/([A-Za-z0-9_-]{12})(\/leave|\/invites(?:\/([A-Za-z0-9_-]{12}))?)?$/

/** The response to a pool route, or null when the path is not one. */
export async function poolRoute(ctx: RelayContext, req: Request, path: string, accountId: string, ip: string): Promise<Response | null> {
  if (path === '/api/pools' && req.method === 'POST') return createPool(ctx, req, accountId)
  if (path === '/api/pools' && req.method === 'GET') return json(ctx.pools.summaries(accountId))
  if (path === '/api/pools/join' && req.method === 'POST') return joinPool(ctx, req, accountId, ip)

  const match = POOL_PATH.exec(path)
  if (!match) return null
  const [, poolId, rest, inviteId] = match
  const role = ctx.pools.role(poolId, accountId)
  // A pool the account is not in does not exist for it.
  if (!role) return fail(404, 'No such pool.')

  if (!rest && req.method === 'DELETE') {
    if (role !== 'owner') return fail(403, 'Only the owner can delete the pool.')
    ctx.removePool(poolId)
    return json({ ok: true })
  }
  if (rest === '/leave' && req.method === 'POST') {
    if (role === 'owner') return fail(403, 'The owner cannot leave: delete the pool instead.')
    ctx.leavePool(poolId, accountId)
    return json({ ok: true })
  }
  if (rest?.startsWith('/invites')) {
    if (role !== 'owner' && role !== 'admin') return fail(403, 'Only the owner and admins manage invites.')
    if (!inviteId && req.method === 'POST') return createInvite(ctx, req, poolId, role)
    if (!inviteId && req.method === 'GET') return json(ctx.pools.invites(poolId))
    if (inviteId && req.method === 'DELETE') {
      return ctx.pools.revokeInvite(poolId, inviteId) ? json({ ok: true }) : fail(404, 'No such invite.')
    }
  }
  return fail(404, 'not found')
}

async function createPool(ctx: RelayContext, req: Request, accountId: string): Promise<Response> {
  const body = await readJson<{ id?: unknown; info?: unknown; key?: unknown; profile?: unknown }>(req, 4 * MAX_POOL_INFO_BYTES)
  const profile = body?.profile ?? null
  if (!isPoolId(body?.id) || !isSealed(body.info, MAX_POOL_INFO_BYTES) || !isSealed(body.key, MAX_POOL_INFO_BYTES)) {
    return fail(400, 'Bad request.')
  }
  if (profile !== null && !isSealed(profile, MAX_POOL_INFO_BYTES)) return fail(400, 'Bad request.')
  const pool = ctx.pools.create(accountId, body.id, body.info, body.key, profile)
  if (!pool) return fail(409, 'This id is taken, or this account is in as many pools as it may be.')
  return json({ pool })
}

async function createInvite(ctx: RelayContext, req: Request, poolId: string, role: PoolRole): Promise<Response> {
  const body = await readJson<{ uses?: unknown; hours?: unknown; role?: unknown }>(req, 1024)
  const { uses, hours } = body ?? {}
  const invited = body?.role ?? 'member'
  if (!isCount(uses, MAX_POOL_INVITE_USES) || !isCount(hours, MAX_POOL_INVITE_HOURS) || !isPoolRole(invited) || invited === 'owner') {
    return fail(400, 'Bad request.')
  }
  // Admins invite members and viewers; only the owner makes admins.
  if (invited === 'admin' && role !== 'owner') return fail(403, 'Only the owner invites admins.')
  const invite = ctx.pools.createInvite(poolId, invited, uses, Date.now() + hours * 3_600_000)
  if (!invite) return fail(403, 'This pool has as many open invites as it may. Revoke one first.')
  return json(invite)
}

async function joinPool(ctx: RelayContext, req: Request, accountId: string, ip: string): Promise<Response> {
  if (!ctx.claims.hit(ip)) return fail(429, 'Too many attempts to join.')
  const body = await readJson<{ invite?: unknown; key?: unknown; profile?: unknown }>(req, 4 * MAX_POOL_INFO_BYTES)
  const profile = body?.profile ?? null
  if (!isText(body?.invite, 128) || !isSealed(body.key, MAX_POOL_INFO_BYTES)) return fail(400, 'Bad request.')
  if (profile !== null && !isSealed(profile, MAX_POOL_INFO_BYTES)) return fail(400, 'Bad request.')
  const joined = ctx.pools.join(body.invite, accountId, body.key, profile)
  if (!joined.ok && joined.reason === 'invalid') {
    ctx.failedAuth.hit(ip)
    return fail(401, 'This invite was revoked, used up or has expired.')
  }
  if (!joined.ok) return fail(403, 'This pool is full, or this account is in as many pools as it may be.')
  if (joined.fresh) {
    const member = ctx.pools.member(joined.poolId, accountId)
    if (member) ctx.broadcastPool(joined.poolId, { t: 'pool_member', poolId: joined.poolId, member })
  }
  return json({ pool: ctx.pools.summary(joined.poolId, accountId) })
}

const isCount = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max
