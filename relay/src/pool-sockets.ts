// Pool messages on the sockets (docs/pools.md): members' apps and the website subscribe to a pool and post to it; the
// agents of pool sessions take their join order and post too. The relay checks who may do what from the roles it holds
// in clear, attaches the sender from the socket, keeps the sealed blobs, and sends them on to every member.

import type { PoolAgentMessage, PoolAppMessage, PoolPost } from '../../shared/pool-protocol'
import type { RelayContext } from './context'
import type { Socket } from './hub'
import {
  MAX_POOL_INFO_BYTES,
  MAX_POOL_KEY_BYTES,
  MAX_POOL_NOTES_BYTES,
  MAX_POOL_POST_BYTES,
  MAX_POOL_POSTS_PER_MINUTE,
  MAX_POOL_TASK_BYTES,
  MAX_START_ORDER_BYTES,
} from './limits'
import type { Author } from './pools'
import { isPoolId, isPoolItemId, isRevision, isSealed, isSessionId } from './validate'

const POOL_APP_MESSAGES = new Set([
  'pool_subscribe',
  'pool_unsubscribe',
  'pool_task',
  'pool_notes',
  'pool_message',
  'pool_event',
  'pool_info',
  'pool_profile',
  'pool_member_key',
  'pool_join_session',
  'pool_leave_session',
])

/** True when the message was a pool's: handled or dropped here. */
export function handleAppPoolMessage(ctx: RelayContext, socket: Socket, message: PoolAppMessage): boolean {
  if (!POOL_APP_MESSAGES.has(message?.t)) return false
  const { accountId } = socket.data
  if (!isPoolId(message.poolId)) return true
  const { poolId } = message
  const role = ctx.pools.role(poolId, accountId)
  if (!role) return true

  switch (message.t) {
    case 'pool_subscribe': {
      ctx.hub.subscribePool(socket, poolId)
      const pool = ctx.pools.snapshot(poolId, (account, session) => ctx.poolLive(poolId, account, session), accountId)
      if (pool) ctx.hub.send(socket, { t: 'pool_snapshot', pool })
      break
    }
    case 'pool_unsubscribe':
      ctx.hub.unsubscribePool(socket, poolId)
      break
    case 'pool_info': {
      if ((role !== 'owner' && role !== 'admin') || !isSealed(message.info, MAX_POOL_INFO_BYTES)) return true
      ctx.pools.setInfo(poolId, message.info)
      const state = ctx.pools.state(poolId)
      if (state) ctx.broadcastPool(poolId, { t: 'pool_info', poolId, ...state })
      break
    }
    case 'pool_profile': {
      if (!isSealed(message.profile, MAX_POOL_INFO_BYTES)) return true
      ctx.pools.setProfile(poolId, accountId, message.profile)
      const member = ctx.pools.member(poolId, accountId)
      if (member) ctx.broadcastPool(poolId, { t: 'pool_member', poolId, member })
      break
    }
    case 'pool_member_key': {
      if (!isSealed(message.publicKey, MAX_POOL_KEY_BYTES) || !isSealed(message.secret, MAX_POOL_KEY_BYTES)) return true
      memberKeyChanged(ctx, poolId, accountId, message.publicKey, message.secret)
      break
    }
    case 'pool_join_session': {
      const { sessionId, order, profile } = message
      if (
        role === 'viewer' ||
        !isSessionId(sessionId) ||
        !isSealed(order, MAX_START_ORDER_BYTES) ||
        !isSealed(profile, MAX_POOL_INFO_BYTES)
      ) {
        return true
      }
      // Only a session of the account: the relay knows which are.
      if (!ctx.sessions.list(accountId).some(session => session.id === sessionId)) {
        ctx.hub.send(socket, { t: 'pool_error', poolId, message: 'No such session on this account.' })
        return true
      }
      const added = ctx.pools.addSession(poolId, accountId, sessionId, order, profile)
      if (!added) {
        ctx.hub.send(socket, { t: 'pool_error', poolId, message: 'This pool has as many sessions as it may.' })
        return true
      }
      ctx.hub.setPoolSessionReady(poolId, accountId, sessionId, false)
      const agent = ctx.hub.agentOf(accountId, sessionId)
      if (agent) ctx.hub.send(agent, { t: 'pool_join', sessionId, poolId, order })
      ctx.poolSessionChanged(poolId, accountId, sessionId)
      break
    }
    case 'pool_leave_session': {
      if (!isSessionId(message.sessionId) || !ctx.pools.removeSession(poolId, accountId, message.sessionId)) return true
      ctx.sessionLeftPool({ poolId, accountId, sessionId: message.sessionId }, true)
      break
    }
    default:
      if (role !== 'viewer') post(ctx, socket, poolId, { accountId, sessionId: null }, message)
  }
  return true
}

const POOL_AGENT_MESSAGES = new Set(['pool_ack', 'pool_member_key', 'pool_task', 'pool_notes', 'pool_message', 'pool_event'])

/** True when the message was a pool's. `sessionId` is the session the agent socket speaks for. */
export function handleAgentPoolMessage(ctx: RelayContext, socket: Socket, message: PoolAgentMessage, sessionId: string): boolean {
  if (!POOL_AGENT_MESSAGES.has(message?.t)) return false
  const { accountId } = socket.data
  if (!isPoolId(message.poolId) || !ctx.pools.isPoolSession(message.poolId, accountId, sessionId)) return true
  const { poolId } = message
  if (message.t === 'pool_ack') {
    ctx.hub.setPoolSessionReady(poolId, accountId, sessionId, true)
    const pool = ctx.pools.snapshot(poolId, (account, session) => ctx.poolLive(poolId, account, session), accountId)
    if (pool) ctx.hub.send(socket, { t: 'pool_snapshot', pool })
    ctx.poolSessionChanged(poolId, accountId, sessionId)
    return true
  }
  if (message.t === 'pool_member_key') {
    // Only the public key: the private one is published by the member's apps, which made it.
    if (isSealed(message.publicKey, MAX_POOL_KEY_BYTES)) memberKeyChanged(ctx, poolId, accountId, message.publicKey, null)
    return true
  }
  const role = ctx.pools.role(poolId, accountId)
  if (role && role !== 'viewer') post(ctx, socket, poolId, { accountId, sessionId }, message)
  return true
}

/** A session's agent connected: it gets its pools' orders again, as shares get theirs. */
export function poolSessionConnected(ctx: RelayContext, socket: Socket, sessionId: string) {
  const { accountId } = socket.data
  for (const { poolId, order } of ctx.pools.ordersFor(accountId, sessionId)) {
    ctx.hub.setPoolSessionReady(poolId, accountId, sessionId, false)
    ctx.hub.send(socket, { t: 'pool_join', sessionId, poolId, order })
    ctx.poolSessionChanged(poolId, accountId, sessionId)
  }
}

/** A session's agent went away: the members see its pool sessions go offline. */
export function poolSessionDisconnected(ctx: RelayContext, accountId: string, sessionId: string) {
  for (const { poolId } of ctx.pools.ordersFor(accountId, sessionId)) {
    ctx.hub.setPoolSessionReady(poolId, accountId, sessionId, false)
    ctx.poolSessionChanged(poolId, accountId, sessionId)
  }
}

/** A member published its keys: the others see its new public key. */
function memberKeyChanged(ctx: RelayContext, poolId: string, accountId: string, publicKey: string, secret: string | null) {
  ctx.pools.setMemberKeys(poolId, accountId, publicKey, secret)
  const member = ctx.pools.member(poolId, accountId)
  if (member) ctx.broadcastPool(poolId, { t: 'pool_member', poolId, member })
}

/** A task, the notes, a message or an event: kept, then sent to every member. */
function post(ctx: RelayContext, socket: Socket, poolId: string, author: Author, message: PoolPost) {
  if (!ctx.allowPoolPost(poolId, author.accountId, MAX_POOL_POSTS_PER_MINUTE)) {
    ctx.hub.send(socket, { t: 'pool_error', poolId, message: 'Too many changes to this pool in a minute.' })
    return
  }
  switch (message.t) {
    case 'pool_task': {
      if (!isPoolItemId(message.id) || !isRevision(message.rev) || !isSealed(message.blob, MAX_POOL_TASK_BYTES)) return
      const put = ctx.pools.putTask(poolId, message.id, message.rev, message.blob, author)
      if (put.ok) ctx.broadcastPool(poolId, { t: 'pool_task', poolId, task: put.value })
      else if (put.reason === 'conflict')
        ctx.hub.send(socket, { t: 'pool_conflict', poolId, kind: 'task', id: message.id, current: put.current })
      else ctx.hub.send(socket, { t: 'pool_error', poolId, message: 'This pool has as many tasks as it may.' })
      break
    }
    case 'pool_notes': {
      if (!isRevision(message.rev) || !isSealed(message.blob, MAX_POOL_NOTES_BYTES)) return
      const put = ctx.pools.putNotes(poolId, message.rev, message.blob, author)
      if (put.ok) ctx.broadcastPool(poolId, { t: 'pool_notes', poolId, notes: put.value })
      else if (put.reason === 'conflict') ctx.hub.send(socket, { t: 'pool_conflict', poolId, kind: 'notes', current: put.current })
      break
    }
    case 'pool_message':
    case 'pool_event': {
      if (!isPoolItemId(message.id) || !isSealed(message.blob, MAX_POOL_POST_BYTES)) return
      const kind = message.t === 'pool_message' ? 'message' : 'event'
      const posted = ctx.pools.addPost(kind, poolId, message.id, message.blob, author)
      if (!posted) return
      if (kind === 'message') ctx.broadcastPool(poolId, { t: 'pool_message', poolId, message: posted })
      else ctx.broadcastPool(poolId, { t: 'pool_event', poolId, event: posted })
      break
    }
  }
}
