import type { MachineSummary, SessionSummary, ShareSummary } from '../../shared/protocol'
import { ApnsClient, type Pusher } from './apns'
import { SessionArchive } from './archive'
import type { RelayConfig } from './config'
import { Hub } from './hub'
import { RATE_LIMITS } from './limits'
import type { RelayCounts } from './metrics'
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
    this.sessions = new SessionStore(
      {
        updated: (accountId, session) => {
          this.hub.sendToApps(accountId, { t: 'session', session })
          this.pushSharedStatus(accountId, session)
          this.push?.sessionsChanged(accountId)
        },
        removed: (accountId, sessionId) => {
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
    }, 60_000)
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
