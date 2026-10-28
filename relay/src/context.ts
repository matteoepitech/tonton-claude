import type { PoolAuditAction, PoolSessionWire, PoolSnapshot, PoolUpdate } from '../../shared/pool-protocol'
import type { MachineSummary, SessionSummary, ShareSummary } from '../../shared/protocol'
import { ApnsClient, type Pusher } from './apns'
import { SessionArchive } from './archive'
import type { RelayConfig } from './config'
import { Hub } from './hub'
import { POOL_SNAPSHOT_AUDIT, RATE_LIMITS } from './limits'
import type { RelayCounts } from './metrics'
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
   * To every app that follows the pool and to the agents of its sessions. While the pool is paused, tasks and messages
   * reach the apps only: the sessions get them when it resumes.
   */
  broadcastPool(poolId: string, message: PoolUpdate) {
    const held = (message.t === 'pool_task' || message.t === 'pool_message') && this.poolSafety.isPaused(poolId)
    this.hub.sendToPool(poolId, message, held ? [] : this.poolSessions(poolId))
  }

  /** What a member sees on subscribing, its rules, budgets and audit log included. */
  poolSnapshot(poolId: string, forAccount: string): PoolSnapshot | null {
    const pool = this.pools.snapshot(poolId, (account, session) => this.poolLive(poolId, account, session), forAccount)
    if (!pool) return null
    return {
      ...pool,
      rules: this.poolSafety.policy(poolId, 'rules'),
      budgets: this.poolSafety.policy(poolId, 'budgets'),
      audit: this.poolSafety.auditLog(poolId, POOL_SNAPSHOT_AUDIT),
    }
  }

  /** The pool resumed: every session's agent gets the pool as it is now, with what was held back. */
  resendPoolToAgents(poolId: string) {
    for (const { accountId, sessionId } of this.poolSessions(poolId)) {
      const agent = this.hub.agentOf(accountId, sessionId)
      const pool = agent ? this.poolSnapshot(poolId, accountId) : null
      if (agent && pool) this.hub.send(agent, { t: 'pool_snapshot', pool })
    }
  }

  /** A line of the pool's audit log, kept and sent to every member. */
  auditPool(poolId: string, author: Author, action: PoolAuditAction, target?: { account?: string; session?: string }, rev?: number) {
    const entry = this.poolSafety.audit(poolId, author, action, target, rev)
    this.broadcastPool(poolId, { t: 'pool_audit', poolId, entry })
  }

  /** The join order for a session's agent, with the rules its owner accepted for it, if any. */
  poolJoin(poolId: string, accountId: string, sessionId: string, order: string) {
    const acceptance = this.poolSafety.acceptance(poolId, accountId, sessionId)
    return { t: 'pool_join' as const, sessionId, poolId, order, ...(acceptance ? { acceptance } : {}) }
  }

  /** The owner deleted the pool: its members and its sessions' agents are told, then forget it. */
  removePool(poolId: string) {
    const members = this.pools.memberAccounts(poolId)
    const sessions = this.pools.remove(poolId)
    this.hub.sendToPool(poolId, { t: 'pool_removed', poolId }, [])
    for (const accountId of members) this.hub.dropPoolAccount(poolId, accountId)
    for (const session of sessions) this.sessionLeftPool(session, false)
  }

  /** A member left: the others see it go with its sessions, its own apps and agents drop the pool. */
  leavePool(poolId: string, accountId: string) {
    const sessions = this.pools.leave(poolId, accountId)
    if (!sessions) return
    this.hub.sendToApps(accountId, { t: 'pool_removed', poolId }, socket => socket.data.pools?.has(poolId) === true)
    this.hub.dropPoolAccount(poolId, accountId)
    for (const session of sessions) this.sessionLeftPool(session, true)
    this.broadcastPool(poolId, { t: 'pool_member_left', poolId, account: accountId })
  }

  /**
   * The pool key went to version `version`: everyone sees the new version, and each member left gets its own wrap. A
   * kicked member is taken out first, like one that left, and never gets the new version.
   */
  poolKeyRotated(
    poolId: string,
    version: number,
    remaining: readonly string[],
    kicked: { account: string; sessions: PoolSessionOrderRow[] } | null,
  ) {
    if (kicked) {
      this.hub.sendToApps(kicked.account, { t: 'pool_removed', poolId }, socket => socket.data.pools?.has(poolId) === true)
      this.hub.dropPoolAccount(poolId, kicked.account)
      for (const session of kicked.sessions) this.sessionLeftPool(session, true)
      this.broadcastPool(poolId, { t: 'pool_member_left', poolId, account: kicked.account })
    }
    const sessions = this.poolSessions(poolId)
    for (const account of remaining) {
      const wrap = this.pools.wrap(poolId, account, version)
      const own = sessions.filter(session => session.accountId === account).map(session => session.sessionId)
      if (wrap) this.hub.sendToPoolMember(poolId, account, { t: 'pool_key', poolId, wrap }, own)
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
