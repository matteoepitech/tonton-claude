// Pushes to the iPhone app through APNs: an alert for each permission request, and the Live Activity that shows the
// sessions on the Lock Screen and in the Dynamic Island. Only ids, states and the agents' sealed blobs go to Apple; the
// alert's own text is the same for every request, and the phone writes the real one from the blobs.
import type {
  IslandSession,
  IslandState,
  PermissionPush,
  PushDevice,
  SealedPermission,
  SessionStatus,
  SessionSummary,
} from '../../shared/protocol'
import type { ApnsPush, ApnsResult, Pusher } from './apns'
import {
  ISLAND_DEBOUNCE_MS,
  ISLAND_MIN_INTERVAL_MS,
  ISLAND_QUIET_MS,
  ISLAND_RESTART_MS,
  ISLAND_SESSIONS,
  MAX_ALERTED_REQUESTS,
  MAX_ISLAND_DETAIL_BYTES,
  MAX_ISLAND_INFO_BYTES,
  MAX_PUSH_PAYLOAD_BYTES,
  PERMISSION_ALERT_TTL_S,
} from './limits'
import type { PushTokenKind, Registry, StoredPushDevice } from './registry'

/** The ActivityAttributes type of the iPhone app, which a push that starts a Live Activity names. */
export const ACTIVITY_ATTRIBUTES_TYPE = 'SessionsActivityAttributes'

const ISLAND_RANK: Partial<Record<SessionStatus, number>> = { permission: 0, error: 1, waiting: 2, working: 3, starting: 4, idle: 5 }

/** What the Live Activity shows, built like `IslandState(_:)` in app/Sources/TontonCore/Island.swift. */
export function islandState(sessions: SessionSummary[]): IslandState {
  const ranked = sessions
    .filter(session => ISLAND_RANK[session.status] !== undefined)
    .sort((a, b) => rank(a) - rank(b) || compare(b.lastActivity, a.lastActivity) || compare(a.id, b.id))
  return {
    sessions: ranked.slice(0, ISLAND_SESSIONS).map(session => ({
      id: session.id,
      status: session.status,
      info: session.info && session.info.length <= MAX_ISLAND_INFO_BYTES ? session.info : null,
      detail: session.statusDetail && session.statusDetail.length <= MAX_ISLAND_DETAIL_BYTES ? session.statusDetail : null,
    })),
    working: sessions.filter(session => session.status === 'working' || session.status === 'starting').length,
    attention: sessions.filter(session => session.status === 'permission' || session.status === 'waiting' || session.status === 'error')
      .length,
  }
}

const rank = (session: SessionSummary) => ISLAND_RANK[session.status] ?? 9
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const isActive = (state: IslandState) => state.working + state.attention > 0

/** The alert for a permission request. The sealed blobs go when the alert would not fit, the generic text stays. */
export function permissionAlert(session: SessionSummary, request: SealedPermission): string {
  const aps = {
    alert: { title: 'Permission request', body: 'A Claude Code session is waiting for your approval.' },
    sound: 'default',
    'mutable-content': 1,
    category: 'permission',
    'thread-id': session.id,
    'interruption-level': 'time-sensitive',
  }
  const base: PermissionPush = { sessionId: session.id, requestId: request.requestId }
  const attempts: PermissionPush[] = [
    { ...base, request: request.blob, ...(session.info ? { info: session.info } : {}) },
    { ...base, request: request.blob },
    base,
  ]
  for (const tonton of attempts) {
    const payload = JSON.stringify({ aps, tonton })
    if (byteLength(payload) <= MAX_PUSH_PAYLOAD_BYTES) return payload
  }
  return JSON.stringify({ aps, tonton: base })
}

export type IslandEvent = 'start' | 'update' | 'end'

/** A Live Activity push. Details, then sessions, are dropped until it fits. */
export function islandPayload(state: IslandState, event: IslandEvent, nowSeconds: number): string {
  const build = (contentState: IslandState) => {
    const aps: Record<string, unknown> = { timestamp: nowSeconds, event, 'content-state': contentState }
    if (event === 'end') aps['dismissal-date'] = nowSeconds
    if (event === 'start') {
      aps['attributes-type'] = ACTIVITY_ATTRIBUTES_TYPE
      aps.attributes = {}
      aps.alert = { title: 'Tonton Claude', body: state.attention > 0 ? 'A session needs you.' : 'A session is running.' }
    }
    return JSON.stringify({ aps })
  }
  const withoutDetails = (sessions: IslandSession[]) => sessions.map(session => ({ ...session, detail: null }))
  for (let count = state.sessions.length; count >= 0; count--) {
    for (const sessions of [state.sessions.slice(0, count), withoutDetails(state.sessions.slice(0, count))]) {
      const payload = build({ ...state, sessions })
      if (byteLength(payload) <= MAX_PUSH_PAYLOAD_BYTES) return payload
    }
  }
  return build({ ...state, sessions: [] })
}

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8')

export interface PushDependencies {
  registry: Registry
  /** The live sessions of an account. */
  sessions: (accountId: string) => SessionSummary[]
  /** True while that install of the app has its socket open: it updates its Live Activity itself. */
  isOnline: (accountId: string, deviceId: string) => boolean
  pusher: Pusher
  now?: () => number
  schedule?: (run: () => void, ms: number) => Timer
}

interface IslandMemory {
  /** The JSON last pushed to this Live Activity token. */
  pushed: string | null
  attention: number
  at: number
}

/** Present only when the relay has an APNs key. */
export class PushService {
  private readonly now: () => number
  private readonly schedule: (run: () => void, ms: number) => Timer
  private readonly timers = new Map<string, { timer: Timer; due: number }>()
  /** Per Live Activity token. */
  private readonly islands = new Map<string, IslandMemory>()
  /** Since when nothing has run, per account. */
  private readonly quietSince = new Map<string, number>()
  /** When the relay last started a Live Activity on a device the phone has not reported since, per device. */
  private readonly started = new Map<string, number>()
  private readonly alerted = new Map<string, number>()
  private readonly logged = new Map<string, number>()

  constructor(private readonly deps: PushDependencies) {
    this.now = deps.now ?? Date.now
    this.schedule = deps.schedule ?? ((run, ms) => setTimeout(run, ms))
  }

  register(accountId: string, device: PushDevice) {
    const previous = this.deps.registry.pushDevices(accountId).find(stored => stored.device === device.device)
    this.deps.registry.savePushDevice(accountId, device)
    // The phone reports its Live Activity: the relay may start the next one once this one is gone.
    if (previous?.activity !== device.activity) this.started.delete(deviceKey(accountId, device.device))
    if (device.activity) this.sessionsChanged(accountId)
  }

  unregister(accountId: string, deviceId: string) {
    this.deps.registry.removePushDevice(accountId, deviceId)
    this.started.delete(deviceKey(accountId, deviceId))
  }

  /** A new request from an agent: one alert per device, once. */
  permissionRequested(accountId: string, session: SessionSummary, request: SealedPermission) {
    const key = `${accountId}/${session.id}/${request.requestId}`
    if (this.alerted.has(key)) return
    this.alerted.set(key, this.now())
    if (this.alerted.size > MAX_ALERTED_REQUESTS) {
      const oldest = this.alerted.keys().next().value
      if (oldest !== undefined) this.alerted.delete(oldest)
    }
    const payload = permissionAlert(session, request)
    const expiration = Math.floor(this.now() / 1000) + PERMISSION_ALERT_TTL_S
    for (const device of this.deps.registry.pushDevices(accountId)) {
      if (!device.alert) continue
      const push: ApnsPush = {
        token: device.alert,
        environment: device.environment,
        type: 'alert',
        priority: 10,
        payload,
        expiration,
        collapseId: request.requestId,
      }
      void this.deliver(device, 'alert', push)
    }
  }

  /** Something changed in the account's sessions: the Live Activities follow, a moment later. */
  sessionsChanged(accountId: string, delay = ISLAND_DEBOUNCE_MS) {
    const due = this.now() + delay
    const pending = this.timers.get(accountId)
    if (pending && pending.due <= due) return
    if (pending) clearTimeout(pending.timer)
    const timer = this.schedule(() => {
      this.timers.delete(accountId)
      this.updateIslands(accountId)
    }, delay)
    this.timers.set(accountId, { timer, due })
  }

  /** Pushes the account's Live Activities now. Called by the timer, and by tests. */
  updateIslands(accountId: string) {
    const devices = this.deps.registry.pushDevices(accountId)
    if (!devices.some(device => device.activity || device.activityStart)) return
    const state = islandState(this.deps.sessions(accountId))
    const now = this.now()
    const active = isActive(state)
    if (active) this.quietSince.delete(accountId)
    else if (!this.quietSince.has(accountId)) this.quietSince.set(accountId, now)
    const quietFor = now - (this.quietSince.get(accountId) ?? now)
    let next = Number.POSITIVE_INFINITY

    for (const device of devices) {
      // An open app keeps its Live Activity up to date itself. It closes its socket when it goes to the background,
      // which brings the relay back here.
      if (this.deps.isOnline(accountId, device.device)) continue
      if (device.activity) {
        if (!active && quietFor >= ISLAND_QUIET_MS) {
          this.endIsland(device, device.activity, state)
          continue
        }
        if (!active) next = Math.min(next, ISLAND_QUIET_MS - quietFor)
        const wait = this.pushIsland(device, device.activity, state)
        if (wait > 0) next = Math.min(next, wait)
      } else if (device.activityStart && active) {
        const key = deviceKey(accountId, device.device)
        const startedAt = this.started.get(key)
        if (startedAt !== undefined && now - startedAt < ISLAND_RESTART_MS) continue
        this.started.set(key, now)
        void this.deliver(
          device,
          'activityStart',
          this.islandPush(device, device.activityStart, islandPayload(state, 'start', seconds(now)), 10),
        )
      }
    }
    if (Number.isFinite(next)) this.sessionsChanged(accountId, next)
  }

  dispose() {
    for (const { timer } of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.deps.pusher.close()
  }

  /** Returns how long to wait before it can be pushed, 0 once pushed or when there is nothing new. */
  private pushIsland(device: StoredPushDevice, token: string, state: IslandState): number {
    const content = JSON.stringify(state)
    const memory = this.islands.get(token)
    if (memory?.pushed === content) return 0
    const now = this.now()
    // A session that starts needing the user goes right away, and lights up the Dynamic Island.
    const urgent = state.attention > (memory?.attention ?? 0)
    if (memory && !urgent && now - memory.at < ISLAND_MIN_INTERVAL_MS) return ISLAND_MIN_INTERVAL_MS - (now - memory.at)
    this.islands.set(token, { pushed: content, attention: state.attention, at: now })
    void this.deliver(device, 'activity', this.islandPush(device, token, islandPayload(state, 'update', seconds(now)), urgent ? 10 : 5))
    return 0
  }

  private endIsland(device: StoredPushDevice, token: string, state: IslandState) {
    this.islands.delete(token)
    this.deps.registry.clearPushToken(device.accountId, device.device, 'activity', token)
    this.started.delete(deviceKey(device.accountId, device.device))
    void this.deliver(device, 'activity', this.islandPush(device, token, islandPayload(state, 'end', seconds(this.now())), 5))
  }

  private islandPush(device: StoredPushDevice, token: string, payload: string, priority: 5 | 10): ApnsPush {
    return { token, environment: device.environment, type: 'liveactivity', priority, payload }
  }

  /** Forgets the tokens Apple says are dead. Never logs a token or a payload. */
  private async deliver(device: StoredPushDevice, kind: PushTokenKind, push: ApnsPush): Promise<ApnsResult> {
    let result: ApnsResult
    try {
      result = await this.deps.pusher.send(push)
    } catch {
      result = { status: 0, reason: 'Unreachable' }
    }
    if (result.status === 200) return result
    if (result.status === 410 || result.reason === 'BadDeviceToken' || result.reason === 'DeviceTokenNotForTopic') {
      this.deps.registry.clearPushToken(device.accountId, device.device, kind, push.token)
      if (kind === 'activity') this.islands.delete(push.token)
      return result
    }
    this.log(`APNs refused a push: ${result.status} ${result.reason ?? ''}`.trim())
    return result
  }

  /** Once per message every 10 minutes: a wrong key would refuse every push. */
  private log(message: string) {
    const now = this.now()
    if (now - (this.logged.get(message) ?? Number.NEGATIVE_INFINITY) < 10 * 60_000) return
    this.logged.set(message, now)
    console.warn(message)
  }
}

const deviceKey = (accountId: string, deviceId: string) => `${accountId}/${deviceId}`
const seconds = (ms: number) => Math.floor(ms / 1000)
