// The cluster routes of an account (docs/cluster.md): create a cluster, list them, invite, join with an invite, leave,
// kick, delete. Every field is checked here; blobs are sealed by the clients and stay opaque. The owner manages the
// cluster; members only leave.

import { broadcastCluster, clusterKeyRotated, leaveCluster, removeCluster } from './cluster-sockets'
import type { ClusterMemberKeys } from './clusters'
import type { RelayContext } from './context'
import { fail, json, readJson } from './http'
import { MAX_CLUSTER_INFO_BYTES, MAX_CLUSTER_MEMBERS, MAX_POOL_INVITE_HOURS, MAX_POOL_INVITE_USES, MAX_POOL_KEY_BYTES } from './limits'
import { isAccountId, isClusterId, isSealed, isText } from './validate'

const CLUSTER_PATH =
  /^\/api\/clusters\/([A-Za-z0-9_-]{12})(\/leave|\/rotate|\/members(?:\/([A-Za-z0-9_-]{12})\/kick)?|\/invites(?:\/([A-Za-z0-9_-]{12}))?)?$/

/** The response to a cluster route, or null when the path is not one. */
export async function clusterRoute(ctx: RelayContext, req: Request, path: string, accountId: string, ip: string): Promise<Response | null> {
  if (path === '/api/clusters' && req.method === 'POST') return createCluster(ctx, req, accountId)
  if (path === '/api/clusters' && req.method === 'GET') return json(ctx.clusters.summaries(accountId))
  if (path === '/api/clusters/join' && req.method === 'POST') return joinCluster(ctx, req, accountId, ip)

  const match = CLUSTER_PATH.exec(path)
  if (!match) return null
  const [, clusterId, rest, kick, inviteId] = match
  const role = ctx.clusters.role(clusterId, accountId)
  // A cluster the account is not in does not exist for it.
  if (!role) return fail(404, 'No such cluster.')

  if (!rest && req.method === 'DELETE') {
    if (role !== 'owner') return fail(403, 'Only the owner can delete the cluster.')
    removeCluster(ctx, clusterId)
    return json({ ok: true })
  }
  if (rest === '/leave' && req.method === 'POST') {
    if (role === 'owner') return fail(403, 'The owner cannot leave: delete the cluster instead.')
    leaveCluster(ctx, clusterId, accountId)
    return json({ ok: true })
  }
  if (rest === '/members' && req.method === 'GET') return json(ctx.clusters.members(clusterId))
  if (role !== 'owner') return fail(403, 'Only the owner manages the cluster.')
  if (kick && req.method === 'POST') return rotate(ctx, req, clusterId, accountId, kick)
  if (rest === '/rotate' && req.method === 'POST') return rotate(ctx, req, clusterId, accountId, null)
  if (rest?.startsWith('/invites')) {
    if (!inviteId && req.method === 'POST') return createInvite(ctx, req, clusterId)
    if (!inviteId && req.method === 'GET') return json(ctx.clusters.invites(clusterId))
    if (inviteId && req.method === 'DELETE') {
      if (!ctx.clusters.revokeInvite(clusterId, inviteId)) return fail(404, 'No such invite.')
      return json({ ok: true })
    }
  }
  return fail(404, 'not found')
}

/**
 * What an enrolled machine may read of its account's clusters, for its agent to put its own sessions in: the summaries,
 * with the account's sealed copy of each key, and the members' sealed public keys. Nothing it could change.
 */
export function agentClusterRoute(ctx: RelayContext, req: Request, path: string, accountId: string): Response {
  if (req.method !== 'GET') return fail(405, 'Read only.')
  if (path === '/api/agent/clusters') return json(ctx.clusters.summaries(accountId))
  const members = /^\/api\/agent\/clusters\/([A-Za-z0-9_-]{12})\/members$/.exec(path)
  if (members && ctx.clusters.role(members[1], accountId)) return json(ctx.clusters.members(members[1]))
  return fail(404, 'No such cluster.')
}

/** The keys a member publishes on creating or joining a cluster, or null when they are missing or too big. */
function memberKeys(body: { publicKey?: unknown; secret?: unknown } | null): ClusterMemberKeys | null {
  return isSealed(body?.publicKey, MAX_POOL_KEY_BYTES) && isSealed(body.secret, MAX_POOL_KEY_BYTES)
    ? { publicKey: body.publicKey, secret: body.secret }
    : null
}

async function createCluster(ctx: RelayContext, req: Request, accountId: string): Promise<Response> {
  const body = await readJson<{ id?: unknown; info?: unknown; key?: unknown; profile?: unknown; publicKey?: unknown; secret?: unknown }>(
    req,
    4 * MAX_CLUSTER_INFO_BYTES,
  )
  const profile = body?.profile ?? null
  const keys = memberKeys(body)
  if (!isClusterId(body?.id) || !isSealed(body.info, MAX_CLUSTER_INFO_BYTES) || !isSealed(body.key, MAX_CLUSTER_INFO_BYTES) || !keys) {
    return fail(400, 'Bad request.')
  }
  if (profile !== null && !isSealed(profile, MAX_CLUSTER_INFO_BYTES)) return fail(400, 'Bad request.')
  const cluster = ctx.clusters.create(accountId, body.id, body.info, body.key, profile, keys)
  if (!cluster) return fail(409, 'This id is taken, or this account is in as many clusters as it may be.')
  return json({ cluster })
}

async function createInvite(ctx: RelayContext, req: Request, clusterId: string): Promise<Response> {
  const body = await readJson<{ uses?: unknown; hours?: unknown }>(req, 1024)
  const { uses, hours } = body ?? {}
  if (!isCount(uses, MAX_POOL_INVITE_USES) || !isCount(hours, MAX_POOL_INVITE_HOURS)) return fail(400, 'Bad request.')
  const invite = ctx.clusters.createInvite(clusterId, uses, Date.now() + hours * 3_600_000)
  if (!invite) return fail(403, 'This cluster has as many open invites as it may. Revoke one first.')
  return json(invite)
}

async function joinCluster(ctx: RelayContext, req: Request, accountId: string, ip: string): Promise<Response> {
  if (!ctx.claims.hit(ip)) return fail(429, 'Too many attempts to join.')
  const body = await readJson<{ invite?: unknown; key?: unknown; profile?: unknown; publicKey?: unknown; secret?: unknown }>(
    req,
    4 * MAX_CLUSTER_INFO_BYTES,
  )
  const profile = body?.profile ?? null
  const keys = memberKeys(body)
  if (!isText(body?.invite, 128) || !isSealed(body.key, MAX_CLUSTER_INFO_BYTES) || !keys) return fail(400, 'Bad request.')
  if (profile !== null && !isSealed(profile, MAX_CLUSTER_INFO_BYTES)) return fail(400, 'Bad request.')
  const joined = ctx.clusters.join(body.invite, accountId, body.key, profile, keys)
  if (!joined.ok && joined.reason === 'invalid') {
    ctx.failedAuth.hit(ip)
    return fail(401, 'This invite was revoked, used up or has expired.')
  }
  if (!joined.ok) return fail(403, 'This cluster is full, or this account is in as many clusters as it may be.')
  if (joined.fresh) {
    const member = ctx.clusters.member(joined.clusterId, accountId)
    if (member) broadcastCluster(ctx, joined.clusterId, { t: 'cluster_member', clusterId: joined.clusterId, member })
  }
  return json({ cluster: ctx.clusters.summary(joined.clusterId, accountId) })
}

/** The owner: a new version of the cluster key, wrapped for every member left; `kick` takes one member out first. */
async function rotate(ctx: RelayContext, req: Request, clusterId: string, actor: string, kick: string | null): Promise<Response> {
  if (kick !== null) {
    const target = ctx.clusters.role(clusterId, kick)
    if (!target) return fail(404, 'No such member.')
    if (target === 'owner') return fail(403, 'The owner cannot be kicked.')
  }
  const body = await readJson<{ version?: unknown; wraps?: unknown }>(req, (MAX_CLUSTER_MEMBERS + 1) * (MAX_POOL_KEY_BYTES + 128))
  const version = body?.version
  const wraps = Array.isArray(body?.wraps) ? body.wraps : null
  if (typeof version !== 'number' || !Number.isInteger(version) || !wraps || wraps.length > MAX_CLUSTER_MEMBERS)
    return fail(400, 'Bad request.')
  const parsed = wraps.map(wrap => wrap as { account?: unknown; blob?: unknown })
  if (!parsed.every(wrap => isAccountId(wrap?.account) && isSealed(wrap.blob, MAX_POOL_KEY_BYTES))) return fail(400, 'Bad request.')
  const result = ctx.clusters.rotate(
    clusterId,
    actor,
    version,
    parsed.map(wrap => ({ account: wrap.account as string, blob: wrap.blob as string })),
    kick,
  )
  if (!result.ok) {
    const why = {
      version: 'The cluster key changed meanwhile: fetch the cluster and try again.',
      wraps: 'Every member left with a public key, you included, needs exactly one wrap.',
      target: 'No such member to kick.',
      limit: 'This cluster key was rotated as many times as it may be.',
    }[result.reason]
    return fail(result.reason === 'version' ? 409 : 400, why)
  }
  clusterKeyRotated(ctx, clusterId, version, result.remaining, kick && result.kicked ? { account: kick, sessions: result.kicked } : null)
  return json({ ok: true, keyVersion: version })
}

const isCount = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max
