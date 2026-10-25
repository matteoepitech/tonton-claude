import type { WebSocketHandler } from 'bun'
import type { AgentMessage, AppMessage, RelayToApp } from '../../shared/protocol'
import type { RelayContext } from './context'
import type { Socket, SocketData } from './hub'
import { MAX_WS_MESSAGE_BYTES } from './limits'
import { isRequestId, isSealed, isSessionId, isText } from './validate'

export function createWebSocketHandler(ctx: RelayContext): WebSocketHandler<SocketData> {
  return {
    maxPayloadLength: MAX_WS_MESSAGE_BYTES,
    idleTimeout: 120,
    sendPings: true,

    open(socket) {
      if (socket.data.role === 'app') {
        ctx.hub.addApp(socket)
        const { accountId } = socket.data
        send(socket, { t: 'snapshot', sessions: ctx.sessions.list(accountId), machines: ctx.machineList(accountId) })
      } else {
        ctx.hub.addMachineSocket(socket)
        onMachinePresence(ctx, socket)
      }
    },

    message(socket, raw) {
      const message = parse(raw)
      if (!message) return
      if (socket.data.role === 'agent') handleAgentMessage(ctx, socket, message as AgentMessage)
      else handleAppMessage(ctx, socket, message as AppMessage)
    },

    close(socket) {
      if (socket.data.role === 'app') {
        ctx.hub.removeApp(socket)
        return
      }
      const { accountId, sessionId } = socket.data
      if (sessionId && ctx.hub.unbindAgent(socket, sessionId)) ctx.sessions.agentDisconnected(accountId, sessionId)
      ctx.hub.removeMachineSocket(socket)
      onMachinePresence(ctx, socket)
    },
  }
}

function handleAgentMessage(ctx: RelayContext, socket: Socket, message: AgentMessage) {
  const { accountId, machineId } = socket.data
  if (!machineId || !isSessionId(message?.sessionId)) return
  const sessionId = message.sessionId
  // Once announced, a socket only speaks for its own session.
  if (message.t !== 'hello' && socket.data.sessionId !== sessionId) return

  switch (message.t) {
    case 'hello': {
      if (!isSealed(message.info)) return
      const previous = socket.data.sessionId
      if (previous && previous !== sessionId && ctx.hub.unbindAgent(socket, previous)) ctx.sessions.agentDisconnected(accountId, previous)
      if (!ctx.sessions.agentConnected(accountId, machineId, sessionId, message.info, message.channel === true)) return
      socket.data.sessionId = sessionId
      ctx.hub.bindAgent(socket, sessionId)
      break
    }
    case 'entries': {
      if (!Array.isArray(message.entries)) return
      const entries = message.entries.filter(e => isText(e?.id, 200) && isText(e?.ts, 64) && isSealed(e?.blob))
      const reset = message.reset === true
      const fresh = ctx.sessions.addEntries(accountId, sessionId, entries, reset)
      const watching = (app: Socket) => app.data.sessionId === sessionId
      if (reset) ctx.hub.sendToApps(accountId, { t: 'history', sessionId, entries: ctx.sessions.history(accountId, sessionId) }, watching)
      else if (fresh.length) ctx.hub.sendToApps(accountId, { t: 'entries', sessionId, entries: fresh, reset: false }, watching)
      break
    }
    case 'meta':
      if (isSealed(message.meta)) ctx.sessions.setMeta(accountId, sessionId, message.meta)
      break
    case 'permission':
      if (isRequestId(message.request?.requestId) && isText(message.request.ts, 64) && isSealed(message.request.blob)) {
        ctx.sessions.addPermission(accountId, sessionId, message.request)
      }
      break
    case 'permission_closed':
      if (isRequestId(message.requestId)) ctx.sessions.closePermission(accountId, sessionId, message.requestId)
      break
  }
}

function handleAppMessage(ctx: RelayContext, socket: Socket, message: AppMessage) {
  const { accountId } = socket.data
  switch (message?.t) {
    case 'subscribe': {
      socket.data.sessionId = isSessionId(message.sessionId) ? message.sessionId : null
      const sessionId = socket.data.sessionId
      if (sessionId) send(socket, { t: 'history', sessionId, entries: ctx.sessions.history(accountId, sessionId) })
      break
    }
    case 'prompt':
      if (!isSessionId(message.sessionId) || !isSealed(message.payload)) return
      if (!ctx.hub.sendToAgent(accountId, { t: 'prompt', sessionId: message.sessionId, payload: message.payload })) {
        send(socket, { t: 'error', message: 'This session does not accept messages (channel inactive).' })
      }
      break
    case 'verdict': {
      const { sessionId, requestId, behavior } = message
      if (!isSessionId(sessionId) || !isRequestId(requestId) || (behavior !== 'allow' && behavior !== 'deny')) return
      if (ctx.hub.sendToAgent(accountId, { t: 'verdict', sessionId, requestId, behavior })) {
        ctx.sessions.closePermission(accountId, sessionId, requestId)
      }
      break
    }
    case 'dismiss':
      if (isSessionId(message.sessionId)) ctx.sessions.remove(accountId, message.sessionId)
      break
  }
}

function onMachinePresence(ctx: RelayContext, socket: Socket) {
  if (socket.data.machineId) ctx.registry.touchMachine(socket.data.machineId)
  ctx.pushMachines(socket.data.accountId)
}

function send(socket: Socket, message: RelayToApp) {
  socket.send(JSON.stringify(message))
}

function parse(raw: string | Buffer): unknown {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : raw.toString())
  } catch {
    return null
  }
}
