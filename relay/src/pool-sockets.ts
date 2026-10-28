// Pool messages on the sockets (docs/pools.md): members' apps and the website subscribe to a pool and post to it; the
// agents of pool sessions take their join order and post too, and so do the services of pool machines
// (docs/pool-autopilot.md). The relay checks who may do what from the roles it holds in clear, attaches the sender from
// the socket, keeps the sealed blobs, and sends them on to every member.

import type { PoolAgentMessage, PoolAppMessage, PoolMachineMessage, PoolPost } from '../../shared/pool-protocol'
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
import { handleMachineAppMessage, isMachineAppMessage, setDispatch } from './pool-machines'
import { handleSafetyMessage, isSafetyMessage } from './pool-safety'
import type { Author } from './pools'
import { isAccountId, isPoolId, isPoolItemId, isRevision, isSealed, isSessionId } from './validate'

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
  'pool_pause',
  'pool_stop',
  'pool_rules',
  'pool_budgets',
  'pool_accept_rules',
  'pool_orchestrator',
  'pool_add_machine',
  'pool_remove_machine',
  'pool_orchestrator_machine',
  'pool_dispatch',
])

/** True when the message was a pool's: handled or dropped here. */
export function handleAppPoolMessage(ctx: RelayContext, socket: Socket, message: PoolAppMessage): boolean {
  if (!POOL_APP_MESSAGES.has(message?.t)) return false
  const { accountId } = socket.data
  if (!isPoolId(message.poolId)) return true
  const { poolId } = message
  const role = ctx.pools.role(poolId, accountId)
  if (!role) return true
  if (isSafetyMessage(message.t)) {
    handleSafetyMessage(ctx, socket, poolId, role, message as Parameters<typeof handleSafetyMessage>[4])
    return true
  }
  if (isMachineAppMessage(message.t)) {
    handleMachineAppMessage(ctx, socket, poolId, role, message as Parameters<typeof handleMachineAppMessage>[4])
    return true
  }

  switch (message.t) {
    case 'pool_subscribe': {
      ctx.hub.subscribePool(socket, poolId)
      const pool = ctx.poolSnapshot(poolId, accountId)
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
      if (agent) ctx.hub.send(agent, ctx.poolJoin(poolId, accountId, sessionId, order))
      ctx.auditPool(poolId, { accountId, sessionId: null }, 'session_joined', { account: accountId, session: sessionId })
      ctx.poolSessionChanged(poolId, accountId, sessionId)
      break
    }
    case 'pool_leave_session': {
      if (!isSessionId(message.sessionId) || !ctx.pools.removeSession(poolId, accountId, message.sessionId)) return true
      ctx.sessionLeftPool({ poolId, accountId, sessionId: message.sessionId }, true)
      ctx.auditPool(poolId, { accountId, sessionId: null }, 'session_left', { account: accountId, session: message.sessionId })
      break
    }
    case 'pool_orchestrator': {
      // Owners and admins only: no member makes its own session the one that hands out the work.
      if (role !== 'owner' && role !== 'admin') return true
      const lead = message.orchestrator
      const valid = lead === null || (isAccountId(lead?.account) && isSessionId(lead?.session))
      if (!valid || !ctx.pools.setOrchestrator(poolId, lead && { account: lead.account, session: lead.session })) {
        ctx.hub.send(socket, { t: 'pool_error', poolId, message: 'Only a session of this pool can be its orchestrator.' })
        return true
      }
      // One orchestrator: a session chosen by hand replaces the orchestrator machine, unless that machine started it.
      const machine = ctx.poolMachines.orchestrator(poolId)
      if (machine && (!lead || ctx.pools.sessionMachine(poolId, lead.account, lead.session) !== machine.machine)) {
        ctx.poolMachines.setOrchestrator(poolId, null)
      }
      ctx.poolOrchestratorChanged(poolId)
      break
    }
    default:
      // Safety messages were handled above: what is left is a post.
      if (role !== 'viewer') post(ctx, socket, poolId, { accountId, sessionId: null }, message as PoolPost)
  }
  return true
}

const POOL_AGENT_MESSAGES = new Set([
  'pool_ack',
  'pool_member_key',
  'pool_task',
  'pool_notes',
  'pool_message',
  'pool_event',
  'pool_dispatch',
])

/** True when the message was a pool's. `sessionId` is the session the agent socket speaks for. */
export function handleAgentPoolMessage(ctx: RelayContext, socket: Socket, message: PoolAgentMessage, sessionId: string): boolean {
  if (!POOL_AGENT_MESSAGES.has(message?.t)) return false
  const { accountId } = socket.data
  if (!isPoolId(message.poolId) || !ctx.pools.isPoolSession(message.poolId, accountId, sessionId)) return true
  const { poolId } = message
  if (message.t === 'pool_ack') {
    ctx.hub.setPoolSessionReady(poolId, accountId, sessionId, true)
    const pool = ctx.poolSnapshot(poolId, accountId)
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
  if (!role || role === 'viewer') return true
  if (message.t === 'pool_dispatch') {
    // Only the orchestrator session starts and stops the control loop, as the relay attests who it is.
    const lead = ctx.pools.orchestrator(poolId)
    if (lead?.account !== accountId || lead.session !== sessionId) {
      ctx.hub.send(socket, { t: 'pool_error', poolId, message: 'Only the orchestrator starts or stops the dispatch.' })
      return true
    }
    setDispatch(ctx, socket, poolId, { accountId, sessionId }, message.rev, message.blob)
    return true
  }
  // A paused pool takes nothing from its sessions but events: the agents still say what they spend.
  if (message.t !== 'pool_event' && ctx.poolSafety.isPaused(poolId)) {
    ctx.hub.send(socket, { t: 'pool_error', poolId, message: 'The pool is paused.' })
    return true
  }
  post(ctx, socket, poolId, { accountId, sessionId }, message)
  return true
}

const POOL_MACHINE_MESSAGES = new Set([
  'pool_machine_ack',
  'pool_member_key',
  'pool_machine_session',
  'pool_machine_session_left',
  'pool_dispatch',
  'pool_task',
  'pool_message',
  'pool_event',
])

/**
 * True when the message was a pool machine's: handled or dropped here. Only the machine's own background service speaks
 * for it, in the pools it is in; the relay attaches the machine to what it keeps.
 */
export function handleMachinePoolMessage(ctx: RelayContext, socket: Socket, message: PoolMachineMessage): boolean {
  // A session's agent never names a machine: one that does speaks for the machine, and must be its service.
  const fields = message as { t?: unknown; machineId?: unknown }
  if (!POOL_MACHINE_MESSAGES.has(fields?.t as string) || fields.machineId === undefined) return false
  const { accountId, machineId, service } = socket.data
  if (!service || !machineId || fields.machineId !== machineId || !isPoolId(message.poolId)) return true
  const { poolId } = message
  if (ctx.poolMachines.get(poolId, machineId)?.accountId !== accountId) return true
  const author: Author = { accountId, sessionId: null, machineId }
  const refuse = (text: string) => ctx.hub.send(socket, { t: 'pool_error', poolId, message: text })

  switch (message.t) {
    case 'pool_machine_ack': {
      ctx.hub.setPoolMachineReady(poolId, machineId, true)
      const pool = ctx.poolSnapshot(poolId, accountId)
      if (pool) ctx.hub.send(socket, { t: 'pool_snapshot', pool })
      ctx.poolMachineChanged(poolId, machineId)
      return true
    }
    case 'pool_member_key':
      // Only the public key, like a session's agent: the private one is published by the member's apps.
      if (isSealed(message.publicKey, MAX_POOL_KEY_BYTES)) memberKeyChanged(ctx, poolId, accountId, message.publicKey, null)
      return true
    case 'pool_machine_session':
      joinMachineSession(ctx, socket, poolId, author, message)
      return true
    case 'pool_machine_session_left': {
      const { sessionId } = message
      // Only a session this machine started: those put in by hand are their owner's to take out.
      if (!isSessionId(sessionId) || ctx.pools.sessionMachine(poolId, accountId, sessionId) !== machineId) return true
      if (ctx.pools.removeSession(poolId, accountId, sessionId)) {
        ctx.sessionLeftPool({ poolId, accountId, sessionId }, true)
        ctx.auditPool(poolId, author, 'session_left', { account: accountId, session: sessionId })
      }
      return true
    }
    case 'pool_dispatch':
      // The control loop runs on the orchestrator machine; it stops itself when every task is done.
      if (ctx.poolMachines.orchestrator(poolId)?.machine !== machineId) {
        refuse('Only the orchestrator machine starts or stops the dispatch.')
        return true
      }
      setDispatch(ctx, socket, poolId, author, message.rev, message.blob)
      return true
  }
  const role = ctx.pools.role(poolId, accountId)
  if (!role || role === 'viewer') return true
  if (message.t !== 'pool_event' && ctx.poolSafety.isPaused(poolId)) {
    refuse('The pool is paused.')
    return true
  }
  post(ctx, socket, poolId, author, message)
  return true
}

/**
 * A session the machine's service started, put in the pool: it must be the account's and run on that machine, as the
 * relay sees it. Its agent gets the order like any session's. The orchestrator machine's session becomes the orchestrator.
 */
function joinMachineSession(
  ctx: RelayContext,
  socket: Socket,
  poolId: string,
  author: Author,
  message: Extract<PoolMachineMessage, { t: 'pool_machine_session' }>,
) {
  const { accountId } = author
  const machineId = author.machineId as string
  const { sessionId, order, profile } = message
  if (!isSessionId(sessionId) || !isSealed(order, MAX_START_ORDER_BYTES) || !isSealed(profile, MAX_POOL_INFO_BYTES)) return
  const role = ctx.pools.role(poolId, accountId)
  if (!role || role === 'viewer') return
  if (ctx.sessions.list(accountId).find(session => session.id === sessionId)?.machineId !== machineId) {
    ctx.hub.send(socket, { t: 'pool_error', poolId, message: 'No such session on this machine.' })
    return
  }
  if (!ctx.pools.addSession(poolId, accountId, sessionId, order, profile, machineId)) {
    ctx.hub.send(socket, { t: 'pool_error', poolId, message: 'This pool has as many sessions as it may.' })
    return
  }
  ctx.hub.setPoolSessionReady(poolId, accountId, sessionId, false)
  const agent = ctx.hub.agentOf(accountId, sessionId)
  if (agent) ctx.hub.send(agent, ctx.poolJoin(poolId, accountId, sessionId, order))
  ctx.auditPool(poolId, author, 'session_joined', { account: accountId, session: sessionId })
  ctx.poolSessionChanged(poolId, accountId, sessionId)
  if (message.orchestrator === true && ctx.poolMachines.orchestrator(poolId)?.machine === machineId) {
    ctx.pools.setOrchestrator(poolId, { account: accountId, session: sessionId })
    ctx.poolOrchestratorChanged(poolId)
  }
}

/** A session's agent connected: it gets its pools' orders again, as shares get theirs. */
export function poolSessionConnected(ctx: RelayContext, socket: Socket, sessionId: string) {
  const { accountId } = socket.data
  for (const { poolId, order } of ctx.pools.ordersFor(accountId, sessionId)) {
    ctx.hub.setPoolSessionReady(poolId, accountId, sessionId, false)
    ctx.hub.send(socket, ctx.poolJoin(poolId, accountId, sessionId, order))
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
