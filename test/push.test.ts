// A real relay with a stand-in for Apple: what an iPhone registers, and what gets pushed to it when an agent asks for a
// permission. Apple must only ever see sealed blobs, ids and states.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApnsPush } from '../relay/src/apns'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { open, seal } from '../shared/crypto'
import type { IslandState, PermissionPush, PushDevice } from '../shared/protocol'

const dir = mkdtempSync(join(tmpdir(), 'tonton-push-e2e-'))
const pushes: ApnsPush[] = []
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'with') }), {
  pusher: {
    send: async push => {
      pushes.push(push)
      return { status: 200, reason: null }
    },
    close: () => {},
  },
})
const plain = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'without') }))
const base = `http://127.0.0.1:${relay.server.port}`
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
const sessionId = `session-${Date.now()}`
const device: PushDevice = {
  device: 'phone-1234',
  environment: 'sandbox',
  alert: 'ab'.repeat(32),
  activity: 'cd'.repeat(40),
  activityStart: null,
}

let account: { accountId: string; token: string }
let agent: WebSocket
const sockets: WebSocket[] = []

const api = (path: string, init: RequestInit = {}, token = account.token, origin = base) =>
  fetch(origin + path, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })

async function eventually<T>(read: () => T | undefined | false, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function connect(path: string, headers: Record<string, string>): Promise<WebSocket> {
  const socket = new WebSocket(`${base.replace('http', 'ws')}${path}`, { headers } as never)
  sockets.push(socket)
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve(socket)
    socket.onerror = () => reject(new Error(`could not open ${path}`))
  })
}

beforeAll(async () => {
  account = await (await fetch(`${base}/api/accounts`, { method: 'POST' })).json()
  const { secret } = await (await api('/api/account/token', { method: 'POST', body: '{}' })).json()
  const name = await seal(key, { name: 'SECRET-PC' })
  const join = { account: account.accountId, secret, name }
  const machine = await (await fetch(`${base}/api/machines/join`, { method: 'POST', body: JSON.stringify(join) })).json()
  agent = await connect('/ws/agent', { authorization: `Bearer ${machine.token}` })
  const info = await seal(key, { machine: 'SECRET-PC', cwd: '/home/x/SecretProject', project: 'SecretProject' })
  agent.send(JSON.stringify({ t: 'hello', sessionId, info, channel: true }))
})

afterAll(() => {
  for (const socket of sockets) socket.close()
  relay.stop()
  plain.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('iPhone pushes', () => {
  test('a relay without an APNs key says so and keeps nothing', async () => {
    const other = await (await fetch(`http://127.0.0.1:${plain.server.port}/api/accounts`, { method: 'POST' })).json()
    const origin = `http://127.0.0.1:${plain.server.port}`
    expect(await (await api('/api/push', {}, other.token, origin)).json()).toEqual({ enabled: false })
    const response = await api('/api/push/devices', { method: 'POST', body: JSON.stringify(device) }, other.token, origin)
    expect(await response.json()).toEqual({ enabled: false })
  })

  test('only an account can register a phone, with well-formed tokens', async () => {
    expect((await api('/api/push', {}, 'ta_nope')).status).toBe(401)
    for (const bad of [
      { ...device, alert: 'not hex' },
      { ...device, device: '../x' },
      { ...device, environment: 'dev' },
    ]) {
      expect((await api('/api/push/devices', { method: 'POST', body: JSON.stringify(bad) })).status).toBe(400)
    }
    expect(await (await api('/api/push')).json()).toEqual({ enabled: true })
    expect(await (await api('/api/push/devices', { method: 'POST', body: JSON.stringify(device) })).json()).toEqual({ enabled: true })
  })

  test('a permission request reaches the phone sealed, under a text that says nothing', async () => {
    const blob = await seal(key, { toolName: 'Bash', description: 'SECRET deploy', inputPreview: 'rm -rf SECRET' })
    agent.send(JSON.stringify({ t: 'permission', sessionId, request: { requestId: 'req1', ts: new Date().toISOString(), blob } }))
    const alert = await eventually(() => pushes.find(push => push.type === 'alert'), 'the alert')
    expect(alert).toMatchObject({ token: device.alert, environment: 'sandbox', collapseId: 'req1', priority: 10 })
    const payload = JSON.parse(alert.payload) as { aps: { category: string }; tonton: PermissionPush }
    expect(payload.aps.category).toBe('permission')
    expect(payload.tonton).toMatchObject({ sessionId, requestId: 'req1' })
    expect(await open(key, payload.tonton.request ?? '')).toMatchObject({ toolName: 'Bash' })
    expect(await open(key, payload.tonton.info ?? '')).toMatchObject({ project: 'SecretProject' })
  })

  test('the Live Activity is pushed while the phone is away, not while its app is open', async () => {
    const phone = await connect('/ws/app', { authorization: `Bearer ${account.token}`, 'x-tonton-device': device.device })
    const before = pushes.filter(push => push.type === 'liveactivity').length
    agent.send(JSON.stringify({ t: 'permission_closed', sessionId, requestId: 'req1' }))
    await Bun.sleep(2000)
    expect(pushes.filter(push => push.type === 'liveactivity')).toHaveLength(before)

    phone.close()
    const update = await eventually(() => pushes.filter(push => push.type === 'liveactivity')[before], 'the Live Activity')
    expect(update).toMatchObject({ token: device.activity, environment: 'sandbox' })
    const state = JSON.parse(update.payload).aps['content-state'] as IslandState
    expect(state.sessions[0]).toMatchObject({ id: sessionId, status: 'working' })
    expect(await open(key, state.sessions[0].info ?? '')).toMatchObject({ machine: 'SECRET-PC' })
  }, 10_000)

  test('Apple never sees anything readable', () => {
    const everything = pushes.map(push => push.payload).join('')
    for (const secret of ['SECRET', 'Bash', 'rm -rf', 'deploy']) expect(everything).not.toContain(secret)
  })

  test('a phone that signs out gets nothing more', async () => {
    expect((await api(`/api/push/devices/${device.device}`, { method: 'DELETE' })).status).toBe(200)
    const count = pushes.length
    const blob = await seal(key, { toolName: 'Bash', description: 'again', inputPreview: '' })
    agent.send(JSON.stringify({ t: 'permission', sessionId, request: { requestId: 'req2', ts: new Date().toISOString(), blob } }))
    await Bun.sleep(300)
    expect(pushes).toHaveLength(count)
  })
})
