import type { WebSocketHandler } from 'bun'
import type { AgentMessage, AppMessage } from '../../shared/protocol'
import type { RelayContext } from './context'
import type { Socket, SocketData } from './hub'
import {
  HEALTH_MIN_INTERVAL_MS,
  MAX_AGENT_LOG_BYTES,
  MAX_DIAGNOSE_REQUEST_BYTES,
  MAX_DIAGNOSIS_BYTES,
  MAX_HEALTH_BYTES,
  MAX_LOG_REQUEST_BYTES,
  MAX_RULES_BYTES,
  MAX_SESSION_NAME_BYTES,
  MAX_START_DETAIL_BYTES,
  MAX_START_ORDER_BYTES,
  MAX_VIEWERS_PER_SHARE,
  MAX_WS_MESSAGE_BYTES,
} from './limits'
import { isLaunchId, isRequestId, isRequestToken, isSealed, isSessionId, isStartState, isText, isVersion } from './validate'

export function createWebSocketHandler(ctx: RelayContext): WebSocketHandler<SocketData> {
  return {
    maxPayloadLength: MAX_WS_MESSAGE_BYTES,
    idleTimeout: 120,
    sendPings: true,

    open(socket) {
      if (socket.data.role === 'viewer') {
        openViewer(ctx, socket)
        return
      }
      if (socket.data.role === 'app') {
        ctx.hub.addApp(socket)
        const { accountId } = socket.data
        ctx.hub.send(socket, { t: 'snapshot', sessions: ctx.sessions.list(accountId), machines: ctx.machineList(accountId) })
      } else {
        const { machineId, agentVersion } = socket.data
        if (machineId && agentVersion) ctx.agentVersions.set(machineId, agentVersion)
        ctx.hub.addMachineSocket(socket)
        const rules = machineId ? ctx.rules.get(machineId) : undefined
        if (rules) ctx.hub.send(socket, { t: 'rules', rules })
        onMachinePresence(ctx, socket)
      }
    },

    message(socket, raw) {
      ctx.hub.traffic.count('received', socket.data.role, Buffer.byteLength(raw))
      const message = parse(raw)
      // A viewer only reads.
      if (!message || socket.data.role === 'viewer') return
      if (socket.data.role === 'agent') handleAgentMessage(ctx, socket, message as AgentMessage)
      else handleAppMessage(ctx, socket, message as AppMessage)
    },

    close(socket) {
      if (socket.data.role === 'viewer') {
        ctx.hub.removeViewer(socket)
        return
      }
      if (socket.data.role === 'app') {
        ctx.hub.removeApp(socket)
        // The phone went to the background: the relay takes over its Live Activity.
        if (socket.data.device) ctx.push?.deviceWentAway(socket.data.accountId, socket.data.device)
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
    const { launchId, state, detail } = message
    if (!isLaunchId(launchId) || !isStartState(state) || !isSealed(detail, MAX_START_DETAIL_BYTES)) return
    ctx.hub.sendToApps(accountId, { t: 'session_start', machineId, launchId, state, detail })
    return
  }
  if (message?.t === 'agent_logs') {
    const { requestId, logs } = message
    if (!isRequestToken(requestId) || !isSealed(logs, MAX_AGENT_LOG_BYTES)) return
    ctx.hub.sendToApps(accountId, { t: 'agent_logs', machineId, requestId, logs })
    return
  }
  if (message?.t === 'diagnosis') {
    const { requestId, diagnosis } = message
    if (!isRequestToken(requestId) || !isSealed(diagnosis, MAX_DIAGNOSIS_BYTES)) return
    ctx.hub.sendToApps(accountId, { t: 'diagnosis', machineId, requestId, diagnosis })
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
      // The session's shares, for the agent to seal a copy for each.
      for (const share of ctx.registry.shares(accountId, sessionId)) {
        if (share.order) ctx.hub.send(socket, { t: 'share', sessionId, shareId: share.id, order: share.order })
      }
      break
    }
    case 'share_info': {
      if (!isShareOf(ctx, accountId, sessionId, message.shareId) || !isSealed(message.info, MAX_START_DETAIL_BYTES)) return
      ctx.shares.setInfo(message.shareId, message.info)
      ctx.hub.sendToViewers(message.shareId, { t: 'shared_info', info: message.info })
      break
    }
    case 'share_entries': {
      if (!isShareOf(ctx, accountId, sessionId, message.shareId) || !Array.isArray(message.entries)) return
      const entries = message.entries.filter(e => isText(e?.id, 200) && isText(e?.ts, 64) && isSealed(e?.blob))
      const reset = message.reset === true
      const fresh = ctx.shares.addEntries(message.shareId, entries, reset)
      if (reset) ctx.hub.sendToViewers(message.shareId, { t: 'shared_entries', entries: ctx.shares.get(message.shareId).entries, reset })
      else if (fresh.length) ctx.hub.sendToViewers(message.shareId, { t: 'shared_entries', entries: fresh, reset })
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
      if (sessionId) ctx.hub.send(socket, { t: 'history', sessionId, entries: ctx.sessions.history(accountId, sessionId) })
      break
    }
    case 'prompt':
      if (!isSessionId(message.sessionId) || !isSealed(message.payload)) return
      if (!ctx.hub.sendToAgent(accountId, { t: 'prompt', sessionId: message.sessionId, payload: message.payload })) {
        ctx.hub.send(socket, { t: 'error', message: 'This session does not accept messages (channel inactive).' })
      }
      break
    case 'verdict': {
      const { sessionId, requestId, behavior } = message
      if (!isSessionId(sessionId) || !isRequestId(requestId) || (behavior !== 'allow' && behavior !== 'deny')) return
      const rule = behavior === 'allow' && isSealed(message.rule, MAX_RULES_BYTES) ? { rule: message.rule } : {}
      if (ctx.hub.sendToAgent(accountId, { t: 'verdict', sessionId, requestId, behavior, ...rule })) {
        ctx.sessions.closePermission(accountId, sessionId, requestId)
      }
      break
    }
    case 'dismiss':
      if (isSessionId(message.sessionId)) ctx.sessions.remove(accountId, message.sessionId)
      break
    case 'rename':
      if (isSessionId(message.sessionId) && isSealed(message.name, MAX_SESSION_NAME_BYTES))
        ctx.sessions.rename(accountId, message.sessionId, message.name)
      break
    case 'start_session': {
      const { machineId, launchId, order } = message
      if (!isText(machineId, 32) || !isLaunchId(launchId) || !isSealed(order, MAX_START_ORDER_BYTES)) return
      if (!ctx.registry.machines(accountId).some(machine => machine.id === machineId)) return
      const agent = ctx.hub.machineSocket(machineId)
      if (agent) ctx.hub.send(agent, { t: 'start_session', launchId, order })
      else ctx.hub.send(socket, { t: 'session_start', machineId, launchId, state: 'failed', reason: 'offline' })
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
    case 'agent_logs': {
      const { machineId, requestId, request } = message
      if (!isText(machineId, 32) || !isRequestToken(requestId) || !isSealed(request, MAX_LOG_REQUEST_BYTES)) return
      if (!ctx.registry.machines(accountId).some(machine => machine.id === machineId)) return
      // Every process of the machine reads the same log: one of them answers, the background service when it runs.
      const agent = ctx.hub.machineSocket(machineId)
      if (agent) ctx.hub.send(agent, { t: 'agent_logs', requestId, request })
      else ctx.hub.send(socket, { t: 'agent_logs', machineId, requestId, reason: 'offline' })
      break
    }
    case 'diagnose': {
      const { machineId, requestId, request } = message
      if (!isText(machineId, 32) || !isRequestToken(requestId) || !isSealed(request, MAX_DIAGNOSE_REQUEST_BYTES)) return
      if (!ctx.registry.machines(accountId).some(machine => machine.id === machineId)) return
      // The background service when it runs: it can tell whether it runs, and repair what a session's process can't.
      const agent = ctx.hub.machineSocket(machineId)
      if (agent) ctx.hub.send(agent, { t: 'diagnose', requestId, request })
      else ctx.hub.send(socket, { t: 'diagnosis', machineId, requestId, reason: 'offline' })
      break
    }
    case 'update_agent':
      if (isText(message.machineId, 32) && isSealed(message.order, 4096)) requestUpdate(ctx, socket, message.machineId, message.order)
      break
    case 'share': {
      const { sessionId, shareId, order } = message
      if (!isSessionId(sessionId) || !isText(shareId, 32) || !isSealed(order, MAX_START_ORDER_BYTES)) return
      if (ctx.registry.setShareOrder(accountId, shareId, sessionId, order))
        ctx.hub.sendToAgent(accountId, { t: 'share', sessionId, shareId, order })
      break
    }
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
    ctx.hub.send(app, { t: 'agent_update', machineId, ok: false, reason })
    return
  }
  ctx.hub.send(agent, { t: 'update', order })
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

/** What a teammate sees first: the session's status, and the copy its agent sealed for the share. */
function openViewer(ctx: RelayContext, socket: Socket) {
  const { accountId, sessionId, shareId } = socket.data
  if (!shareId || !sessionId) return
  if (!ctx.hub.addViewer(socket, MAX_VIEWERS_PER_SHARE)) {
    socket.close(4002, 'too many viewers')
    return
  }
  const status = ctx.sessions.list(accountId).find(session => session.id === sessionId)?.status ?? 'offline'
  const { info, entries } = ctx.shares.get(shareId)
  ctx.hub.send(socket, { t: 'shared', status, info, entries })
}

const isShareOf = (ctx: RelayContext, accountId: string, sessionId: string, shareId: unknown): shareId is string =>
  isText(shareId, 32) && ctx.registry.share(accountId, shareId)?.sessionId === sessionId

function onMachinePresence(ctx: RelayContext, socket: Socket) {
  if (socket.data.machineId) ctx.registry.touchMachine(socket.data.machineId)
  ctx.pushMachines(socket.data.accountId)
}

function parse(raw: string | Buffer): unknown {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : raw.toString())
  } catch {
    return null
  }
}
