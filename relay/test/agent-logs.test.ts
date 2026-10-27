// The relay passes a request for an agent log from the app to the machine, and the sealed log back.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RelayToAgent, RelayToApp } from '../../shared/protocol'
import { loadConfig } from '../src/config'
import { MAX_AGENT_LOG_BYTES, MAX_LOG_REQUEST_BYTES } from '../src/limits'
import { startRelay } from '../src/main'

const dir = mkdtempSync(join(tmpdir(), 'tonton-agent-logs-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir }))
const base = `http://127.0.0.1:${relay.server.port}`
const sockets: WebSocket[] = []

interface Client<T> {
  socket: WebSocket
  messages: T[]
}

async function post(path: string, body: object, token?: string) {
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
  return (await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })).json()
}

async function connect<T>(path: string, token: string): Promise<Client<T>> {
  const socket = new WebSocket(`${base.replace('http', 'ws')}${path}`, { headers: { authorization: `Bearer ${token}` } } as never)
  sockets.push(socket)
  const client: Client<T> = { socket, messages: [] }
  socket.onmessage = event => client.messages.push(JSON.parse(String(event.data)))
  await new Promise(resolve => (socket.onopen = resolve))
  return client
}

async function eventually<T>(read: () => T | undefined | false, label: string): Promise<T> {
  for (let i = 0; i < 80; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function account() {
  const created = await post('/api/accounts', {})
  const { secret } = await post('/api/account/token', {}, created.token)
  const machine = await post('/api/machines/join', { account: created.accountId, secret, name: 'sealed-name' })
  return { token: created.token as string, machine: machine as { machineId: string; token: string } }
}

let owner: Awaited<ReturnType<typeof account>>
let other: Awaited<ReturnType<typeof account>>
let app: Client<RelayToApp>
let stranger: Client<RelayToApp>
let agent: Client<RelayToAgent>

beforeAll(async () => {
  owner = await account()
  other = await account()
  app = await connect('/ws/app', owner.token)
  stranger = await connect('/ws/app', other.token)
  agent = await connect('/ws/agent', owner.machine.token)
})

afterAll(() => {
  for (const socket of sockets) socket.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

const logs = (client: Client<RelayToApp>) => client.messages.filter(m => m.t === 'agent_logs')

test('the request reaches the machine, its sealed log comes back to the apps of the account', async () => {
  const { machineId } = owner.machine
  app.socket.send(JSON.stringify({ t: 'agent_logs', machineId, requestId: 'request0001', request: 'sealed-request' }))
  const request = await eventually(() => agent.messages.find(m => m.t === 'agent_logs'), 'the request')
  expect(request).toEqual({ t: 'agent_logs', requestId: 'request0001', request: 'sealed-request' })

  // The machine is the socket's, whatever the agent claims.
  agent.socket.send(JSON.stringify({ t: 'agent_logs', requestId: 'request0001', logs: 'sealed-log', machineId: 'machine-else' }))
  expect(await eventually(() => logs(app)[0], 'the log')).toEqual({
    t: 'agent_logs',
    machineId,
    requestId: 'request0001',
    logs: 'sealed-log',
  })
  await Bun.sleep(100)
  expect(logs(stranger)).toEqual([])
})

test('requests with a bad id, too large, or for a machine of another account go nowhere', async () => {
  const before = agent.messages.length
  const { machineId } = owner.machine
  const send = (client: Client<RelayToApp>, fields: object) =>
    client.socket.send(JSON.stringify({ t: 'agent_logs', machineId, requestId: 'request0002', request: 'sealed', ...fields }))
  send(app, { requestId: 'Not An Id!' })
  send(app, { request: 'x'.repeat(MAX_LOG_REQUEST_BYTES + 1) })
  send(app, { request: 42 })
  send(stranger, {})
  agent.socket.send(JSON.stringify({ t: 'agent_logs', requestId: 'request0002', logs: 'x'.repeat(MAX_AGENT_LOG_BYTES + 1) }))
  agent.socket.send(JSON.stringify({ t: 'agent_logs', requestId: '../../etc', logs: 'sealed' }))
  await Bun.sleep(150)
  expect(agent.messages.length).toBe(before)
  expect(logs(app).filter(m => m.requestId === 'request0002')).toEqual([])
  expect(logs(stranger)).toEqual([])
})

test('an offline machine gets an answer from the relay', async () => {
  agent.socket.close()
  await eventually(() => app.messages.some(m => m.t === 'machines' && m.machines.every(machine => !machine.online)), 'the machine offline')
  const { machineId } = owner.machine
  app.socket.send(JSON.stringify({ t: 'agent_logs', machineId, requestId: 'request0003', request: 'sealed' }))
  expect(await eventually(() => logs(app).find(m => m.requestId === 'request0003'), 'the answer')).toEqual({
    t: 'agent_logs',
    machineId,
    requestId: 'request0003',
    reason: 'offline',
  })
})
