// The app's search visits each session's history by subscribing to one after the other, then back to the one it shows
// (app/Sources/TontonCore/HistoryCatchUp.swift): each subscription must bring that session's whole history.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RelayToApp } from '../../shared/protocol'
import { loadConfig } from '../src/config'
import { startRelay } from '../src/main'

const dir = mkdtempSync(join(tmpdir(), 'tonton-subscribe-'))
const sockets: WebSocket[] = []
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir }))
const base = `http://127.0.0.1:${relay.server.port}`

afterAll(() => {
  for (const socket of sockets) socket.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function post(path: string, body: object, token?: string) {
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
  return (await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })).json()
}

async function connect(path: string, token: string) {
  const socket = new WebSocket(`${base.replace('http', 'ws')}${path}`, { headers: { authorization: `Bearer ${token}` } } as never)
  sockets.push(socket)
  const messages: RelayToApp[] = []
  socket.onmessage = event => messages.push(JSON.parse(String(event.data)))
  await new Promise(resolve => (socket.onopen = resolve))
  return { socket, messages }
}

async function eventually<T>(read: () => T | undefined | false, label: string): Promise<T> {
  for (let i = 0; i < 80; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('subscribing to each session in turn, then back, brings each whole history', async () => {
  const account = await post('/api/accounts', {})
  const { secret } = await post('/api/account/token', {}, account.token)
  const machine = await post('/api/machines/join', { account: account.accountId, secret, name: 'sealed-name' })
  for (const session of ['s1', 's2']) {
    const agent = await connect('/ws/agent', machine.token)
    agent.socket.send(JSON.stringify({ t: 'hello', sessionId: session, info: 'sealed-info', channel: true }))
    const entries = [1, 2].map(n => ({ id: `${session}-${n}`, ts: `2026-01-01T00:00:0${n}.000Z`, blob: `sealed-${session}-${n}` }))
    agent.socket.send(JSON.stringify({ t: 'entries', sessionId: session, entries, reset: true }))
  }
  const app = await connect('/ws/app', account.token)
  await eventually(() => app.messages.find(m => m.t === 'snapshot' && m.sessions.length === 2), 'both sessions')
  const history = async (session: string) => {
    const before = app.messages.length
    app.socket.send(JSON.stringify({ t: 'subscribe', sessionId: session }))
    const found = await eventually(() => {
      const message = app.messages.slice(before).find(m => m.t === 'history' && m.sessionId === session)
      return message?.t === 'history' && message.entries.length === 2 && message
    }, `the history of ${session}`)
    return found.t === 'history' ? found.entries.map(entry => entry.id) : []
  }
  expect(await history('s1')).toEqual(['s1-1', 's1-2'])
  expect(await history('s2')).toEqual(['s2-1', 's2-2'])
  // Back to the session the app shows: all of it again.
  expect(await history('s1')).toEqual(['s1-1', 's1-2'])
})

test('with latestFirst, a long history comes in two: its end at once, then all of it', async () => {
  const account = await post('/api/accounts', {})
  const { secret } = await post('/api/account/token', {}, account.token)
  const machine = await post('/api/machines/join', { account: account.accountId, secret, name: 'sealed-name' })
  const agent = await connect('/ws/agent', machine.token)
  agent.socket.send(JSON.stringify({ t: 'hello', sessionId: 'long', info: 'sealed-info', channel: true }))
  const entries = Array.from({ length: 100 }, (_, n) => ({ id: `e${n}`, ts: '2026-01-01T00:00:00.000Z', blob: `sealed-${n}` }))
  agent.socket.send(JSON.stringify({ t: 'entries', sessionId: 'long', entries, reset: true }))
  agent.socket.send(JSON.stringify({ t: 'hello', sessionId: 'short', info: 'sealed-info', channel: true }))
  const app = await connect('/ws/app', account.token)
  await eventually(() => app.messages.find(m => m.t === 'snapshot' && m.sessions.length >= 1), 'the snapshot')

  const histories = async (sessionId: string, latestFirst?: boolean) => {
    const before = app.messages.length
    app.socket.send(JSON.stringify({ t: 'subscribe', sessionId, ...(latestFirst ? { latestFirst } : {}) }))
    await eventually(() => app.messages.slice(before).some(m => m.t === 'history' && m.sessionId === sessionId && !m.partial), 'a history')
    return app.messages.slice(before).filter(m => m.t === 'history' && m.sessionId === sessionId) as Extract<RelayToApp, { t: 'history' }>[]
  }
  const [recent, whole] = await histories('long', true)
  expect(recent.partial).toBe(true)
  expect(recent.entries.map(e => e.id)).toEqual(entries.slice(-60).map(e => e.id))
  expect(whole.partial).toBeUndefined()
  expect(whole.entries).toHaveLength(100)
  // Without the flag, as relays always did: one history.
  expect((await histories('long')).map(h => h.entries.length)).toEqual([100])
})

test('the end of a history is cut by size, and skipped when the history is short or its last entry too big', async () => {
  const { latestEntries } = await import('../src/sockets')
  const { RECENT_HISTORY_BYTES } = await import('../src/limits')
  const entry = (n: number, size: number) => ({ id: `e${n}`, ts: 't', blob: 'x'.repeat(size) })
  expect(latestEntries([entry(1, 10), entry(2, 10)])).toBeNull()
  expect(latestEntries([])).toBeNull()
  const big = [entry(1, 10), entry(2, RECENT_HISTORY_BYTES / 2), entry(3, RECENT_HISTORY_BYTES / 2 - 5), entry(4, 10)]
  expect(latestEntries(big)?.map(e => e.id)).toEqual(['e3', 'e4'])
  expect(latestEntries([entry(1, 10), entry(2, RECENT_HISTORY_BYTES + 1)])).toBeNull()
})
