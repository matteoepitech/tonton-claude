import type { ServerWebSocket } from 'bun'
import type { RelayToAgent, RelayToApp } from '../../shared/protocol'
import { type Role, Traffic } from './metrics'

export interface SocketData {
  role: Role
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
  /** Every message goes through `send`, so that it is counted. */
  readonly traffic = new Traffic()

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

  /** Open sockets per role, and machines with at least one of them. */
  counts(): { sockets: Record<Role, number>; machinesOnline: number } {
    const total = (map: Map<string, Set<Socket>>) => [...map.values()].reduce((sum, set) => sum + set.size, 0)
    return { sockets: { app: total(this.apps), agent: total(this.machines) }, machinesOnline: this.machines.size }
  }

  send(socket: Socket, message: RelayToAgent | RelayToApp) {
    const raw = JSON.stringify(message)
    this.sendRaw(socket, raw, Buffer.byteLength(raw))
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
    this.send(agent, message)
    return true
  }

  /** To every connection of the machine: its service and the channel of each session. */
  sendToMachine(machineId: string, message: RelayToAgent) {
    const raw = JSON.stringify(message)
    const bytes = Buffer.byteLength(raw)
    for (const socket of this.machines.get(machineId) ?? []) this.sendRaw(socket, raw, bytes)
  }

  sendToApps(accountId: string, message: RelayToApp, filter?: (socket: Socket) => boolean) {
    const sockets = this.apps.get(accountId)
    if (!sockets?.size) return
    const raw = JSON.stringify(message)
    const bytes = Buffer.byteLength(raw)
    for (const socket of sockets) if (!filter || filter(socket)) this.sendRaw(socket, raw, bytes)
  }

  private sendRaw(socket: Socket, raw: string, bytes: number) {
    this.traffic.count('sent', socket.data.role, bytes)
    socket.send(raw)
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
