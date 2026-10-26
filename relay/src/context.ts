import type { MachineSummary } from '../../shared/protocol'
import type { RelayConfig } from './config'
import { Hub } from './hub'
import { RATE_LIMITS } from './limits'
import { RateLimiter } from './rate-limit'
import { Registry } from './registry'
import { SessionStore } from './sessions'

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
  readonly signups = new RateLimiter(RATE_LIMITS.signups.limit, RATE_LIMITS.signups.windowMs)
  readonly claims = new RateLimiter(RATE_LIMITS.claims.limit, RATE_LIMITS.claims.windowMs)
  readonly failedAuth = new RateLimiter(RATE_LIMITS.failedAuth.limit, RATE_LIMITS.failedAuth.windowMs)
  private readonly pruneTimer: Timer

  constructor(readonly config: RelayConfig) {
    this.registry = new Registry(config.dataDir)
    this.sessions = new SessionStore({
      updated: (accountId, session) => this.hub.sendToApps(accountId, { t: 'session', session }),
      removed: (accountId, sessionId) => this.hub.sendToApps(accountId, { t: 'removed', sessionId }),
    })
    this.pruneTimer = setInterval(() => {
      for (const limiter of [this.signups, this.claims, this.failedAuth]) limiter.prune()
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

  pushMachines(accountId: string) {
    this.hub.sendToApps(accountId, { t: 'machines', machines: this.machineList(accountId) })
  }

  dispose() {
    clearInterval(this.pruneTimer)
    this.sessions.dispose()
    this.registry.close()
  }
}
