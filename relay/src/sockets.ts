import type { WebSocketHandler } from 'bun'
import type { AgentMessage, AppMessage, RelayToAgent, RelayToApp } from '../../shared/protocol'
import type { RelayContext } from './context'
import type { Socket, SocketData } from './hub'
import {
  HEALTH_MIN_INTERVAL_MS,
  MAX_HEALTH_BYTES,
  MAX_RULES_BYTES,
  MAX_START_DETAIL_BYTES,
  MAX_START_ORDER_BYTES,
  MAX_WS_MESSAGE_BYTES,
} from './limits'
import { isLaunchId, isRequestId, isSealed, isSessionId, isStartState, isText, isVersion } from './validate'

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
        const { machineId, agentVersion } = socket.data
        if (machineId && agentVersion) ctx.agentVersions.set(machineId, agentVersion)
        ctx.hub.addMachineSocket(socket)
        const rules = machineId ? ctx.rules.get(machineId) : undefined
        if (rules) socket.send(JSON.stringify({ t: 'rules', rules } satisfies RelayToAgent))
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
  if (!machineId) return
  if (message?.t === 'update_result') {
    onUpdateResult(ctx, accountId, machineId, message)
    return
  }
  if (message?.t === 'health') {
    const previous = ctx.health.get(machineId)
    if (!isSealed(message.health, MAX_HEALTH_BYTES) || (previous && Date.now() - previous.at < HEALTH_MIN_INTERVAL_MS)) return
    ctx.health.set(machineId, { blob: message.health, at: Date.now() })
    ctx.pushMachines(accountId)
    return
  }
  if (message?.t === 'session_start') {
    const { launchId, state, detail, sessionId } = message
    if (!isLaunchId(launchId) || !isStartState(state)) return
    ctx.hub.sendToApps(accountId, {
      t: 'session_start',
      machineId,
      launchId,
      state,
      detail: isSealed(detail, MAX_START_DETAIL_BYTES) ? detail : null,
      ...(isSessionId(sessionId) ? { sessionId } : {}),
    })
    return
  }
  if (!isSessionId(message?.sessionId)) return
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
    case 'start_session': {
      const { machineId, launchId, order } = message
      if (!isText(machineId, 32) || !isLaunchId(launchId) || !isSealed(order, MAX_START_ORDER_BYTES)) return
      if (!ctx.registry.machines(accountId).some(machine => machine.id === machineId)) return
      const agent = ctx.hub.machineSocket(machineId)
      if (agent) agent.send(JSON.stringify({ t: 'start_session', launchId, order } satisfies RelayToAgent))
      else send(socket, { t: 'session_start', machineId, launchId, state: 'failed', reason: 'offline' })
      break
    }
    case 'start_answer': {
      const { machineId, launchId, answer } = message
      if (!isText(machineId, 32) || !isLaunchId(launchId) || !isSealed(answer, MAX_START_ORDER_BYTES)) return
      if (!ctx.registry.machines(accountId).some(machine => machine.id === machineId)) return
      // Only the connection that runs this start acts on it.
      ctx.hub.sendToMachine(machineId, { t: 'start_answer', launchId, answer })
      break
    }
    case 'update_agent':
      if (isText(message.machineId, 32) && isSealed(message.order, 4096)) requestUpdate(ctx, socket, message.machineId, message.order)
      break
    case 'rules': {
      const { machineId, rules } = message
      if (!isText(machineId, 32) || !isSealed(rules, MAX_RULES_BYTES)) return
      if (!ctx.registry.machines(accountId).some(machine => machine.id === machineId)) return
      ctx.rules.set(machineId, rules)
      ctx.hub.sendToMachine(machineId, { t: 'rules', rules })
      break
    }
  }
}

/** Hands the sealed order to one channel of the machine: running several updates at once would race on the binary. */
function requestUpdate(ctx: RelayContext, app: Socket, machineId: string, order: string) {
  const { accountId } = app.data
  if (!ctx.registry.machines(accountId).some(machine => machine.id === machineId)) return
  const agent = ctx.hub.updatableSocket(machineId)
  if (!agent) {
    const reason = ctx.hub.isMachineOnline(machineId) ? 'unsupported' : 'offline'
    send(app, { t: 'agent_update', machineId, ok: false, reason })
    return
  }
  const update: RelayToAgent = { t: 'update', order }
  agent.send(JSON.stringify(update))
}

function onUpdateResult(ctx: RelayContext, accountId: string, machineId: string, message: Extract<AgentMessage, { t: 'update_result' }>) {
  const ok = message.ok === true
  if (ok && isVersion(message.version)) {
    ctx.agentVersions.set(machineId, message.version)
    ctx.pushMachines(accountId)
  }
  const detail = isSealed(message.detail, 8192) ? message.detail : null
  ctx.hub.sendToApps(accountId, { t: 'agent_update', machineId, ok, detail })
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
