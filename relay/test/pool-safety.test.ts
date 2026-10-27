// Pool safety on a real relay (docs/pools.md, Control): who may pause, stop, propose rules and set budgets; a paused pool
// sends its sessions nothing; a stop interrupts and takes the session out; an acceptance reaches only its session's
// agent; and every one of these goes to the audit log. Blobs stay opaque: the relay never opens what is sealed.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PoolUpdate } from '../../shared/pool-protocol'
import { loadConfig } from '../src/config'
import { startRelay } from '../src/main'

const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-safety-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir, TONTON_TRUST_PROXY: '1' }))
const base = `http://127.0.0.1:${relay.server.port}`
const sockets: WebSocket[] = []

afterAll(() => {
  for (const socket of sockets) socket.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

interface Client {
  socket: WebSocket
  messages: { t: string; [field: string]: unknown }[]
  send(message: object): void
}

async function api(path: string, token: string, method = 'GET', body?: object, extra: Record<string, string> = {}) {
  const headers = { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...extra }
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, body: await response.json() }
}

async function connect(path: string, token: string): Promise<Client> {
  const socket = new WebSocket(`${base.replace('http', 'ws')}${path}`, { headers: { authorization: `Bearer ${token}` } } as never)
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

type Of<T extends PoolUpdate['t']> = Extract<PoolUpdate, { t: T }>
const all = <T extends PoolUpdate['t']>(client: Client, t: T) => client.messages.filter(m => m.t === t) as unknown as Of<T>[]
const has = (client: Client, t: string) => client.messages.some(m => m.t === t)

let addresses = 0
const fromNewAddress = () => ({ 'x-forwarded-for': `10.1.${Math.floor(++addresses / 250)}.${addresses % 250}` })

async function account() {
  const response = await fetch(`${base}/api/accounts`, { method: 'POST', headers: fromNewAddress() })
  const created = (await response.json()) as { accountId: string; token: string }
  return { id: created.accountId, token: created.token }
}

let ids = 0
const keys = (who: string) => ({ publicKey: `public-${who}`, secret: `secret-${who}` })

/** A pool with an owner, an admin and a member whose machine runs one session in the pool. */
async function setUp() {
  const owner = await account()
  const admin = await account()
  const id = `safe${String(++ids).padStart(8, '0')}`
  await api('/api/pools', owner.token, 'POST', { id, info: 'sealed-info', key: 'sealed-grant', ...keys('owner') })
  const join = async (token: string, role: 'admin' | 'member') => {
    const made = await api(`/api/pools/${id}/invites`, owner.token, 'POST', { uses: 1, hours: 1, role })
    const body = { invite: made.body.token, key: 'sealed-grant', ...keys(role) }
    return api('/api/pools/join', token, 'POST', body, fromNewAddress())
  }
  await join(admin.token, 'admin')

  // The member is an account with a machine, as an agent needs.
  const created = await (await fetch(`${base}/api/accounts`, { method: 'POST', headers: fromNewAddress() })).json()
  const { secret } = await (
    await fetch(`${base}/api/account/token`, { method: 'POST', headers: { authorization: `Bearer ${created.token}` }, body: '{}' })
  ).json()
  const machine = await (
    await fetch(`${base}/api/machines/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: created.accountId, secret, name: 'sealed-name' }),
    })
  ).json()
  const member = { id: created.accountId as string, token: created.token as string, machine: machine.token as string }
  await join(member.token, 'member')

  const agent = await connect('/ws/agent', member.machine)
  agent.send({ t: 'hello', sessionId: 'ses_safe', info: 'sealed-info', channel: true })
  const ownerApp = await connect('/ws/app', owner.token)
  const adminApp = await connect('/ws/app', admin.token)
  const memberApp = await connect('/ws/app', member.token)
  for (const app of [ownerApp, adminApp, memberApp]) app.send({ t: 'pool_subscribe', poolId: id })
  await eventually(() => has(memberApp, 'pool_snapshot'), 'the snapshot')
  memberApp.send({ t: 'pool_join_session', poolId: id, sessionId: 'ses_safe', order: 'sealed-order', profile: 'sealed-profile' })
  await eventually(() => has(agent, 'pool_join'), 'the order')
  agent.send({ t: 'pool_ack', sessionId: 'ses_safe', poolId: id })
  await eventually(() => has(agent, 'pool_snapshot'), 'the agent snapshot')
  return { id, owner, admin, member, agent, ownerApp, adminApp, memberApp }
}

describe('pool safety on the relay', () => {
  test('owners and admins pause; a paused pool holds tasks and messages back from its sessions until it resumes', async () => {
    const { id, agent, ownerApp, adminApp, memberApp } = await setUp()
    memberApp.send({ t: 'pool_pause', poolId: id, paused: true })
    await eventually(() => all(memberApp, 'pool_error').length, 'the refusal')
    expect(all(ownerApp, 'pool_info').some(m => m.paused)).toBe(false)

    adminApp.send({ t: 'pool_pause', poolId: id, paused: true })
    await eventually(() => all(agent, 'pool_info').some(m => m.paused), 'the pause at the agent')
    ownerApp.send({ t: 'pool_task', poolId: id, id: 'heldtask01', rev: 0, blob: 'sealed-task' })
    ownerApp.send({ t: 'pool_message', poolId: id, id: 'heldmsg001', blob: 'sealed-message' })
    await eventually(() => all(memberApp, 'pool_message').length, 'the message at the apps')
    await Bun.sleep(100)
    expect(has(agent, 'pool_task') || has(agent, 'pool_message')).toBe(false)
    // The session cannot change the pool either; it still says what it spends.
    agent.send({ t: 'pool_task', sessionId: 'ses_safe', poolId: id, id: 'agenttask1', rev: 0, blob: 'x' })
    await eventually(() => all(agent, 'pool_error').some(m => m.message === 'The pool is paused.'), 'the refusal at the agent')
    agent.send({ t: 'pool_event', sessionId: 'ses_safe', poolId: id, id: 'spend00001', blob: 'sealed-spend' })
    await eventually(() => all(ownerApp, 'pool_event').some(m => m.event.id === 'spend00001'), 'the spend')

    ownerApp.send({ t: 'pool_pause', poolId: id, paused: false })
    const snapshots = () => all(agent, 'pool_snapshot')
    await eventually(() => snapshots().length >= 2, 'the pool again at the agent')
    expect(
      snapshots()
        .at(-1)
        ?.pool.tasks.map(task => task.id),
    ).toEqual(['heldtask01'])
    expect(snapshots().at(-1)?.pool.paused).toBe(false)
    const actions = all(ownerApp, 'pool_audit').map(m => m.entry.action)
    expect(actions).toContain('paused')
    expect(actions).toContain('resumed')
  })

  test("a stop interrupts the session and takes it out; a member stops only its own, the owner anyone's or all", async () => {
    const { id, member, agent, ownerApp, adminApp, memberApp } = await setUp()
    adminApp.send({ t: 'pool_stop', poolId: id, target: { account: member.id, session: 'ses_nope' } })
    await eventually(() => all(adminApp, 'pool_error').length, 'no such session')

    ownerApp.send({ t: 'pool_stop', poolId: id, target: { account: member.id, session: 'ses_safe' } })
    await eventually(() => has(agent, 'pool_left'), 'the leave order')
    const kinds = agent.messages.map(m => m.t)
    expect(kinds.indexOf('pool_stop')).toBeGreaterThan(-1)
    expect(kinds.indexOf('pool_stop')).toBeLessThan(kinds.indexOf('pool_left'))
    await eventually(() => all(memberApp, 'pool_session_left').length, 'the session gone')
    const stopped = await eventually(() => all(ownerApp, 'pool_audit').find(m => m.entry.action === 'stopped'), 'the audit line')
    expect(stopped.entry.target).toEqual({ account: member.id, session: 'ses_safe' })

    // Stopping everything takes every session out, and only owners and admins may.
    memberApp.send({ t: 'pool_join_session', poolId: id, sessionId: 'ses_safe', order: 'sealed-order', profile: 'sealed-profile' })
    await eventually(() => agent.messages.filter(m => m.t === 'pool_join').length >= 2, 'joined again')
    memberApp.send({ t: 'pool_stop', poolId: id, target: null })
    await eventually(() => all(memberApp, 'pool_error').length, 'the refusal')
    memberApp.send({ t: 'pool_stop', poolId: id, target: { account: member.id, session: 'ses_safe' } })
    await eventually(() => agent.messages.filter(m => m.t === 'pool_stop').length >= 2, 'its own session stopped')
  })

  test('rules: owners and admins propose, the machine owner accepts for its session, only its agent gets it', async () => {
    const { id, member, agent, ownerApp, adminApp, memberApp } = await setUp()
    memberApp.send({ t: 'pool_rules', poolId: id, rev: 0, blob: 'sealed-rules' })
    await eventually(() => all(memberApp, 'pool_error').length, 'the refusal')
    adminApp.send({ t: 'pool_rules', poolId: id, rev: 0, blob: 'sealed-rules' })
    const proposed = await eventually(() => all(agent, 'pool_rules')[0], 'the proposal at the agent')
    expect(proposed.rules).toMatchObject({ rev: 1, blob: 'sealed-rules' })
    // A proposal over an older revision is refused with the current one.
    ownerApp.send({ t: 'pool_rules', poolId: id, rev: 0, blob: 'sealed-other' })
    await eventually(() => all(ownerApp, 'pool_conflict').some(m => m.kind === 'rules'), 'the conflict')

    // The pool's owner is not the machine owner: it cannot accept for the member's session.
    ownerApp.send({ t: 'pool_accept_rules', poolId: id, sessionId: 'ses_safe', rev: 1, acceptance: 'sealed-acceptance' })
    await eventually(() => all(ownerApp, 'pool_error').length, 'the refusal')
    memberApp.send({ t: 'pool_accept_rules', poolId: id, sessionId: 'ses_safe', rev: 9, acceptance: 'sealed-acceptance' })
    await eventually(() => all(memberApp, 'pool_error').some(m => m.message === 'These rules were never proposed.'), 'unknown revision')
    memberApp.send({ t: 'pool_accept_rules', poolId: id, sessionId: 'ses_safe', rev: 1, acceptance: 'sealed-acceptance' })
    const accept = await eventually(() => agent.messages.find(m => m.t === 'pool_accept'), 'the acceptance at the agent')
    expect(accept).toEqual({ t: 'pool_accept', sessionId: 'ses_safe', poolId: id, acceptance: 'sealed-acceptance' })
    await eventually(() => all(ownerApp, 'pool_session').some(m => m.session.accepted === 1), 'the revision accepted, in clear')
    expect(ownerApp.messages.some(m => JSON.stringify(m).includes('sealed-acceptance'))).toBe(false)

    // On reconnecting, the agent gets the acceptance with its order.
    agent.socket.close()
    await Bun.sleep(100)
    const machineAgain = await connect('/ws/agent', member.machine)
    machineAgain.send({ t: 'hello', sessionId: 'ses_safe', info: 'sealed-info', channel: true })
    const order = await eventually(() => machineAgain.messages.find(m => m.t === 'pool_join'), 'the order again')
    expect(order).toMatchObject({ order: 'sealed-order', acceptance: 'sealed-acceptance' })
  })

  test('budgets are set by owners and admins only, and every control action is in the audit log', async () => {
    const { id, owner, member, ownerApp, adminApp, memberApp } = await setUp()
    memberApp.send({ t: 'pool_budgets', poolId: id, rev: 0, blob: 'sealed-budgets' })
    await eventually(() => all(memberApp, 'pool_error').length, 'the refusal')
    adminApp.send({ t: 'pool_budgets', poolId: id, rev: 0, blob: 'sealed-budgets' })
    await eventually(() => all(memberApp, 'pool_budgets').length, 'the budgets')

    expect((await api(`/api/pools/${id}/members/${member.id}/role`, owner.token, 'POST', { role: 'viewer' })).status).toBe(200)
    await eventually(() => all(ownerApp, 'pool_audit').some(m => m.entry.action === 'role'), 'the role change')

    // A new subscriber gets the log in its snapshot.
    const late = await connect('/ws/app', member.token)
    late.send({ t: 'pool_subscribe', poolId: id })
    const snapshot = await eventually(() => all(late, 'pool_snapshot')[0], 'the snapshot')
    const actions = (snapshot.pool.audit ?? []).map(entry => entry.action)
    expect(actions).toEqual(expect.arrayContaining(['created', 'invite_created', 'joined', 'session_joined', 'budgets_set']))
    expect(snapshot.pool.budgets).toMatchObject({ rev: 1, blob: 'sealed-budgets' })
    const joined = snapshot.pool.audit?.find(entry => entry.action === 'joined' && entry.account === member.id)
    expect(joined).toBeDefined()
  })
})
