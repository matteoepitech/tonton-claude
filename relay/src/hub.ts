import type { ServerWebSocket } from 'bun'
import type { PoolUpdate } from '../../shared/pool-protocol'
import type { RelayToAgent, RelayToApp, RelayToViewer } from '../../shared/protocol'
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
  /** Viewer: the read-only share it opened. */
  shareId?: string
  /** App: the install of the iPhone app it is, from `X-Tonton-Device`. Missing for the Mac and older apps. */
  device?: string | null
  /** App: the pools it subscribed to. */
  pools?: Set<string>
}

export type Socket = ServerWebSocket<SocketData>

/** Who is connected: apps per account, agents per session and per machine, viewers per share. */
export class Hub {
  private readonly apps = new Map<string, Set<Socket>>()
  private readonly viewers = new Map<string, Set<Socket>>()
  private readonly agents = new Map<string, Socket>()
  private readonly machines = new Map<string, Set<Socket>>()
  /** App sockets per pool they subscribed to. */
  private readonly poolApps = new Map<string, Set<Socket>>()
  /** `pool/account/session` of the pool sessions whose agent took its order since it connected. */
  private readonly readyPoolSessions = new Set<string>()
  /** `pool/machine` of the pool machines whose service took its order since it connected. */
  private readonly readyPoolMachines = new Set<string>()
  /** Every message goes through `send`, so that it is counted. */
  readonly traffic = new Traffic()

  addApp(socket: Socket) {
    addTo(this.apps, socket.data.accountId, socket)
  }

  removeApp(socket: Socket) {
    removeFrom(this.apps, socket.data.accountId, socket)
    for (const poolId of socket.data.pools ?? []) removeFrom(this.poolApps, poolId, socket)
  }

  subscribePool(socket: Socket, poolId: string) {
    socket.data.pools ??= new Set()
    socket.data.pools.add(poolId)
    addTo(this.poolApps, poolId, socket)
  }

  unsubscribePool(socket: Socket, poolId: string) {
    socket.data.pools?.delete(poolId)
    removeFrom(this.poolApps, poolId, socket)
  }

  /** The account is no longer in the pool: its apps stop getting it. */
  dropPoolAccount(poolId: string, accountId: string) {
    for (const socket of [...(this.poolApps.get(poolId) ?? [])])
      if (socket.data.accountId === accountId) this.unsubscribePool(socket, poolId)
  }

  /**
   * To one member of the pool only: its apps that follow the pool, the agents of its pool sessions and the services of
   * its pool machines.
   */
  sendToPoolMember(poolId: string, accountId: string, message: PoolUpdate, sessions: readonly string[], machines: readonly string[] = []) {
    const raw = JSON.stringify(message)
    const bytes = Buffer.byteLength(raw)
    for (const socket of this.poolApps.get(poolId) ?? []) if (socket.data.accountId === accountId) this.sendRaw(socket, raw, bytes)
    for (const sessionId of sessions) {
      const agent = this.agents.get(sessionKey(accountId, sessionId))
      if (agent) this.sendRaw(agent, raw, bytes)
    }
    this.sendToServices(machines, raw, bytes)
  }

  /** To the apps that subscribed to the pool, the agents of `sessions` and the services of `machines`, the pool's. */
  sendToPool(
    poolId: string,
    message: PoolUpdate,
    sessions: readonly { accountId: string; sessionId: string }[],
    machines: readonly string[] = [],
  ) {
    const raw = JSON.stringify(message)
    const bytes = Buffer.byteLength(raw)
    for (const socket of this.poolApps.get(poolId) ?? []) this.sendRaw(socket, raw, bytes)
    for (const { accountId, sessionId } of sessions) {
      const agent = this.agents.get(sessionKey(accountId, sessionId))
      if (agent) this.sendRaw(agent, raw, bytes)
    }
    this.sendToServices(machines, raw, bytes)
  }

  private sendToServices(machines: readonly string[], raw: string, bytes: number) {
    for (const machineId of machines) {
      const service = this.serviceSocket(machineId)
      if (service) this.sendRaw(service, raw, bytes)
    }
  }

  /** The machine's background service, and none of its sessions' channels: pool machines are run by it. */
  serviceSocket(machineId: string): Socket | null {
    return [...(this.machines.get(machineId) ?? [])].find(socket => socket.data.service) ?? null
  }

  setPoolMachineReady(poolId: string, machineId: string, ready: boolean) {
    const key = `${poolId}/${machineId}`
    if (ready) this.readyPoolMachines.add(key)
    else this.readyPoolMachines.delete(key)
  }

  /** Online as Settings › Machines shows it; ready once its service took the order, while it stays connected. */
  poolMachineState(poolId: string, machineId: string): { online: boolean; ready: boolean } {
    return {
      online: this.isMachineOnline(machineId),
      ready: this.serviceSocket(machineId) !== null && this.readyPoolMachines.has(`${poolId}/${machineId}`),
    }
  }

  /** The agent serving this session, if it is connected. */
  agentOf(accountId: string, sessionId: string): Socket | null {
    return this.agents.get(sessionKey(accountId, sessionId)) ?? null
  }

  setPoolSessionReady(poolId: string, accountId: string, sessionId: string, ready: boolean) {
    const key = `${poolId}/${sessionKey(accountId, sessionId)}`
    if (ready) this.readyPoolSessions.add(key)
    else this.readyPoolSessions.delete(key)
  }

  poolSessionState(poolId: string, accountId: string, sessionId: string): { online: boolean; ready: boolean } {
    const online = this.agents.has(sessionKey(accountId, sessionId))
    return { online, ready: online && this.readyPoolSessions.has(`${poolId}/${sessionKey(accountId, sessionId)}`) }
  }

  addMachineSocket(socket: Socket) {
    if (socket.data.machineId) addTo(this.machines, socket.data.machineId, socket)
  }

  removeMachineSocket(socket: Socket) {
    if (socket.data.machineId) removeFrom(this.machines, socket.data.machineId, socket)
  }

  /** False when the share already has as many viewers as it may. */
  addViewer(socket: Socket, limit: number): boolean {
    const shareId = socket.data.shareId
    if (!shareId || (this.viewers.get(shareId)?.size ?? 0) >= limit) return false
    addTo(this.viewers, shareId, socket)
    return true
  }

  removeViewer(socket: Socket) {
    if (socket.data.shareId) removeFrom(this.viewers, socket.data.shareId, socket)
  }

  hasViewers(): boolean {
    return this.viewers.size > 0
  }

  viewerCount(shareId: string): number {
    return this.viewers.get(shareId)?.size ?? 0
  }

  sendToViewers(shareId: string, message: RelayToViewer) {
    const raw = JSON.stringify(message)
    const bytes = Buffer.byteLength(raw)
    for (const socket of this.viewers.get(shareId) ?? []) this.sendRaw(socket, raw, bytes)
  }

  /** Tells the share's viewers it ended, and closes them. */
  endShare(shareId: string, reason: string) {
    this.sendToViewers(shareId, { t: 'share_ended' })
    for (const socket of this.viewers.get(shareId) ?? []) socket.close(4001, reason)
  }

  /** Open sockets per role, and machines with at least one of them. */
  counts(): { sockets: Record<Role, number>; machinesOnline: number } {
    const total = (map: Map<string, Set<Socket>>) => [...map.values()].reduce((sum, set) => sum + set.size, 0)
    return {
      sockets: { app: total(this.apps), agent: total(this.machines), viewer: total(this.viewers) },
      machinesOnline: this.machines.size,
    }
  }

  send(socket: Socket, message: RelayToAgent | RelayToApp | RelayToViewer | PoolUpdate) {
    const raw = JSON.stringify(message)
    this.sendRaw(socket, raw, Buffer.byteLength(raw))
  }

  isMachineOnline(machineId: string): boolean {
    return (this.machines.get(machineId)?.size ?? 0) > 0
  }

  /** That install of the iPhone app has its socket open, so it is in the foreground. */
  isDeviceOnline(accountId: string, device: string): boolean {
    return [...(this.apps.get(accountId) ?? [])].some(socket => socket.data.device === device)
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

  sendToApps(accountId: string, message: RelayToApp | PoolUpdate, filter?: (socket: Socket) => boolean) {
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
