// The pool routes of an account (docs/pools.md): create a pool, list them, invite, join with an invite, leave, delete.
// Every field is checked here; blobs are sealed by the clients and stay opaque.

import type { PoolRole } from '../../shared/pool-protocol'
import type { RelayContext } from './context'
import { fail, json, readJson } from './http'
import { MAX_POOL_INFO_BYTES, MAX_POOL_INVITE_HOURS, MAX_POOL_INVITE_USES, MAX_POOL_KEY_BYTES, MAX_POOL_MEMBERS } from './limits'
import type { MemberKeys } from './pools'
import { isAccountId, isPoolId, isPoolRole, isSealed, isText } from './validate'

const POOL_PATH =
  /^\/api\/pools\/([A-Za-z0-9_-]{12})(\/leave|\/rotate|\/owner|\/members(?:\/([A-Za-z0-9_-]{12})\/(role|kick))?|\/invites(?:\/([A-Za-z0-9_-]{12}))?)?$/

/** The response to a pool route, or null when the path is not one. */
export async function poolRoute(ctx: RelayContext, req: Request, path: string, accountId: string, ip: string): Promise<Response | null> {
  if (path === '/api/pools' && req.method === 'POST') return createPool(ctx, req, accountId)
  if (path === '/api/pools' && req.method === 'GET') return json(ctx.pools.summaries(accountId))
  if (path === '/api/pools/join' && req.method === 'POST') return joinPool(ctx, req, accountId, ip)

  const match = POOL_PATH.exec(path)
  if (!match) return null
  const [, poolId, rest, memberId, memberAction, inviteId] = match
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
    ctx.auditPool(poolId, { accountId, sessionId: null }, 'left')
    return json({ ok: true })
  }
  if (rest === '/members' && req.method === 'GET') return json(ctx.pools.members(poolId))
  if (memberId && memberAction === 'role' && req.method === 'POST') return setRole(ctx, req, poolId, accountId, role, memberId)
  if (memberId && memberAction === 'kick' && req.method === 'POST') return rotate(ctx, req, poolId, accountId, role, memberId)
  if (rest === '/rotate' && req.method === 'POST') return rotate(ctx, req, poolId, accountId, role, null)
  if (rest === '/owner' && req.method === 'POST') return transferOwner(ctx, req, poolId, accountId, role)
  if (rest?.startsWith('/invites')) {
    if (role !== 'owner' && role !== 'admin') return fail(403, 'Only the owner and admins manage invites.')
    if (!inviteId && req.method === 'POST') return createInvite(ctx, req, poolId, accountId, role)
    if (!inviteId && req.method === 'GET') return json(ctx.pools.invites(poolId))
    if (inviteId && req.method === 'DELETE') {
      if (!ctx.pools.revokeInvite(poolId, inviteId)) return fail(404, 'No such invite.')
      ctx.auditPool(poolId, { accountId, sessionId: null }, 'invite_revoked')
      return json({ ok: true })
    }
  }
  return fail(404, 'not found')
}

/** The keys a member publishes on creating or joining a pool, or null when they are missing or too big. */
function memberKeys(body: { publicKey?: unknown; secret?: unknown } | null): MemberKeys | null {
  return isSealed(body?.publicKey, MAX_POOL_KEY_BYTES) && isSealed(body.secret, MAX_POOL_KEY_BYTES)
    ? { publicKey: body.publicKey, secret: body.secret }
    : null
}

async function createPool(ctx: RelayContext, req: Request, accountId: string): Promise<Response> {
  const body = await readJson<{ id?: unknown; info?: unknown; key?: unknown; profile?: unknown; publicKey?: unknown; secret?: unknown }>(
    req,
    4 * MAX_POOL_INFO_BYTES,
  )
  const profile = body?.profile ?? null
  const keys = memberKeys(body)
  if (!isPoolId(body?.id) || !isSealed(body.info, MAX_POOL_INFO_BYTES) || !isSealed(body.key, MAX_POOL_INFO_BYTES) || !keys) {
    return fail(400, 'Bad request.')
  }
  if (profile !== null && !isSealed(profile, MAX_POOL_INFO_BYTES)) return fail(400, 'Bad request.')
  const pool = ctx.pools.create(accountId, body.id, body.info, body.key, profile, keys)
  if (!pool) return fail(409, 'This id is taken, or this account is in as many pools as it may be.')
  ctx.auditPool(pool.id, { accountId, sessionId: null }, 'created')
  return json({ pool })
}

async function createInvite(ctx: RelayContext, req: Request, poolId: string, accountId: string, role: PoolRole): Promise<Response> {
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
  ctx.auditPool(poolId, { accountId, sessionId: null }, 'invite_created')
  return json(invite)
}

async function joinPool(ctx: RelayContext, req: Request, accountId: string, ip: string): Promise<Response> {
  if (!ctx.claims.hit(ip)) return fail(429, 'Too many attempts to join.')
  const body = await readJson<{ invite?: unknown; key?: unknown; profile?: unknown; publicKey?: unknown; secret?: unknown }>(
    req,
    4 * MAX_POOL_INFO_BYTES,
  )
  const profile = body?.profile ?? null
  const keys = memberKeys(body)
  if (!isText(body?.invite, 128) || !isSealed(body.key, MAX_POOL_INFO_BYTES) || !keys) return fail(400, 'Bad request.')
  if (profile !== null && !isSealed(profile, MAX_POOL_INFO_BYTES)) return fail(400, 'Bad request.')
  const joined = ctx.pools.join(body.invite, accountId, body.key, profile, keys)
  if (!joined.ok && joined.reason === 'invalid') {
    ctx.failedAuth.hit(ip)
    return fail(401, 'This invite was revoked, used up or has expired.')
  }
  if (!joined.ok) return fail(403, 'This pool is full, or this account is in as many pools as it may be.')
  if (joined.fresh) {
    const member = ctx.pools.member(joined.poolId, accountId)
    if (member) ctx.broadcastPool(joined.poolId, { t: 'pool_member', poolId: joined.poolId, member })
    ctx.auditPool(joined.poolId, { accountId, sessionId: null }, 'joined')
  }
  return json({ pool: ctx.pools.summary(joined.poolId, accountId) })
}

/** Owner: anyone but itself to admin, member or viewer. Admins: members and viewers to member or viewer. */
async function setRole(
  ctx: RelayContext,
  req: Request,
  poolId: string,
  actor: string,
  actorRole: PoolRole,
  target: string,
): Promise<Response> {
  const body = await readJson<{ role?: unknown }>(req, 1024)
  const role = body?.role
  if (!isPoolRole(role) || role === 'owner') return fail(400, 'Bad request. Hand the pool over with /owner.')
  const current = ctx.pools.role(poolId, target)
  if (!current) return fail(404, 'No such member.')
  if (target === actor || current === 'owner') return fail(403, 'This role cannot be changed here.')
  const allowed = actorRole === 'owner' || (actorRole === 'admin' && current !== 'admin' && role !== 'admin')
  if (!allowed) return fail(403, 'Only the owner makes or changes admins; admins change members and viewers.')
  ctx.pools.setRole(poolId, target, role)
  const member = ctx.pools.member(poolId, target)
  if (member) ctx.broadcastPool(poolId, { t: 'pool_member', poolId, member })
  ctx.auditPool(poolId, { accountId: actor, sessionId: null }, 'role', { account: target })
  return json({ ok: true })
}

/**
 * A new version of the pool key, wrapped for every member left: `kick` takes one member out first. The owner kicks
 * anyone but itself, admins kick members and viewers. Anyone who rotates must be an owner or admin.
 */
async function rotate(
  ctx: RelayContext,
  req: Request,
  poolId: string,
  actor: string,
  actorRole: PoolRole,
  kick: string | null,
): Promise<Response> {
  if (actorRole !== 'owner' && actorRole !== 'admin') return fail(403, 'Only the owner and admins rotate the pool key or kick.')
  if (kick !== null) {
    const target = ctx.pools.role(poolId, kick)
    if (!target) return fail(404, 'No such member.')
    if (target === 'owner' || kick === actor) return fail(403, 'The owner cannot be kicked, and nobody kicks themselves: leave instead.')
    if (target === 'admin' && actorRole !== 'owner') return fail(403, 'Only the owner kicks admins.')
  }
  const body = await readJson<{ version?: unknown; wraps?: unknown }>(req, (MAX_POOL_MEMBERS + 1) * (MAX_POOL_KEY_BYTES + 128))
  const version = body?.version
  const wraps = Array.isArray(body?.wraps) ? body.wraps : null
  if (typeof version !== 'number' || !Number.isInteger(version) || !wraps || wraps.length > MAX_POOL_MEMBERS)
    return fail(400, 'Bad request.')
  const parsed = wraps.map(wrap => wrap as { account?: unknown; blob?: unknown })
  if (!parsed.every(wrap => isAccountId(wrap?.account) && isSealed(wrap.blob, MAX_POOL_KEY_BYTES))) return fail(400, 'Bad request.')
  // Read before the kick: the machines go with their member.
  const kickedMachines = kick ? ctx.poolMachines.ofAccount(poolId, kick) : []
  const result = ctx.pools.rotate(
    poolId,
    actor,
    version,
    parsed.map(wrap => ({ account: wrap.account as string, blob: wrap.blob as string })),
    kick,
  )
  if (!result.ok) {
    const why = {
      version: 'The pool key changed meanwhile: fetch the pool and try again.',
      wraps: 'Every member left with a public key, you included, needs exactly one wrap.',
      target: 'No such member to kick.',
      limit: 'This pool key was rotated as many times as it may be.',
    }[result.reason]
    return fail(result.reason === 'version' ? 409 : 400, why)
  }
  ctx.poolKeyRotated(
    poolId,
    version,
    result.remaining,
    kick && result.kicked ? { account: kick, sessions: result.kicked, machines: kickedMachines } : null,
  )
  const author = { accountId: actor, sessionId: null }
  if (kick) ctx.auditPool(poolId, author, 'kicked', { account: kick }, version)
  else ctx.auditPool(poolId, author, 'rotated', {}, version)
  return json({ ok: true, keyVersion: version })
}

async function transferOwner(ctx: RelayContext, req: Request, poolId: string, actor: string, actorRole: PoolRole): Promise<Response> {
  if (actorRole !== 'owner') return fail(403, 'Only the owner hands the pool over.')
  const body = await readJson<{ account?: unknown }>(req, 1024)
  if (!isAccountId(body?.account)) return fail(400, 'Bad request.')
  if (!ctx.pools.transferOwner(poolId, actor, body.account)) return fail(404, 'No such member.')
  for (const account of [actor, body.account]) {
    const member = ctx.pools.member(poolId, account)
    if (member) ctx.broadcastPool(poolId, { t: 'pool_member', poolId, member })
  }
  ctx.auditPool(poolId, { accountId: actor, sessionId: null }, 'owner', { account: body.account })
  return json({ ok: true })
}

const isCount = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max
