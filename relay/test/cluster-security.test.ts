// The cluster's rule on a real relay (docs/cluster.md, The rule): only a machine's owner drives its sessions. Alice and Bob
// share a cluster; Alice knows Bob's session and machine ids, as every member does, and tries every command the relay
// has on them, from her app and from her session's agent. Bob's machine gets none of it, and his session stays as it was.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClusterUpdate } from '../../shared/cluster-protocol'
import { loadConfig } from '../src/config'
import { startRelay } from '../src/main'

const dir = mkdtempSync(join(tmpdir(), 'tonton-cluster-security-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir, TONTON_TRUST_PROXY: '1' }))
const base = `http://127.0.0.1:${relay.server.port}`
const sockets: WebSocket[] = []

afterAll(() => {
  for (const socket of sockets) socket.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

type Message = { t: string; [key: string]: unknown }

interface Client {
  socket: WebSocket
  messages: Message[]
  send(message: object): void
}

let addresses = 0
const fromNewAddress = () => ({ 'x-forwarded-for': `10.2.${Math.floor(++addresses / 250)}.${addresses % 250}` })

async function api(path: string, token: string, method = 'GET', body?: object) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...fromNewAddress() }
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, body: await response.json() }
}

async function connect(path: string, token: string, headers: Record<string, string> = {}): Promise<Client> {
  const socket = new WebSocket(`${base.replace('http', 'ws')}${path}`, {
    headers: { authorization: `Bearer ${token}`, ...headers },
  } as never)
  sockets.push(socket)
  const client: Client = { socket, messages: [], send: message => socket.send(JSON.stringify(message)) }
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
  const created = (await (await fetch(`${base}/api/accounts`, { method: 'POST', headers: fromNewAddress() })).json()) as {
    accountId: string
    token: string
  }
  const { secret } = (await api('/api/account/token', created.token, 'POST', {})).body
  const machine = (await (
    await fetch(`${base}/api/machines/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...fromNewAddress() },
      body: JSON.stringify({ account: created.accountId, secret, name: 'sealed-name' }),
    })
  ).json()) as { token: string; machineId: string }
  return { id: created.accountId, token: created.token, machine: machine.token }
}

const ofType = (client: Client, t: string) => client.messages.filter(m => m.t === t)

describe("a cluster member cannot drive another member's sessions", () => {
  test('every command of the relay, aimed at Bob from Alice, reaches nothing of Bob', async () => {
    const alice = await account()
    const bob = await account()
    const id = 'secclus00001'
    expect((await api('/api/clusters', alice.token, 'POST', { id, info: 'i', key: 'k', publicKey: 'p', secret: 's' })).status).toBe(200)
    const invite = (await api(`/api/clusters/${id}/invites`, alice.token, 'POST', { uses: 1, hours: 1 })).body.token
    expect((await api('/api/clusters/join', bob.token, 'POST', { invite, key: 'k2', publicKey: 'p2', secret: 's2' })).status).toBe(200)

    // Bob: a session in the cluster, its agent, and his machine's background service.
    const bobAgent = await connect('/ws/agent', bob.machine)
    bobAgent.send({ t: 'hello', sessionId: 'ses_bob', info: 'sealed-info', channel: true })
    const bobService = await connect('/ws/agent', bob.machine, { 'x-tonton-role': 'service' })
    const bobApp = await connect('/ws/app', bob.token)
    await eventually(() => ofType(bobApp, 'snapshot').length > 0, "bob's snapshot")
    bobApp.send({ t: 'cluster_join_session', clusterId: id, sessionId: 'ses_bob', order: 'order-bob', profile: 'profile-bob' })
    await eventually(() => ofType(bobAgent, 'cluster_join').length > 0, "bob's order")
    bobAgent.send({ t: 'cluster_ack', sessionId: 'ses_bob', clusterId: id })

    // Alice sees Bob's session and the machine it runs on, as every member does.
    const aliceApp = await connect('/ws/app', alice.token)
    aliceApp.send({ t: 'cluster_subscribe', clusterId: id })
    const snapshot = (await eventually(() => ofType(aliceApp, 'cluster_snapshot')[0], "alice's snapshot")) as Extract<
      ClusterUpdate,
      { t: 'cluster_snapshot' }
    >
    const machineId = snapshot.cluster.sessions.find(s => s.session === 'ses_bob')?.machine
    expect(machineId).toBeString()
    const aliceAgent = await connect('/ws/agent', alice.machine)
    aliceAgent.send({ t: 'hello', sessionId: 'ses_alice', info: 'sealed-info', channel: true })
    await Bun.sleep(100)

    const before = { agent: bobAgent.messages.length, service: bobService.messages.length, app: bobApp.messages.length }
    const launchId = 'launch0001'
    const requestId = 'request0001'
    // From her app: every command there is, with Bob's ids.
    for (const message of [
      { t: 'prompt', sessionId: 'ses_bob', payload: 'sealed-prompt' },
      { t: 'verdict', sessionId: 'ses_bob', requestId: 'perm1', behavior: 'allow', rule: 'sealed-rule' },
      { t: 'dismiss', sessionId: 'ses_bob' },
      { t: 'rename', sessionId: 'ses_bob', name: 'sealed-name' },
      { t: 'start_session', machineId, launchId, order: 'sealed-start' },
      { t: 'start_answer', machineId, launchId, answer: 'sealed-answer' },
      { t: 'agent_logs', machineId, requestId, request: 'sealed-request' },
      { t: 'diagnose', machineId, requestId, request: 'sealed-request' },
      { t: 'update_agent', machineId, order: 'sealed-update' },
      { t: 'rules', machineId, rules: 'sealed-rules' },
      { t: 'share', sessionId: 'ses_bob', shareId: 'share0001', order: 'sealed-share' },
      { t: 'cluster_join_session', clusterId: id, sessionId: 'ses_bob', order: 'forged-order', profile: 'forged' },
      { t: 'cluster_leave_session', clusterId: id, sessionId: 'ses_bob' },
      { t: 'cluster_post', clusterId: id, id: 'fromapp001', blob: 'sealed' },
    ])
      aliceApp.send(message)
    // From her session's agent: the same, naming Bob's session.
    for (const message of [
      { t: 'cluster_join_session', sessionId: 'ses_bob', clusterId: id, order: 'forged-order', profile: 'forged' },
      { t: 'cluster_leave_session', sessionId: 'ses_bob', clusterId: id },
      { t: 'cluster_session_profile', sessionId: 'ses_bob', clusterId: id, profile: 'forged' },
      { t: 'cluster_post', sessionId: 'ses_bob', clusterId: id, id: 'forged0001', blob: 'sealed' },
      { t: 'cluster_ack', sessionId: 'ses_bob', clusterId: id },
    ])
      aliceAgent.send(message)
    await Bun.sleep(300)

    // Bob's agent and service got nothing; his app saw no change to his own session.
    expect(bobAgent.messages.slice(before.agent).map(m => m.t)).toEqual([])
    expect(bobService.messages.slice(before.service).map(m => m.t)).toEqual([])
    expect(bobApp.messages.slice(before.app).filter(m => m.t === 'session' || m.t === 'removed' || m.t === 'session_start')).toEqual([])
    // Bob's session is still in the cluster, with his order and his profile.
    const after = (await api('/api/clusters', bob.token)).body
    expect(after).toHaveLength(1)
    aliceApp.send({ t: 'cluster_subscribe', clusterId: id })
    const again = (await eventually(() => ofType(aliceApp, 'cluster_snapshot')[1], 'a second snapshot')) as Extract<
      ClusterUpdate,
      { t: 'cluster_snapshot' }
    >
    expect(again.cluster.sessions.find(s => s.session === 'ses_bob')).toMatchObject({ profile: 'profile-bob', ready: true })
    // And no session of Alice's took Bob's session id.
    expect(again.cluster.sessions.map(s => [s.account, s.session])).toEqual([[bob.id, 'ses_bob']])
    expect(again.cluster.posts).toEqual([])
  })

  test('a member cannot rotate the key or kick, a stale rotation is refused, and a kicked member reads and writes nothing', async () => {
    const alice = await account()
    const bob = await account()
    const carol = await account()
    const id = 'secclus00002'
    await api('/api/clusters', alice.token, 'POST', { id, info: 'i', key: 'k', publicKey: 'p', secret: 's' })
    for (const member of [bob, carol]) {
      const invite = (await api(`/api/clusters/${id}/invites`, alice.token, 'POST', { uses: 1, hours: 1 })).body.token
      await api('/api/clusters/join', member.token, 'POST', { invite, key: 'k2', publicKey: 'p2', secret: 's2' })
    }
    const wraps = [alice, bob, carol].map(member => ({ account: member.id, blob: `wrap-${member.id}` }))
    expect((await api(`/api/clusters/${id}/rotate`, bob.token, 'POST', { version: 2, wraps })).status).toBe(403)
    expect((await api(`/api/clusters/${id}/members/${carol.id}/kick`, bob.token, 'POST', { version: 2, wraps })).status).toBe(403)
    // A version that does not follow the current one is refused.
    expect((await api(`/api/clusters/${id}/rotate`, alice.token, 'POST', { version: 3, wraps })).status).toBe(409)
    expect((await api(`/api/clusters/${id}/rotate`, alice.token, 'POST', { version: 2, wraps })).status).toBe(200)
    expect((await api(`/api/clusters/${id}/rotate`, alice.token, 'POST', { version: 2, wraps })).status).toBe(409)

    // Carol is kicked: no route, no subscription and no post of hers reaches the cluster any more.
    const carolAgent = await connect('/ws/agent', carol.machine)
    carolAgent.send({ t: 'hello', sessionId: 'ses_carol', info: 'sealed-info', channel: true })
    const left = wraps.filter(wrap => wrap.account !== carol.id)
    expect((await api(`/api/clusters/${id}/members/${carol.id}/kick`, alice.token, 'POST', { version: 3, wraps: left })).status).toBe(200)
    expect((await api(`/api/clusters/${id}/members`, carol.token)).status).toBe(404)
    expect((await api(`/api/agent/clusters/${id}/members`, carol.machine)).status).toBe(404)
    const carolApp = await connect('/ws/app', carol.token)
    carolApp.send({ t: 'cluster_subscribe', clusterId: id })
    carolApp.send({ t: 'cluster_doc', clusterId: id, name: 'notes', rev: 0, blob: 'x' })
    carolAgent.send({ t: 'cluster_join_session', sessionId: 'ses_carol', clusterId: id, order: 'o', profile: 'p' })
    carolAgent.send({ t: 'cluster_post', sessionId: 'ses_carol', clusterId: id, id: 'carolpost1', blob: 'x' })
    await Bun.sleep(200)
    expect(carolApp.messages.filter(m => m.t.startsWith('cluster_'))).toEqual([])
    expect(carolAgent.messages.filter(m => m.t === 'cluster_join')).toEqual([])
    const aliceApp = await connect('/ws/app', alice.token)
    aliceApp.send({ t: 'cluster_subscribe', clusterId: id })
    const snapshot = (await eventually(() => ofType(aliceApp, 'cluster_snapshot')[0], 'the snapshot')) as Extract<
      ClusterUpdate,
      { t: 'cluster_snapshot' }
    >
    expect(snapshot.cluster.members.map(m => m.account).sort()).toEqual([alice.id, bob.id].sort())
    expect(snapshot.cluster.docs).toEqual([])
    expect(snapshot.cluster.sessions).toEqual([])
  })
})
