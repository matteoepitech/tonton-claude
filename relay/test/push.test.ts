import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IslandState, PermissionPush, SessionStatus, SessionSummary } from '../../shared/protocol'
import type { ApnsPush, ApnsResult } from '../src/apns'
import {
  ISLAND_MIN_INTERVAL_MS,
  ISLAND_QUIET_MS,
  ISLAND_RESTART_MS,
  ISLAND_START_GRACE_MS,
  MAX_PUSH_DEVICES_PER_ACCOUNT,
  MAX_PUSH_PAYLOAD_BYTES,
} from '../src/limits'
import { islandPayload, islandState, PushService, permissionAlert } from '../src/push'
import { Registry } from '../src/registry'

const session = (id: string, status: SessionStatus, lastActivity = '2026-10-26T10:00:00.000Z', extra: Partial<SessionSummary> = {}) =>
  ({
    id,
    machineId: 'm1',
    status,
    agentOnline: true,
    canChat: true,
    info: `info-${id}`,
    meta: 'sealed-meta',
    statusDetail: null,
    pendingPermissions: [],
    startedAt: lastActivity,
    lastActivity,
    ...extra,
  }) satisfies SessionSummary

const hex = (n: number) => n.toString(16).padStart(64, '0')

describe('island state', () => {
  test('those that need the user first, then the latest at work, then the latest done; closed ones are left out', () => {
    const state = islandState([
      session('done', 'idle', '2026-10-26T10:09:00.000Z'),
      session('old-work', 'working', '2026-10-26T10:01:00.000Z'),
      session('new-work', 'working', '2026-10-26T10:05:00.000Z'),
      session('asks', 'permission', '2026-10-26T09:00:00.000Z'),
      session('gone', 'ended', '2026-10-26T10:10:00.000Z'),
      session('away', 'offline', '2026-10-26T10:10:00.000Z'),
    ])
    expect(state.sessions.map(s => s.id)).toEqual(['asks', 'new-work', 'old-work'])
    expect(state).toMatchObject({ working: 2, attention: 1 })
    expect(state.sessions[0]).toEqual({ id: 'asks', status: 'permission', info: 'info-asks', detail: null })
  })

  test('blobs too long to push are left out', () => {
    const state = islandState([session('a', 'waiting', undefined, { info: 'x'.repeat(2000), statusDetail: 'y'.repeat(600) })])
    expect(state.sessions[0]).toMatchObject({ info: null, detail: null })
    expect(islandState([session('b', 'error', undefined, { statusDetail: 'sealed' })]).sessions[0].detail).toBe('sealed')
  })

  test('a push always fits in what Apple accepts, dropping details then sessions', () => {
    const big: IslandState = {
      working: 3,
      attention: 0,
      sessions: ['a', 'b', 'c'].map(id => ({ id: id.repeat(100), status: 'working', info: 'i'.repeat(1024), detail: 'd'.repeat(512) })),
    }
    for (const event of ['start', 'update', 'end'] as const) {
      const payload = islandPayload(big, event, 1_800_000_000)
      expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES)
      const { aps } = JSON.parse(payload)
      expect(aps.event).toBe(event)
      expect(aps['content-state'].working).toBe(3)
    }
    const start = JSON.parse(islandPayload(big, 'start', 1)).aps
    expect(start).toMatchObject({ 'attributes-type': 'SessionsActivityAttributes', attributes: {}, alert: { title: 'Tonton Claude' } })
    expect(JSON.parse(islandPayload(big, 'end', 7)).aps['dismissal-date']).toBe(7)
  })
})

describe('permission alerts', () => {
  test('the text says nothing about the session, the sealed blobs ride along', () => {
    const payload = JSON.parse(permissionAlert(session('s1', 'permission'), { requestId: 'r1', ts: 't', blob: 'sealed-request' }))
    expect(payload.aps).toMatchObject({ 'mutable-content': 1, category: 'permission', 'thread-id': 's1' })
    expect(payload.aps.alert).toEqual({ title: 'Permission request', body: 'A Claude Code session is waiting for your approval.' })
    expect(payload.tonton).toEqual({
      sessionId: 's1',
      requestId: 'r1',
      request: 'sealed-request',
      info: 'info-s1',
    } satisfies PermissionPush)
  })

  test('blobs that would not fit are dropped, the alert still goes', () => {
    const huge = permissionAlert(session('s1', 'permission', undefined, { info: 'i'.repeat(3000) }), {
      requestId: 'r',
      ts: 't',
      blob: 'b'.repeat(2000),
    })
    expect(JSON.parse(huge).tonton).toEqual({ sessionId: 's1', requestId: 'r', request: 'b'.repeat(2000) })
    const larger = permissionAlert(session('s1', 'permission'), { requestId: 'r', ts: 't', blob: 'b'.repeat(5000) })
    expect(JSON.parse(larger).tonton).toEqual({ sessionId: 's1', requestId: 'r' })
  })
})

describe('PushService', () => {
  let dir: string
  let registry: Registry
  let sessions: SessionSummary[]
  let online: Set<string>
  let sent: ApnsPush[]
  let answer: (push: ApnsPush) => ApnsResult
  let clock: number
  let service: PushService
  let accountId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tonton-push-'))
    registry = new Registry(dir)
    accountId = registry.createAccount().id
    sessions = []
    online = new Set()
    sent = []
    answer = () => ({ status: 200, reason: null })
    clock = 1_800_000_000_000
    service = new PushService({
      registry,
      sessions: () => sessions,
      isOnline: (_account, device) => online.has(device),
      pusher: {
        send: async push => {
          sent.push(push)
          return answer(push)
        },
        close: () => {},
      },
      now: () => clock,
      // Timers are run by hand.
      schedule: () => setTimeout(() => {}, 0),
    })
  })

  afterEach(() => {
    service.dispose()
    registry.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const register = (device: string, tokens: { alert?: string; activity?: string; activityStart?: string }) =>
    service.register(accountId, {
      device,
      environment: 'sandbox',
      alert: tokens.alert ?? null,
      activity: tokens.activity ?? null,
      activityStart: tokens.activityStart ?? null,
    })
  const settle = () => Bun.sleep(5)
  const events = () => sent.map(push => JSON.parse(push.payload).aps.event)

  test('one alert per device and request, even when an agent sends the request again', async () => {
    register('phone-0001', { alert: hex(1) })
    register('ipad-00001', { alert: hex(2) })
    register('watchless', {})
    const asking = session('s1', 'permission')
    service.permissionRequested(accountId, asking, { requestId: 'r1', ts: 't', blob: 'sealed' })
    service.permissionRequested(accountId, asking, { requestId: 'r1', ts: 't', blob: 'sealed' })
    await settle()
    expect(sent.map(push => push.token).sort()).toEqual([hex(1), hex(2)])
    expect(sent[0]).toMatchObject({ type: 'alert', priority: 10, collapseId: 'r1', environment: 'sandbox' })
    expect(sent[0].expiration).toBe(Math.floor(clock / 1000) + 600)
  })

  test('a token Apple says is dead is forgotten', async () => {
    register('phone-0001', { alert: hex(1), activity: hex(3) })
    answer = push => (push.type === 'alert' ? { status: 410, reason: 'Unregistered' } : { status: 400, reason: 'BadDeviceToken' })
    service.permissionRequested(accountId, session('s1', 'permission'), { requestId: 'r1', ts: 't', blob: 'b' })
    sessions = [session('s1', 'working')]
    service.updateIslands(accountId)
    await settle()
    expect(registry.pushDevices(accountId)[0]).toMatchObject({ alert: null, activity: null })
  })

  test('the Live Activity follows the sessions while the app is away, without repeating itself', async () => {
    register('phone-0001', { activity: hex(3) })
    sessions = [session('s1', 'working')]
    online.add('phone-0001')
    service.updateIslands(accountId)
    expect(sent).toHaveLength(0)

    online.clear()
    service.updateIslands(accountId)
    service.updateIslands(accountId)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'liveactivity', priority: 5, token: hex(3) })
    expect(JSON.parse(sent[0].payload).aps['content-state']).toEqual(islandState(sessions))

    // Too soon for a change that can wait, at once for one that needs the user.
    sessions = [session('s1', 'working'), session('s2', 'working')]
    service.updateIslands(accountId)
    expect(sent).toHaveLength(1)
    sessions = [session('s1', 'permission'), session('s2', 'working')]
    service.updateIslands(accountId)
    expect(sent).toHaveLength(2)
    expect(sent[1].priority).toBe(10)

    clock += ISLAND_MIN_INTERVAL_MS
    sessions = [session('s1', 'working'), session('s2', 'working')]
    service.updateIslands(accountId)
    expect(sent).toHaveLength(3)
    expect(events()).toEqual(['update', 'update', 'update'])
  })

  test('once nothing has run for a while, the relay ends the Live Activity and can start the next one', async () => {
    register('phone-0001', { activity: hex(3), activityStart: hex(4) })
    sessions = [session('s1', 'idle')]
    service.updateIslands(accountId)
    clock += ISLAND_QUIET_MS
    service.updateIslands(accountId)
    expect(events()).toEqual(['update', 'end'])
    expect(registry.pushDevices(accountId)[0]).toMatchObject({ activity: null, activityStart: hex(4) })

    sessions = [session('s1', 'working')]
    service.updateIslands(accountId)
    expect(events()).toEqual(['update', 'end', 'start'])
    expect(sent[2]).toMatchObject({ token: hex(4), priority: 10 })
  })

  test('no Live Activity is started right after the app went away: its own may be on the way', () => {
    register('phone-0001', { activityStart: hex(4) })
    sessions = [session('s1', 'working')]
    service.deviceWentAway(accountId, 'phone-0001')
    service.updateIslands(accountId)
    expect(sent).toHaveLength(0)
    // The phone reports the one it started: the relay updates it and starts nothing.
    register('phone-0001', { activityStart: hex(4), activity: hex(5) })
    clock += ISLAND_START_GRACE_MS
    service.updateIslands(accountId)
    expect(sent.map(push => push.token)).toEqual([hex(5)])
    expect(events()).toEqual(['update'])
  })

  test('a Live Activity the phone never reported is not started again for hours', () => {
    register('phone-0001', { activityStart: hex(4) })
    sessions = [session('s1', 'working')]
    service.updateIslands(accountId)
    service.updateIslands(accountId)
    clock += ISLAND_RESTART_MS - 1
    service.updateIslands(accountId)
    expect(events()).toEqual(['start'])
    clock += 1
    service.updateIslands(accountId)
    expect(events()).toEqual(['start', 'start'])
    // Once the phone reports it and it ends, the next one can start.
    register('phone-0001', { activityStart: hex(4), activity: hex(5) })
    register('phone-0001', { activityStart: hex(4) })
    service.updateIslands(accountId)
    expect(events()).toEqual(['start', 'start', 'start'])
  })

  test('nothing is pushed to an account without Live Activities', () => {
    register('phone-0001', { alert: hex(1) })
    sessions = [session('s1', 'working')]
    service.updateIslands(accountId)
    expect(sent).toHaveLength(0)
  })

  test('devices are capped per account, and a token moves with the account it signs in to', () => {
    for (let i = 0; i < MAX_PUSH_DEVICES_PER_ACCOUNT + 2; i++) {
      clock += 1
      register(`device-${String(i).padStart(4, '0')}`, { alert: hex(100 + i) })
    }
    expect(registry.pushDevices(accountId)).toHaveLength(MAX_PUSH_DEVICES_PER_ACCOUNT)
    const other = registry.createAccount().id
    service.register(other, { device: 'device-0011', environment: 'production', alert: hex(111), activity: null, activityStart: null })
    expect(registry.pushDevices(accountId).find(device => device.device === 'device-0011')?.alert).toBeNull()
    expect(registry.pushDevices(other)[0]).toMatchObject({ alert: hex(111), environment: 'production' })
    service.unregister(other, 'device-0011')
    expect(registry.pushDevices(other)).toHaveLength(0)
    registry.deleteAccount(accountId)
    expect(registry.pushDevices(accountId)).toHaveLength(0)
  })
})
