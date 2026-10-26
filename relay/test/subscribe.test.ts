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
