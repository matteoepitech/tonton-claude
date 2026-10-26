import type { ServerWebSocket } from 'bun'
import type { RelayToAgent, RelayToApp } from '../../shared/protocol'

export interface SocketData {
  role: 'agent' | 'app'
  accountId: string
  machineId: string | null
  /** Agent: the session it speaks for. App: the session it is watching. */
  sessionId: string | null
  /** Agent: the installed version it reported, null for agents too old to update themselves. */
  agentVersion: string | null
  /** Agent: the machine's background service rather than the channel of a session. */
  service: boolean
}

export type Socket = ServerWebSocket<SocketData>

/** Who is connected: apps per account, agents per session and per machine. */
export class Hub {
  private readonly apps = new Map<string, Set<Socket>>()
  private readonly agents = new Map<string, Socket>()
  private readonly machines = new Map<string, Set<Socket>>()

  addApp(socket: Socket) {
    addTo(this.apps, socket.data.accountId, socket)
  }

  removeApp(socket: Socket) {
    removeFrom(this.apps, socket.data.accountId, socket)
  }

  addMachineSocket(socket: Socket) {
    if (socket.data.machineId) addTo(this.machines, socket.data.machineId, socket)
  }

  removeMachineSocket(socket: Socket) {
    if (socket.data.machineId) removeFrom(this.machines, socket.data.machineId, socket)
  }

  isMachineOnline(machineId: string): boolean {
    return (this.machines.get(machineId)?.size ?? 0) > 0
  }

  /** The machine's background service, or else any of its connections. */
  machineSocket(machineId: string): Socket | null {
    const sockets = [...(this.machines.get(machineId) ?? [])]
    return sockets.find(socket => socket.data.service) ?? sockets[0] ?? null
  }

  /** A socket of the machine whose agent knows how to update itself, the background service when it runs. */
  updatableSocket(machineId: string): Socket | null {
    const sockets = [...(this.machines.get(machineId) ?? [])].filter(socket => socket.data.agentVersion)
    return sockets.find(socket => socket.data.service) ?? sockets[0] ?? null
  }

  bindAgent(socket: Socket, sessionId: string) {
    this.agents.set(sessionKey(socket.data.accountId, sessionId), socket)
  }

  /** Unbinds the agent if it is still the one serving this session. */
  unbindAgent(socket: Socket, sessionId: string): boolean {
    const key = sessionKey(socket.data.accountId, sessionId)
    if (this.agents.get(key) !== socket) return false
    this.agents.delete(key)
    return true
  }

  sendToAgent(accountId: string, message: Extract<RelayToAgent, { sessionId: string }>): boolean {
    const agent = this.agents.get(sessionKey(accountId, message.sessionId))
    if (!agent) return false
    agent.send(JSON.stringify(message))
    return true
  }

  /** To every connection of the machine: its service and the channel of each session. */
  sendToMachine(machineId: string, message: RelayToAgent) {
    const raw = JSON.stringify(message)
    for (const socket of this.machines.get(machineId) ?? []) socket.send(raw)
  }

  sendToApps(accountId: string, message: RelayToApp, filter?: (socket: Socket) => boolean) {
    const sockets = this.apps.get(accountId)
    if (!sockets?.size) return
    const raw = JSON.stringify(message)
    for (const socket of sockets) if (!filter || filter(socket)) socket.send(raw)
  }

  disconnectMachine(machineId: string, reason: string) {
    for (const socket of this.machines.get(machineId) ?? []) socket.close(4001, reason)
  }

  disconnectApps(accountId: string, reason: string) {
    for (const socket of this.apps.get(accountId) ?? []) socket.close(4001, reason)
  }
}

const sessionKey = (accountId: string, sessionId: string) => `${accountId}/${sessionId}`

function addTo(map: Map<string, Set<Socket>>, key: string, socket: Socket) {
  let set = map.get(key)
  if (!set) {
    set = new Set()
    map.set(key, set)
  }
  set.add(socket)
}

function removeFrom(map: Map<string, Set<Socket>>, key: string, socket: Socket) {
  const set = map.get(key)
  set?.delete(socket)
  if (set?.size === 0) map.delete(key)
}
