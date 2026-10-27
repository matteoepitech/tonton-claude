// The relay passes the app's requests to a machine (its agent log, a diagnosis) and the sealed answers back.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RelayToAgent, RelayToApp } from '../../shared/protocol'
import { loadConfig } from '../src/config'
import { MAX_AGENT_LOG_BYTES, MAX_DIAGNOSE_REQUEST_BYTES, MAX_DIAGNOSIS_BYTES, MAX_LOG_REQUEST_BYTES } from '../src/limits'
import { startRelay } from '../src/main'

const dir = mkdtempSync(join(tmpdir(), 'tonton-machine-requests-'))
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

/** Each request the app sends a machine, and the answer the machine sends back. */
const KINDS = [
  { request: 'agent_logs', answer: 'agent_logs', field: 'logs', maxRequest: MAX_LOG_REQUEST_BYTES, maxAnswer: MAX_AGENT_LOG_BYTES },
  { request: 'diagnose', answer: 'diagnosis', field: 'diagnosis', maxRequest: MAX_DIAGNOSE_REQUEST_BYTES, maxAnswer: MAX_DIAGNOSIS_BYTES },
] as const

type Answer = RelayToApp & { requestId: string }
const answers = (client: Client<RelayToApp>, kind: (typeof KINDS)[number]) => client.messages.filter(m => m.t === kind.answer) as Answer[]

describe.each(KINDS)('$request', kind => {
  test('the request reaches the machine, its sealed answer comes back to the apps of the account', async () => {
    const { machineId } = owner.machine
    app.socket.send(JSON.stringify({ t: kind.request, machineId, requestId: 'request0001', request: 'sealed-request' }))
    const request = await eventually(() => agent.messages.find(m => m.t === kind.request), 'the request')
    expect(request).toEqual({ t: kind.request, requestId: 'request0001', request: 'sealed-request' } as RelayToAgent)

    // The machine is the socket's, whatever the agent claims.
    agent.socket.send(JSON.stringify({ t: kind.answer, requestId: 'request0001', [kind.field]: 'sealed', machineId: 'machine-else' }))
    expect(await eventually(() => answers(app, kind)[0], 'the answer')).toEqual({
      t: kind.answer,
      machineId,
      requestId: 'request0001',
      [kind.field]: 'sealed',
    } as Answer)
    await Bun.sleep(100)
    expect(answers(stranger, kind)).toEqual([])
  })

  test('requests with a bad id, too large, or for a machine of another account go nowhere', async () => {
    const before = agent.messages.length
    const { machineId } = owner.machine
    const send = (client: Client<RelayToApp>, fields: object) =>
      client.socket.send(JSON.stringify({ t: kind.request, machineId, requestId: 'request0002', request: 'sealed', ...fields }))
    send(app, { requestId: 'Not An Id!' })
    send(app, { request: 'x'.repeat(kind.maxRequest + 1) })
    send(app, { request: 42 })
    send(stranger, {})
    agent.socket.send(JSON.stringify({ t: kind.answer, requestId: 'request0002', [kind.field]: 'x'.repeat(kind.maxAnswer + 1) }))
    agent.socket.send(JSON.stringify({ t: kind.answer, requestId: '../../etc', [kind.field]: 'sealed' }))
    await Bun.sleep(150)
    expect(agent.messages.length).toBe(before)
    expect(answers(app, kind).filter(m => m.requestId === 'request0002')).toEqual([])
    expect(answers(stranger, kind)).toEqual([])
  })
})

test('an offline machine gets an answer from the relay', async () => {
  agent.socket.close()
  await eventually(() => app.messages.some(m => m.t === 'machines' && m.machines.every(machine => !machine.online)), 'the machine offline')
  const { machineId } = owner.machine
  for (const kind of KINDS) {
    app.socket.send(JSON.stringify({ t: kind.request, machineId, requestId: 'request0003', request: 'sealed' }))
    expect(await eventually(() => answers(app, kind).find(m => m.requestId === 'request0003'), 'the answer')).toEqual({
      t: kind.answer,
      machineId,
      requestId: 'request0003',
      reason: 'offline',
    } as Answer)
  }
})
