// A relay that stops and starts again on the same data still has the sessions and their sealed history.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RelayToApp, SealedEntry } from '../../shared/protocol'
import { loadConfig } from '../src/config'
import { startRelay } from '../src/main'

const dir = mkdtempSync(join(tmpdir(), 'tonton-restart-'))
const sockets: WebSocket[] = []
let relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir }))

afterAll(() => {
  for (const socket of sockets) socket.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

const base = () => `http://127.0.0.1:${relay.server.port}`

async function post(path: string, body: object, token?: string) {
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
  return (await fetch(base() + path, { method: 'POST', headers, body: JSON.stringify(body) })).json()
}

async function eventually<T>(read: () => T | undefined | false, label: string): Promise<T> {
  for (let i = 0; i < 80; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function connect(path: string, token: string): Promise<{ socket: WebSocket; messages: RelayToApp[] }> {
  const socket = new WebSocket(`${base().replace('http', 'ws')}${path}`, { headers: { authorization: `Bearer ${token}` } } as never)
  sockets.push(socket)
  const messages: RelayToApp[] = []
  socket.onmessage = event => messages.push(JSON.parse(String(event.data)))
  await new Promise(resolve => (socket.onopen = resolve))
  return { socket, messages }
}

test('sessions and their sealed history survive a restart', async () => {
  const account = await post('/api/accounts', {})
  const { secret } = await post('/api/account/token', {}, account.token)
  const machine = await post('/api/machines/join', { account: account.accountId, secret, name: 'sealed-name' })
  const entries: SealedEntry[] = [
    { id: 'e1', ts: '2026-01-01T00:00:00.000Z', blob: 'sealed-1' },
    { id: 'e2', ts: '2026-01-01T00:00:01.000Z', blob: 'sealed-2' },
  ]

  const agent = await connect('/ws/agent', machine.token)
  agent.socket.send(JSON.stringify({ t: 'hello', sessionId: 's1', info: 'sealed-info', channel: true }))
  agent.socket.send(JSON.stringify({ t: 'entries', sessionId: 's1', entries, reset: true }))
  agent.socket.send(JSON.stringify({ t: 'meta', sessionId: 's1', meta: 'sealed-meta' }))
  const before = await connect('/ws/app', account.token)
  // Meta comes after the entries on the agent's socket: once the app sees it, the relay holds everything.
  const hasMeta = (m: RelayToApp) =>
    (m.t === 'snapshot' && m.sessions.some(s => s.meta === 'sealed-meta')) || (m.t === 'session' && m.session.meta === 'sealed-meta')
  await eventually(() => before.messages.some(hasMeta), 'the session with its meta')
  before.socket.close()

  relay.stop()
  relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir }))

  const app = await connect('/ws/app', account.token)
  const snapshot = await eventually(() => app.messages.find(m => m.t === 'snapshot'), 'the snapshot')
  expect(snapshot.t === 'snapshot' && snapshot.sessions).toEqual([
    expect.objectContaining({ id: 's1', status: 'offline', agentOnline: false, info: 'sealed-info', meta: 'sealed-meta' }),
  ])
  app.socket.send(JSON.stringify({ t: 'subscribe', sessionId: 's1' }))
  const history = await eventually(() => app.messages.find(m => m.t === 'history'), 'the history')
  expect(history).toEqual({ t: 'history', sessionId: 's1', entries })

  // The agent comes back and takes its session over again.
  const back = await connect('/ws/agent', machine.token)
  back.socket.send(JSON.stringify({ t: 'hello', sessionId: 's1', info: 'sealed-info', channel: true }))
  await eventually(() => app.messages.some(m => m.t === 'session' && m.session.agentOnline), 'the agent back online')
})
