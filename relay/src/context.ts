import type { PoolAuditAction, PoolSessionWire, PoolSnapshot, PoolUpdate } from '../../shared/pool-protocol'
import type { MachineSummary, SessionSummary, ShareSummary } from '../../shared/protocol'
import { ApnsClient, type Pusher } from './apns'
import { SessionArchive } from './archive'
import type { RelayConfig } from './config'
import { Hub } from './hub'
import { POOL_SNAPSHOT_AUDIT, RATE_LIMITS } from './limits'
import type { RelayCounts } from './metrics'
import { type PoolMachineRow, PoolMachineStore, toMachineWire } from './pool-machines'
import { PoolSafetyStore } from './pool-safety'
import { type Author, type PoolSessionOrderRow, PoolStore } from './pools'
import { PushService } from './push'
import { RateLimiter } from './rate-limit'
import { Registry, type Share } from './registry'
import { SessionStore } from './sessions'
import { ShareStreams } from './shares'

export interface RelayOptions {
  /** Stands in for Apple in tests. Without it, pushes go to APNs when the config has a key. */
  pusher?: Pusher
}

/** Everything request and socket handlers need, built once per relay. */
export class RelayContext {
  readonly registry: Registry
  readonly hub = new Hub()
  /** Installed agent version per machine, as last reported. Rebuilt from reconnecting agents after a restart. */
  readonly agentVersions = new Map<string, string>()
  /** Latest sealed health report per machine, and when it arrived. In memory only: the next report comes within a minute. */
  readonly health = new Map<string, { blob: string; at: number }>()
  /**
   * The last sealed auto-approve rules the app sent per machine, handed to each of its connections. In memory only: the
   * app sends them again whenever it connects.
   */
  readonly rules = new Map<string, string>()
  readonly sessions: SessionStore
  /** Pools, their members, sessions and sealed work (docs/pools.md). */
  readonly pools: PoolStore
  /** Pauses, rules, budgets, acceptances and the audit log of pools (relay/src/pool-safety.ts). */
  readonly poolSafety: PoolSafetyStore
  /** The machines members put in pools, and the orchestrator machine (relay/src/pool-machines.ts). */
  readonly poolMachines: PoolMachineStore
  /** What the members were last told of each pool machine's presence, per `pool/machine`. */
  private readonly poolMachinePresences = new Map<string, string>()
  /** Posts per pool member in the current minute, to cap how fast one member can write to a pool. */
  readonly poolPosts = new Map<string, { minute: number; count: number }>()
  /** The status pool members were last told, per pool session: `account/session`. */
  private readonly poolStatuses = new Map<string, string>()
  /** The sealed copies of shared sessions. */
  readonly shares = new ShareStreams()
  private readonly archive: SessionArchive
  /** Null unless the relay has an APNs key. */
  readonly push: PushService | null
  readonly signups = new RateLimiter(RATE_LIMITS.signups.limit, RATE_LIMITS.signups.windowMs)
  readonly claims = new RateLimiter(RATE_LIMITS.claims.limit, RATE_LIMITS.claims.windowMs)
  readonly failedAuth = new RateLimiter(RATE_LIMITS.failedAuth.limit, RATE_LIMITS.failedAuth.windowMs)
  private readonly pruneTimer: Timer
  private readonly startedAt = Date.now()

  constructor(
    readonly config: RelayConfig,
    options: RelayOptions = {},
  ) {
    this.registry = new Registry(config.dataDir)
    this.archive = new SessionArchive(this.registry.db)
    this.pools = new PoolStore(this.registry.db)
    this.poolSafety = new PoolSafetyStore(this.registry.db)
    this.poolMachines = new PoolMachineStore(this.registry.db)
    this.sessions = new SessionStore(
      {
        updated: (accountId, session) => {
          this.hub.sendToApps(accountId, { t: 'session', session })
          this.pushSharedStatus(accountId, session)
          this.poolStatusChanged(accountId, session)
          this.push?.sessionsChanged(accountId)
        },
        removed: (accountId, sessionId) => {
          this.poolStatuses.delete(`${accountId}/${sessionId}`)
          this.hub.sendToApps(accountId, { t: 'removed', sessionId })
          this.push?.sessionsChanged(accountId)
        },
        permissionRequested: (accountId, session, request) => this.push?.permissionRequested(accountId, session, request),
      },
      this.archive,
    )
    const pusher = options.pusher ?? (config.apns ? new ApnsClient(config.apns) : null)
    this.push = pusher
      ? new PushService({
          registry: this.registry,
          sessions: accountId => this.sessions.list(accountId),
          isOnline: (accountId, device) => this.hub.isDeviceOnline(accountId, device),
          pusher,
        })
      : null
    this.pruneTimer = setInterval(() => {
      for (const limiter of [this.signups, this.claims, this.failedAuth]) limiter.prune()
      for (const share of this.registry.expireShares()) this.endShare(share, 'expired')
      this.poolPosts.clear()
    }, 60_000)
  }

  // MARK: Pools

  /** The pool's sessions, as `Hub.sendToPool` reaches their agents. */
  poolSessions(poolId: string): { accountId: string; sessionId: string }[] {
    return this.pools.sessionOrders(poolId).map(({ accountId, sessionId }) => ({ accountId, sessionId }))
  }

  /**
   * To every app that follows the pool, to the agents of its sessions and to the services of its machines. While the pool
   * is paused, tasks and messages reach the apps only: the sessions and the machines get them when it resumes.
   */
  broadcastPool(poolId: string, message: PoolUpdate) {
    const held = (message.t === 'pool_task' || message.t === 'pool_message') && this.poolSafety.isPaused(poolId)
    this.hub.sendToPool(poolId, message, held ? [] : this.poolSessions(poolId), held ? [] : this.poolMachines.ids(poolId))
  }

  /** What a member sees on subscribing, its rules, budgets, audit log and machines included. */
  poolSnapshot(poolId: string, forAccount: string): PoolSnapshot | null {
    const pool = this.pools.snapshot(poolId, (account, session) => this.poolLive(poolId, account, session), forAccount)
    if (!pool) return null
    return {
      ...pool,
      rules: this.poolSafety.policy(poolId, 'rules'),
      budgets: this.poolSafety.policy(poolId, 'budgets'),
      audit: this.poolSafety.auditLog(poolId, POOL_SNAPSHOT_AUDIT),
      machines: this.poolMachines.list(poolId).map(row => this.poolMachineWire(row)),
      orchestratorMachine: this.poolMachines.orchestrator(poolId),
      dispatch: this.poolSafety.policy(poolId, 'dispatch'),
    }
  }

  /** The pool resumed: every session's agent and machine's service gets the pool as it is now, with what was held back. */
  resendPoolToAgents(poolId: string) {
    for (const { accountId, sessionId } of this.poolSessions(poolId)) {
      const agent = this.hub.agentOf(accountId, sessionId)
      const pool = agent ? this.poolSnapshot(poolId, accountId) : null
      if (agent && pool) this.hub.send(agent, { t: 'pool_snapshot', pool })
    }
    for (const row of this.poolMachines.list(poolId)) {
      const service = this.hub.poolMachineState(poolId, row.machineId).ready ? this.hub.serviceSocket(row.machineId) : null
      const pool = service ? this.poolSnapshot(poolId, row.accountId) : null
      if (service && pool) this.hub.send(service, { t: 'pool_snapshot', pool })
    }
  }

  // MARK: Pool machines

  poolMachineWire(row: PoolMachineRow) {
    return toMachineWire(row, this.hub.poolMachineState(row.poolId, row.machineId))
  }

  /** A machine was put in the pool, or its order changed: its service gets the order, the members see it. */
  poolMachineJoined(row: PoolMachineRow) {
    this.hub.setPoolMachineReady(row.poolId, row.machineId, false)
    const service = this.hub.serviceSocket(row.machineId)
    if (service) this.hub.send(service, { t: 'pool_machine_join', machineId: row.machineId, poolId: row.poolId, order: row.order })
    this.poolMachineChanged(row.poolId, row.machineId)
  }

  /**
   * A machine is out of the pool, taken out or gone: its service is told, the sessions it started leave with it, it no
   * longer runs the orchestrator, and the members see it go.
   */
  poolMachineLeft(row: Pick<PoolMachineRow, 'poolId' | 'accountId' | 'machineId'>) {
    const { poolId, machineId } = row
    const leading = this.poolMachines.orchestratorId(poolId) === machineId
    this.poolMachines.remove(poolId, machineId)
    this.hub.setPoolMachineReady(poolId, machineId, false)
    this.poolMachinePresences.delete(`${poolId}/${machineId}`)
    const service = this.hub.serviceSocket(machineId)
    if (service) this.hub.send(service, { t: 'pool_machine_leave', machineId, poolId })
    for (const session of this.pools.sessionsOfMachine(poolId, machineId)) {
      if (this.pools.removeSession(poolId, session.accountId, session.sessionId)) this.sessionLeftPool(session, true)
    }
    if (leading) {
      this.poolMachines.setOrchestrator(poolId, null)
      this.poolOrchestratorChanged(poolId)
    }
    this.broadcastPool(poolId, { t: 'pool_machine_left', poolId, account: row.accountId, machine: machineId })
  }

  /** The machine was revoked: it leaves its pools, as its owner took it out. */
  poolMachineGone(row: PoolMachineRow) {
    this.poolMachineLeft(row)
    this.auditPool(row.poolId, { accountId: row.accountId, sessionId: null }, 'machine_removed', {
      account: row.accountId,
      machine: row.machineId,
    })
  }

  /** The machine's profile, order or presence changed: the members see it. */
  poolMachineChanged(poolId: string, machineId: string) {
    const row = this.poolMachines.get(poolId, machineId)
    if (!row) return
    const machine = this.poolMachineWire(row)
    this.poolMachinePresences.set(`${poolId}/${machineId}`, `${machine.online}/${machine.ready}`)
    this.broadcastPool(poolId, { t: 'pool_machine', poolId, machine })
  }

  /** A connection of the machine came or went: the pools it is in see it online or not, once per change. */
  poolMachinePresence(machineId: string) {
    for (const row of this.poolMachines.poolsOf(machineId)) {
      const live = this.hub.poolMachineState(row.poolId, machineId)
      if (this.poolMachinePresences.get(`${row.poolId}/${machineId}`) !== `${live.online}/${live.ready}`) {
        this.poolMachineChanged(row.poolId, machineId)
      }
    }
  }

  /** The orchestrator session or machine changed: everyone sees both. */
  poolOrchestratorChanged(poolId: string) {
    this.broadcastPool(poolId, {
      t: 'pool_orchestrator',
      poolId,
      orchestrator: this.pools.orchestrator(poolId),
      machine: this.poolMachines.orchestrator(poolId),
    })
  }

  /** A line of the pool's audit log, kept and sent to every member. */
  auditPool(
    poolId: string,
    author: Author,
    action: PoolAuditAction,
    target?: { account?: string; session?: string; machine?: string },
    rev?: number,
  ) {
    const entry = this.poolSafety.audit(poolId, author, action, target, rev)
    this.broadcastPool(poolId, { t: 'pool_audit', poolId, entry })
  }

  /** The join order for a session's agent, with the rules its owner accepted for it, if any. */
  poolJoin(poolId: string, accountId: string, sessionId: string, order: string) {
    const acceptance = this.poolSafety.acceptance(poolId, accountId, sessionId)
    return { t: 'pool_join' as const, sessionId, poolId, order, ...(acceptance ? { acceptance } : {}) }
  }

  /** The owner deleted the pool: its members, its sessions' agents and its machines' services are told, then forget it. */
  removePool(poolId: string) {
    const members = this.pools.memberAccounts(poolId)
    const machines = this.poolMachines.list(poolId)
    const sessions = this.pools.remove(poolId)
    this.hub.sendToPool(poolId, { t: 'pool_removed', poolId }, [])
    for (const accountId of members) this.hub.dropPoolAccount(poolId, accountId)
    for (const session of sessions) this.sessionLeftPool(session, false)
    for (const machine of machines) this.machineDroppedPool(machine)
  }

  /** A member left: the others see it go with its sessions and machines, its own apps, agents and services drop the pool. */
  leavePool(poolId: string, accountId: string) {
    const machines = this.poolMachines.ofAccount(poolId, accountId)
    const sessions = this.pools.leave(poolId, accountId)
    if (!sessions) return
    this.hub.sendToApps(accountId, { t: 'pool_removed', poolId }, socket => socket.data.pools?.has(poolId) === true)
    this.hub.dropPoolAccount(poolId, accountId)
    for (const session of sessions) this.sessionLeftPool(session, true)
    for (const machine of machines) this.machineDroppedPool(machine)
    this.broadcastPool(poolId, { t: 'pool_member_left', poolId, account: accountId })
  }

  /** The machine's rows went with its member or its pool: only its service is told, the members see the member go. */
  private machineDroppedPool(row: PoolMachineRow) {
    this.hub.setPoolMachineReady(row.poolId, row.machineId, false)
    this.poolMachinePresences.delete(`${row.poolId}/${row.machineId}`)
    const service = this.hub.serviceSocket(row.machineId)
    if (service) this.hub.send(service, { t: 'pool_machine_leave', machineId: row.machineId, poolId: row.poolId })
  }

  /**
   * The pool key went to version `version`: everyone sees the new version, and each member left gets its own wrap. A
   * kicked member is taken out first, like one that left, and never gets the new version.
   */
  poolKeyRotated(
    poolId: string,
    version: number,
    remaining: readonly string[],
    kicked: { account: string; sessions: PoolSessionOrderRow[]; machines: PoolMachineRow[] } | null,
  ) {
    if (kicked) {
      this.hub.sendToApps(kicked.account, { t: 'pool_removed', poolId }, socket => socket.data.pools?.has(poolId) === true)
      this.hub.dropPoolAccount(poolId, kicked.account)
      for (const session of kicked.sessions) this.sessionLeftPool(session, true)
      for (const machine of kicked.machines) this.machineDroppedPool(machine)
      this.broadcastPool(poolId, { t: 'pool_member_left', poolId, account: kicked.account })
    }
    const sessions = this.poolSessions(poolId)
    const machines = this.poolMachines.list(poolId)
    for (const account of remaining) {
      const wrap = this.pools.wrap(poolId, account, version)
      const own = sessions.filter(session => session.accountId === account).map(session => session.sessionId)
      const ownMachines = machines.filter(machine => machine.accountId === account).map(machine => machine.machineId)
      if (wrap) this.hub.sendToPoolMember(poolId, account, { t: 'pool_key', poolId, wrap }, own, ownMachines)
    }
    const state = this.pools.state(poolId)
    if (state) this.broadcastPool(poolId, { t: 'pool_info', poolId, ...state })
  }

  /** Tells the session's agent it is out of the pool, and the members when `announce`. */
  sessionLeftPool(session: Pick<PoolSessionOrderRow, 'poolId' | 'accountId' | 'sessionId'>, announce: boolean) {
    const { poolId, accountId, sessionId } = session
    this.hub.setPoolSessionReady(poolId, accountId, sessionId, false)
    const agent = this.hub.agentOf(accountId, sessionId)
    if (agent) this.hub.send(agent, { t: 'pool_left', sessionId, poolId })
    if (announce) this.broadcastPool(poolId, { t: 'pool_session_left', poolId, account: accountId, session: sessionId })
  }

  /** Whether a pool session's agent is connected and ready, and its status: the relay sees it anyway, the members see it too. */
  poolLive(poolId: string, accountId: string, sessionId: string): Pick<PoolSessionWire, 'online' | 'ready' | 'status'> {
    const status = this.sessions.list(accountId).find(session => session.id === sessionId)?.status
    return { ...this.hub.poolSessionState(poolId, accountId, sessionId), ...(status ? { status } : {}) }
  }

  /** A session's status changed: the pools it works for see it, once per change rather than with every entry. */
  private poolStatusChanged(accountId: string, session: SessionSummary) {
    const key = `${accountId}/${session.id}`
    if (this.poolStatuses.get(key) === session.status) return
    const orders = this.pools.ordersFor(accountId, session.id)
    if (!orders.length) return
    this.poolStatuses.set(key, session.status)
    for (const order of orders) this.poolSessionChanged(order.poolId, accountId, session.id)
  }

  /** A pool session's agent connected, left or took its order: the members see it. */
  poolSessionChanged(poolId: string, accountId: string, sessionId: string) {
    const session = this.pools.sessions(poolId).find(s => s.account === accountId && s.session === sessionId)
    if (session) {
      this.broadcastPool(poolId, { t: 'pool_session', poolId, session: { ...session, ...this.poolLive(poolId, accountId, sessionId) } })
    }
  }

  /** False once the member wrote to the pool as often as it may this minute. */
  allowPoolPost(poolId: string, accountId: string, limit: number): boolean {
    const minute = Math.floor(Date.now() / 60_000)
    const key = `${poolId}/${accountId}`
    const current = this.poolPosts.get(key)
    const count = current?.minute === minute ? current.count + 1 : 1
    this.poolPosts.set(key, { minute, count })
    return count <= limit
  }

  /** Before an account is deleted: the pools it owns go, it leaves the others. */
  removeAccountPools(accountId: string) {
    const { owned, joined } = this.pools.poolsOf(accountId)
    for (const poolId of owned) this.removePool(poolId)
    for (const poolId of joined) this.leavePool(poolId, accountId)
  }

  machineList(accountId: string): MachineSummary[] {
    return this.registry.machines(accountId).map(machine => ({
      id: machine.id,
      name: machine.nameBlob,
      createdAt: machine.createdAt,
      lastSeen: machine.lastSeen,
      online: this.hub.isMachineOnline(machine.id),
      agentVersion: this.agentVersions.get(machine.id) ?? null,
      health: this.health.get(machine.id)?.blob ?? null,
    }))
  }

  /** Forgets what the relay keeps about a machine that is gone. */
  forgetMachine(machineId: string) {
    this.agentVersions.delete(machineId)
    this.rules.delete(machineId)
    this.health.delete(machineId)
  }

  /** The account's shares as the app lists them: never their token nor their key. */
  shareList(accountId: string): ShareSummary[] {
    return this.registry.shares(accountId).map(share => ({
      id: share.id,
      sessionId: share.sessionId,
      createdAt: share.createdAt,
      expiresAt: new Date(share.expiresAt).toISOString(),
      viewers: this.hub.viewerCount(share.id),
    }))
  }

  /** Once revoked or expired: its viewers are closed, its copy dropped, and its agent stops sealing for it. */
  endShare(share: Share, reason: string) {
    this.hub.endShare(share.id, reason)
    this.shares.drop(share.id)
    this.hub.sendToAgent(share.accountId, { t: 'unshare', sessionId: share.sessionId, shareId: share.id })
  }

  /** The session's status, which the relay sees anyway, to whoever watches one of its shares. */
  private pushSharedStatus(accountId: string, session: SessionSummary) {
    if (!this.hub.hasViewers()) return
    for (const share of this.registry.shares(accountId, session.id)) {
      if (this.hub.viewerCount(share.id)) this.hub.sendToViewers(share.id, { t: 'shared_status', status: session.status })
    }
  }

  /** What the metrics page shows: totals over the whole relay. */
  counts(): RelayCounts {
    const { sockets, machinesOnline } = this.hub.counts()
    const sessions = this.sessions.stats()
    return {
      ...this.registry.counts(),
      machinesOnline,
      sockets,
      sessions: sessions.byStatus,
      historyEntries: sessions.entries,
      historyBytes: sessions.bytes,
      traffic: this.hub.traffic,
      startedAt: this.startedAt,
    }
  }

  pushMachines(accountId: string) {
    this.hub.sendToApps(accountId, { t: 'machines', machines: this.machineList(accountId) })
  }

  dispose() {
    clearInterval(this.pruneTimer)
    this.push?.dispose()
    this.sessions.dispose()
    this.archive.close()
    this.registry.close()
  }
}
