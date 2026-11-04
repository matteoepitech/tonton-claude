// Cluster messages on the sockets (docs/cluster.md): members' apps and the website subscribe to a cluster, put their own
// sessions in and edit the shared documents; the agents of cluster sessions take their join order, post and keep their
// status line up to date. The relay checks membership from what it holds in clear, attaches the sender from the socket,
// keeps the sealed blobs and sends them on to every member.
// Nothing here reaches another account's session but sealed posts and documents: no prompt, start, stop or permission
// answer crosses accounts (relay/src/sockets.ts keeps those within one account).

import type { ClusterAgentMessage, ClusterAppMessage, ClusterUpdate } from '../../shared/cluster-protocol'
import type { SessionSummary } from '../../shared/protocol'
import type { ClusterAuthor, ClusterSessionRow } from './clusters'
import type { RelayContext } from './context'
import type { Socket } from './hub'
import {
  MAX_CLUSTER_DOC_BYTES,
  MAX_CLUSTER_INFO_BYTES,
  MAX_CLUSTER_POST_BYTES,
  MAX_CLUSTER_POSTS_PER_MINUTE,
  MAX_POOL_KEY_BYTES,
  MAX_START_ORDER_BYTES,
} from './limits'
import { isClusterDocName, isClusterId, isClusterItemId, isRevision, isSealed, isSessionId } from './validate'

const APP_MESSAGES = new Set([
  'cluster_subscribe',
  'cluster_unsubscribe',
  'cluster_info',
  'cluster_profile',
  'cluster_member_key',
  'cluster_join_session',
  'cluster_leave_session',
  'cluster_doc',
])

const AGENT_MESSAGES = new Set([
  'cluster_post',
  'cluster_doc',
  'cluster_session_profile',
  'cluster_ack',
  'cluster_member_key',
  'cluster_join_session',
  'cluster_leave_session',
])

/** True when the message was a cluster's: handled or dropped here. */
export function handleAppClusterMessage(ctx: RelayContext, socket: Socket, message: ClusterAppMessage): boolean {
  if (!APP_MESSAGES.has(message?.t)) return false
  const { accountId } = socket.data
  if (!isClusterId(message.clusterId)) return true
  const { clusterId } = message
  const role = ctx.clusters.role(clusterId, accountId)
  if (!role) return true

  switch (message.t) {
    case 'cluster_subscribe': {
      ctx.hub.subscribeCluster(socket, clusterId)
      const cluster = clusterSnapshot(ctx, clusterId, accountId)
      if (cluster) ctx.hub.send(socket, { t: 'cluster_snapshot', cluster })
      break
    }
    case 'cluster_unsubscribe':
      ctx.hub.unsubscribeCluster(socket, clusterId)
      break
    case 'cluster_info': {
      if (role !== 'owner' || !isSealed(message.info, MAX_CLUSTER_INFO_BYTES)) return true
      ctx.clusters.setInfo(clusterId, message.info)
      const state = ctx.clusters.state(clusterId)
      if (state) broadcastCluster(ctx, clusterId, { t: 'cluster_info', clusterId, ...state })
      break
    }
    case 'cluster_profile': {
      if (!isSealed(message.profile, MAX_CLUSTER_INFO_BYTES)) return true
      ctx.clusters.setProfile(clusterId, accountId, message.profile)
      memberChanged(ctx, clusterId, accountId)
      break
    }
    case 'cluster_member_key': {
      if (!isSealed(message.publicKey, MAX_POOL_KEY_BYTES) || !isSealed(message.secret, MAX_POOL_KEY_BYTES)) return true
      ctx.clusters.setMemberKeys(clusterId, accountId, message.publicKey, message.secret)
      memberChanged(ctx, clusterId, accountId)
      break
    }
    case 'cluster_join_session':
      joinSession(ctx, socket, clusterId, message.sessionId, message.order, message.profile)
      break
    case 'cluster_leave_session':
      if (isSessionId(message.sessionId)) leaveSession(ctx, clusterId, accountId, message.sessionId)
      break
    case 'cluster_doc':
      putDoc(ctx, socket, clusterId, { accountId, sessionId: null }, message.name, message.rev, message.blob)
      break
  }
  return true
}

/** True when the message was a cluster's. `sessionId` is the session the agent socket speaks for, and only that one. */
export function handleAgentClusterMessage(ctx: RelayContext, socket: Socket, message: ClusterAgentMessage, sessionId: string): boolean {
  if (!AGENT_MESSAGES.has(message?.t)) return false
  const { accountId, machineId } = socket.data
  if (!isClusterId(message.clusterId) || !ctx.clusters.role(message.clusterId, accountId)) return true
  const { clusterId } = message
  // The agent puts its own session in for its owner, with an order it sealed with the account key.
  if (message.t === 'cluster_join_session') {
    joinSession(ctx, socket, clusterId, sessionId, message.order, message.profile)
    return true
  }
  if (!ctx.clusters.isClusterSession(clusterId, accountId, sessionId)) return true
  const author: ClusterAuthor = { accountId, sessionId, machineId }
  switch (message.t) {
    case 'cluster_leave_session':
      leaveSession(ctx, clusterId, accountId, sessionId)
      break
    case 'cluster_ack': {
      ctx.hub.setClusterSessionReady(clusterId, accountId, sessionId, true)
      const cluster = clusterSnapshot(ctx, clusterId, accountId)
      if (cluster) ctx.hub.send(socket, { t: 'cluster_snapshot', cluster })
      clusterSessionChanged(ctx, clusterId, accountId, sessionId)
      break
    }
    case 'cluster_member_key':
      // Only the public key: the private one is published by the member's apps, which made it.
      if (isSealed(message.publicKey, MAX_POOL_KEY_BYTES)) {
        ctx.clusters.setMemberKeys(clusterId, accountId, message.publicKey, null)
        memberChanged(ctx, clusterId, accountId)
      }
      break
    case 'cluster_session_profile':
      if (!isSealed(message.profile, MAX_CLUSTER_INFO_BYTES)) return true
      if (!allowClusterPost(ctx, clusterId, accountId)) return true
      if (ctx.clusters.setSessionProfile(clusterId, accountId, sessionId, message.profile))
        clusterSessionChanged(ctx, clusterId, accountId, sessionId)
      break
    case 'cluster_doc':
      putDoc(ctx, socket, clusterId, author, message.name, message.rev, message.blob)
      break
    case 'cluster_post': {
      if (!isClusterItemId(message.id) || !isSealed(message.blob, MAX_CLUSTER_POST_BYTES)) {
        ctx.hub.send(socket, { t: 'cluster_error', clusterId, message: 'This post has a bad id or is too big.' })
        return true
      }
      if (!allowClusterPost(ctx, clusterId, accountId)) {
        ctx.hub.send(socket, { t: 'cluster_error', clusterId, message: 'Too many posts to this cluster in a minute.' })
        return true
      }
      const post = ctx.clusters.addPost(clusterId, message.id, message.blob, author)
      if (post) broadcastCluster(ctx, clusterId, { t: 'cluster_post', clusterId, post })
      else ctx.hub.send(socket, { t: 'cluster_error', clusterId, message: 'A post with this id is already in the cluster.' })
      break
    }
  }
  return true
}

/** Puts a session of the socket's account in, or changes its order: only a session the relay knows is that account's. */
function joinSession(ctx: RelayContext, socket: Socket, clusterId: string, sessionId: unknown, order: unknown, profile: unknown) {
  const { accountId } = socket.data
  if (!isSessionId(sessionId) || !isSealed(order, MAX_START_ORDER_BYTES) || !isSealed(profile, MAX_CLUSTER_INFO_BYTES)) return
  if (!ctx.sessions.list(accountId).some(session => session.id === sessionId)) {
    ctx.hub.send(socket, { t: 'cluster_error', clusterId, message: 'No such session on this account.' })
    return
  }
  const added = ctx.clusters.addSession(clusterId, accountId, sessionId, order, profile)
  if (!added) {
    ctx.hub.send(socket, { t: 'cluster_error', clusterId, message: 'This cluster has as many sessions as it may.' })
    return
  }
  ctx.hub.setClusterSessionReady(clusterId, accountId, sessionId, false)
  const agent = ctx.hub.agentOf(accountId, sessionId)
  if (agent) ctx.hub.send(agent, { t: 'cluster_join', sessionId, clusterId, order })
  clusterSessionChanged(ctx, clusterId, accountId, sessionId)
}

function leaveSession(ctx: RelayContext, clusterId: string, accountId: string, sessionId: string) {
  if (ctx.clusters.removeSession(clusterId, accountId, sessionId)) sessionLeftCluster(ctx, { clusterId, accountId, sessionId }, true)
}

function putDoc(ctx: RelayContext, socket: Socket, clusterId: string, author: ClusterAuthor, name: unknown, rev: unknown, blob: unknown) {
  if (!isClusterDocName(name) || !isRevision(rev) || !isSealed(blob, MAX_CLUSTER_DOC_BYTES)) return
  if (!allowClusterPost(ctx, clusterId, author.accountId)) {
    ctx.hub.send(socket, { t: 'cluster_error', clusterId, message: 'Too many changes to this cluster in a minute.' })
    return
  }
  const put = ctx.clusters.putDoc(clusterId, name, rev, blob, author)
  if (put.ok) broadcastCluster(ctx, clusterId, { t: 'cluster_doc', clusterId, doc: put.value })
  else if (put.reason === 'conflict') ctx.hub.send(socket, { t: 'cluster_conflict', clusterId, name, current: put.current })
  else ctx.hub.send(socket, { t: 'cluster_error', clusterId, message: 'This cluster has as many documents as it may.' })
}

function memberChanged(ctx: RelayContext, clusterId: string, accountId: string) {
  const member = ctx.clusters.member(clusterId, accountId)
  if (member) broadcastCluster(ctx, clusterId, { t: 'cluster_member', clusterId, member })
}

// MARK: The cluster's lifecycle

/** The cluster's sessions, as `Hub.sendToCluster` reaches their agents. */
function clusterSessions(ctx: RelayContext, clusterId: string): { accountId: string; sessionId: string }[] {
  return ctx.clusters.sessionRows(clusterId).map(({ accountId, sessionId }) => ({ accountId, sessionId }))
}

/** To every app that follows the cluster and to the agents of its sessions. */
export function broadcastCluster(ctx: RelayContext, clusterId: string, message: ClusterUpdate) {
  ctx.hub.sendToCluster(clusterId, message, clusterSessions(ctx, clusterId))
}

export function clusterSnapshot(ctx: RelayContext, clusterId: string, forAccount: string) {
  return ctx.clusters.snapshot(clusterId, (accountId, sessionId) => clusterLive(ctx, clusterId, accountId, sessionId), forAccount)
}

/** Whether a cluster session's agent is connected and ready, from which machine, and its status, which the relay sees anyway. */
function clusterLive(ctx: RelayContext, clusterId: string, accountId: string, sessionId: string) {
  const status = ctx.sessions.list(accountId).find(session => session.id === sessionId)?.status
  return { ...ctx.hub.clusterSessionState(clusterId, accountId, sessionId), ...(status ? { status } : {}) }
}

/** A cluster session's agent connected, left, took its order or changed its profile: the members see it. */
export function clusterSessionChanged(ctx: RelayContext, clusterId: string, accountId: string, sessionId: string) {
  const session = ctx.clusters.sessions(clusterId).find(s => s.account === accountId && s.session === sessionId)
  if (session) {
    broadcastCluster(ctx, clusterId, {
      t: 'cluster_session',
      clusterId,
      session: { ...session, ...clusterLive(ctx, clusterId, accountId, sessionId) },
    })
  }
}

/** Tells the session's agent it is out of the cluster, and the members when `announce`. */
export function sessionLeftCluster(ctx: RelayContext, session: Omit<ClusterSessionRow, 'order'>, announce: boolean) {
  const { clusterId, accountId, sessionId } = session
  ctx.hub.setClusterSessionReady(clusterId, accountId, sessionId, false)
  const agent = ctx.hub.agentOf(accountId, sessionId)
  if (agent) ctx.hub.send(agent, { t: 'cluster_left', sessionId, clusterId })
  if (announce) broadcastCluster(ctx, clusterId, { t: 'cluster_session_left', clusterId, account: accountId, session: sessionId })
}

/** A session's agent connected: it gets its clusters' orders again. */
export function clusterSessionConnected(ctx: RelayContext, socket: Socket, sessionId: string) {
  const { accountId } = socket.data
  for (const { clusterId, order } of ctx.clusters.ordersFor(accountId, sessionId)) {
    ctx.hub.setClusterSessionReady(clusterId, accountId, sessionId, false)
    ctx.hub.send(socket, { t: 'cluster_join', sessionId, clusterId, order })
    clusterSessionChanged(ctx, clusterId, accountId, sessionId)
  }
}

/** A session's agent went away: the members see its cluster sessions go offline. */
export function clusterSessionDisconnected(ctx: RelayContext, accountId: string, sessionId: string) {
  for (const { clusterId } of ctx.clusters.ordersFor(accountId, sessionId)) {
    ctx.hub.setClusterSessionReady(clusterId, accountId, sessionId, false)
    clusterSessionChanged(ctx, clusterId, accountId, sessionId)
  }
}

/** A session's status changed: the clusters it is in see it, once per change rather than with every entry. */
export function clusterStatusChanged(ctx: RelayContext, accountId: string, session: SessionSummary) {
  const key = `${accountId}/${session.id}`
  if (ctx.clusterStatuses.get(key) === session.status) return
  const orders = ctx.clusters.ordersFor(accountId, session.id)
  if (!orders.length) return
  ctx.clusterStatuses.set(key, session.status)
  for (const order of orders) clusterSessionChanged(ctx, order.clusterId, accountId, session.id)
}

/** The owner deleted the cluster: its members and its sessions' agents are told, then forget it. */
export function removeCluster(ctx: RelayContext, clusterId: string) {
  const members = ctx.clusters.memberAccounts(clusterId)
  const sessions = ctx.clusters.remove(clusterId)
  ctx.hub.sendToCluster(clusterId, { t: 'cluster_removed', clusterId }, [])
  for (const accountId of members) ctx.hub.dropClusterAccount(clusterId, accountId)
  for (const session of sessions) sessionLeftCluster(ctx, session, false)
}

/** A member left: the others see it go with its sessions, its own apps and agents drop the cluster. */
export function leaveCluster(ctx: RelayContext, clusterId: string, accountId: string) {
  const sessions = ctx.clusters.leave(clusterId, accountId)
  if (!sessions) return
  memberGone(ctx, clusterId, accountId, sessions)
}

function memberGone(ctx: RelayContext, clusterId: string, accountId: string, sessions: readonly ClusterSessionRow[]) {
  ctx.hub.sendToApps(accountId, { t: 'cluster_removed', clusterId }, socket => socket.data.clusters?.has(clusterId) === true)
  ctx.hub.dropClusterAccount(clusterId, accountId)
  for (const session of sessions) sessionLeftCluster(ctx, session, true)
  broadcastCluster(ctx, clusterId, { t: 'cluster_member_left', clusterId, account: accountId })
}

/**
 * The cluster key went to version `version`: everyone sees the new version, and each member left gets its own wrap. A
 * kicked member is taken out first, like one that left, and never gets the new version.
 */
export function clusterKeyRotated(
  ctx: RelayContext,
  clusterId: string,
  version: number,
  remaining: readonly string[],
  kicked: { account: string; sessions: ClusterSessionRow[] } | null,
) {
  if (kicked) memberGone(ctx, clusterId, kicked.account, kicked.sessions)
  const sessions = clusterSessions(ctx, clusterId)
  for (const account of remaining) {
    const wrap = ctx.clusters.wrap(clusterId, account, version)
    const own = sessions.filter(session => session.accountId === account).map(session => session.sessionId)
    if (wrap) ctx.hub.sendToClusterMember(clusterId, account, { t: 'cluster_key', clusterId, wrap }, own)
  }
  const state = ctx.clusters.state(clusterId)
  if (state) broadcastCluster(ctx, clusterId, { t: 'cluster_info', clusterId, ...state })
}

/** Before an account is deleted: the clusters it owns go, it leaves the others. */
export function removeAccountClusters(ctx: RelayContext, accountId: string) {
  const { owned, joined } = ctx.clusters.clustersOf(accountId)
  for (const clusterId of owned) removeCluster(ctx, clusterId)
  for (const clusterId of joined) leaveCluster(ctx, clusterId, accountId)
}

/** False once the member wrote to the cluster as often as it may this minute. */
export function allowClusterPost(ctx: RelayContext, clusterId: string, accountId: string): boolean {
  const minute = Math.floor(Date.now() / 60_000)
  const key = `${clusterId}/${accountId}`
  const current = ctx.clusterPosts.get(key)
  const count = current?.minute === minute ? current.count + 1 : 1
  ctx.clusterPosts.set(key, { minute, count })
  return count <= MAX_CLUSTER_POSTS_PER_MINUTE
}
