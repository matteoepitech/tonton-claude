// Pools on a real relay (docs/pools.md): create, invite, join, roles, revisions, live updates, sessions and their
// agents, leave and delete. The blobs are opaque here: the relay neither opens nor checks what is sealed.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PoolUpdate } from '../../shared/pool-protocol'
import { loadConfig } from '../src/config'
import { MAX_POOL_POSTS_PER_MINUTE } from '../src/limits'
import { startRelay } from '../src/main'

const dir = mkdtempSync(join(tmpdir(), 'tonton-pools-'))
// Behind a trusted proxy, so that each account the tests make comes from its own address: signups are rate limited.
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
  messages: PoolUpdate[]
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

const find = <T extends PoolUpdate['t']>(client: Client, t: T, where: (m: Extract<PoolUpdate, { t: T }>) => boolean = () => true) =>
  client.messages.find(m => m.t === t && where(m as Extract<PoolUpdate, { t: T }>)) as Extract<PoolUpdate, { t: T }> | undefined

let addresses = 0
const fromNewAddress = () => ({ 'x-forwarded-for': `10.0.${Math.floor(++addresses / 250)}.${addresses % 250}` })

async function account() {
  const response = await fetch(`${base}/api/accounts`, { method: 'POST', headers: fromNewAddress() })
  const created = (await response.json()) as { accountId: string; token: string }
  return { id: created.accountId, token: created.token }
}

let ids = 0
const poolId = () => `pool${String(++ids).padStart(8, '0')}`

async function pool(owner: { token: string }) {
  const id = poolId()
  const created = await api('/api/pools', owner.token, 'POST', {
    id,
    info: 'sealed-info',
    key: 'sealed-grant',
    profile: 'sealed-owner',
    ...keys('owner'),
  })
  expect(created.status).toBe(200)
  return id
}

/** The key pair a member publishes, sealed: opaque to the relay. */
const keys = (who: string) => ({ publicKey: `public-${who}`, secret: `secret-${who}` })

async function invite(token: string, id: string, body: object = { uses: 1, hours: 1 }) {
  return api(`/api/pools/${id}/invites`, token, 'POST', body)
}

async function joinPool(token: string, inviteToken: string) {
  // Joins are rate limited per address, as attempts to guess an invite.
  return api(
    '/api/pools/join',
    token,
    'POST',
    { invite: inviteToken, key: 'sealed-grant-2', profile: 'sealed-member', ...keys('member') },
    fromNewAddress(),
  )
}

describe('pools on the relay', () => {
  test('the owner creates a pool and lists it with its sealed info and its own copy of the key', async () => {
    const owner = await account()
    const id = await pool(owner)
    const list = await api('/api/pools', owner.token)
    expect(list.body).toEqual([
      {
        id,
        role: 'owner',
        createdAt: expect.any(String),
        paused: false,
        keyVersion: 1,
        info: 'sealed-info',
        key: 'sealed-grant',
        members: 1,
        secret: 'secret-owner',
        wraps: [],
      },
    ])
    // An id in use, or a bad one, is refused.
    expect((await api('/api/pools', owner.token, 'POST', { id, info: 'x', key: 'y', ...keys('x') })).status).toBe(409)
    expect((await api('/api/pools', owner.token, 'POST', { id: 'short', info: 'x', key: 'y', ...keys('x') })).status).toBe(400)
    // A member publishes its key pair with the pool.
    expect((await api('/api/pools', owner.token, 'POST', { id: poolId(), info: 'x', key: 'y' })).status).toBe(400)
    // Another account does not see it.
    const stranger = await account()
    expect((await api('/api/pools', stranger.token)).body).toEqual([])
    expect((await api(`/api/pools/${id}/invites`, stranger.token)).status).toBe(404)
  })

  test('an invite lets an account join once, with the role it was made for; owners and admins make them', async () => {
    const owner = await account()
    const member = await account()
    const late = await account()
    const id = await pool(owner)
    const made = await invite(owner.token, id)
    expect(made.body.token).toStartWith('tp_')
    expect(made.body).toMatchObject({ role: 'member', usesLeft: 1 })

    const joined = await joinPool(member.token, made.body.token)
    expect(joined.body.pool).toMatchObject({ id, role: 'member', key: 'sealed-grant-2', members: 2 })
    // Used up for anyone else, but a member opening it again gets its pool back.
    expect((await joinPool(late.token, made.body.token)).status).toBe(401)
    expect((await joinPool(member.token, made.body.token)).body.pool.id).toBe(id)
    expect((await joinPool(late.token, 'tp_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).status).toBe(401)

    // A member makes no invite; only the owner invites admins.
    expect((await invite(member.token, id)).status).toBe(403)
    const admin = await account()
    const adminInvite = await invite(owner.token, id, { uses: 2, hours: 1, role: 'admin' })
    await joinPool(admin.token, adminInvite.body.token)
    expect((await invite(admin.token, id, { uses: 1, hours: 1, role: 'admin' })).status).toBe(403)
    expect((await invite(admin.token, id, { uses: 1, hours: 1, role: 'viewer' })).status).toBe(200)
    expect((await invite(owner.token, id, { uses: 1, hours: 1, role: 'owner' })).status).toBe(400)
    expect((await invite(owner.token, id, { uses: 0, hours: 1 })).status).toBe(400)
    expect((await invite(owner.token, id, { uses: 1, hours: 24 * 31 })).status).toBe(400)

    // Revoked, it opens nothing.
    const revoked = await invite(owner.token, id, { uses: 5, hours: 1 })
    const listed = await api(`/api/pools/${id}/invites`, owner.token)
    expect(listed.body.map((i: { id: string }) => i.id)).toContain(revoked.body.id)
    expect(JSON.stringify(listed.body)).not.toContain('tp_')
    expect((await api(`/api/pools/${id}/invites/${revoked.body.id}`, owner.token, 'DELETE')).status).toBe(200)
    expect((await joinPool(late.token, revoked.body.token)).status).toBe(401)
  })

  test('members get a snapshot, then each change live; a task changed over an older revision is refused', async () => {
    const owner = await account()
    const member = await account()
    const stranger = await account()
    const id = await pool(owner)
    await joinPool(member.token, (await invite(owner.token, id)).body.token)
    const ownerApp = await connect('/ws/app', owner.token)
    const memberApp = await connect('/ws/app', member.token)
    const strangerApp = await connect('/ws/app', stranger.token)
    for (const app of [ownerApp, memberApp, strangerApp]) app.send({ t: 'pool_subscribe', poolId: id })
    const snapshot = await eventually(() => find(memberApp, 'pool_snapshot'), 'the snapshot')
    expect(snapshot.pool).toMatchObject({ id, info: 'sealed-info', tasks: [], notes: null, messages: [], events: [] })
    expect(snapshot.pool.members.map(m => m.role).sort()).toEqual(['member', 'owner'])

    ownerApp.send({ t: 'pool_task', poolId: id, id: 'task0001', rev: 0, blob: 'sealed-task-v1' })
    const created = await eventually(() => find(memberApp, 'pool_task'), 'the task')
    expect(created.task).toMatchObject({ id: 'task0001', rev: 1, blob: 'sealed-task-v1', session: null })

    // Two members change it from revision 1: the second is told the current one.
    memberApp.send({ t: 'pool_task', poolId: id, id: 'task0001', rev: 1, blob: 'sealed-task-v2' })
    await eventually(() => find(ownerApp, 'pool_task', m => m.task.rev === 2), 'revision 2')
    ownerApp.send({ t: 'pool_task', poolId: id, id: 'task0001', rev: 1, blob: 'sealed-task-v2-other' })
    const conflict = await eventually(() => find(ownerApp, 'pool_conflict'), 'the conflict')
    expect(conflict).toMatchObject({ kind: 'task', id: 'task0001', current: { rev: 2, blob: 'sealed-task-v2' } })

    memberApp.send({ t: 'pool_notes', poolId: id, rev: 0, blob: 'sealed-notes' })
    memberApp.send({ t: 'pool_message', poolId: id, id: 'message01', blob: 'sealed-hello' })
    memberApp.send({ t: 'pool_event', poolId: id, id: 'event0001', blob: 'sealed-joined' })
    await eventually(() => find(ownerApp, 'pool_notes') && find(ownerApp, 'pool_message') && find(ownerApp, 'pool_event'), 'the posts')
    expect(find(ownerApp, 'pool_message')?.message).toMatchObject({ id: 'message01', seq: expect.any(Number), blob: 'sealed-hello' })

    // Someone outside the pool gets nothing and changes nothing.
    strangerApp.send({ t: 'pool_task', poolId: id, id: 'task0002', rev: 0, blob: 'evil' })
    await Bun.sleep(150)
    expect(strangerApp.messages.filter(m => m.t.startsWith('pool_'))).toEqual([])
    expect(find(ownerApp, 'pool_task', m => m.task.id === 'task0002')).toBeUndefined()

    // A new subscriber gets it all in its snapshot.
    const later = await connect('/ws/app', member.token)
    later.send({ t: 'pool_subscribe', poolId: id })
    const full = await eventually(() => find(later, 'pool_snapshot'), 'the full snapshot')
    expect(full.pool.tasks.map(t => [t.id, t.rev])).toEqual([['task0001', 2]])
    expect(full.pool.notes?.blob).toBe('sealed-notes')
    expect(full.pool.messages.map(m => m.id)).toEqual(['message01'])
  })

  test('a viewer reads but cannot write', async () => {
    const owner = await account()
    const viewer = await account()
    const id = await pool(owner)
    await joinPool(viewer.token, (await invite(owner.token, id, { uses: 1, hours: 1, role: 'viewer' })).body.token)
    const ownerApp = await connect('/ws/app', owner.token)
    const viewerApp = await connect('/ws/app', viewer.token)
    ownerApp.send({ t: 'pool_subscribe', poolId: id })
    viewerApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => find(viewerApp, 'pool_snapshot'), 'the snapshot')
    viewerApp.send({ t: 'pool_message', poolId: id, id: 'message01', blob: 'sealed' })
    viewerApp.send({ t: 'pool_info', poolId: id, info: 'sealed-new-info' })
    ownerApp.send({ t: 'pool_message', poolId: id, id: 'message02', blob: 'sealed' })
    await eventually(() => find(viewerApp, 'pool_message'), 'the owner message')
    expect(viewerApp.messages.filter(m => m.t === 'pool_message').map(m => m.t === 'pool_message' && m.message.id)).toEqual(['message02'])
    expect(find(ownerApp, 'pool_info')).toBeUndefined()
  })

  test("a member's session joins through its owner's app; its agent gets the order, acknowledges, and follows the pool", async () => {
    const owner = await account()
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
    const member = { id: created.accountId as string, token: created.token as string }
    const id = await pool(owner)
    await joinPool(member.token, (await invite(owner.token, id)).body.token)

    const agent = await connect('/ws/agent', machine.token)
    agent.send({ t: 'hello', sessionId: 'ses_pool', info: 'sealed-info', channel: true })
    const ownerApp = await connect('/ws/app', owner.token)
    const memberApp = await connect('/ws/app', member.token)
    ownerApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => find(ownerApp, 'pool_snapshot'), 'the snapshot')

    // Only the account's own sessions; and not from the pool's owner, whose session it is not.
    ownerApp.send({ t: 'pool_join_session', poolId: id, sessionId: 'ses_pool', order: 'sealed-order', profile: 'sealed-profile' })
    await eventually(() => find(ownerApp, 'pool_error'), 'the refusal')
    memberApp.send({ t: 'pool_join_session', poolId: id, sessionId: 'ses_pool', order: 'sealed-order', profile: 'sealed-profile' })
    const order = await eventually(() => agent.messages.find(m => (m as { t: string }).t === 'pool_join'), 'the order')
    expect(order as unknown).toEqual({ t: 'pool_join', sessionId: 'ses_pool', poolId: id, order: 'sealed-order' })
    await eventually(() => find(ownerApp, 'pool_session', m => m.session.online && !m.session.ready), 'the session, not ready')

    agent.send({ t: 'pool_ack', sessionId: 'ses_pool', poolId: id })
    await eventually(() => agent.messages.find(m => m.t === 'pool_snapshot'), 'the agent snapshot')
    await eventually(() => find(ownerApp, 'pool_session', m => m.session.ready), 'the session ready')

    // The agent follows the pool and posts as its session.
    ownerApp.send({ t: 'pool_task', poolId: id, id: 'task0001', rev: 0, blob: 'sealed-task' })
    await eventually(() => agent.messages.find(m => m.t === 'pool_task'), 'the task at the agent')
    agent.send({ t: 'pool_message', sessionId: 'ses_pool', poolId: id, id: 'fromagent1', blob: 'sealed-from-claude' })
    const posted = await eventually(() => find(ownerApp, 'pool_message'), 'the agent message')
    expect(posted.message).toMatchObject({ account: member.id, session: 'ses_pool', blob: 'sealed-from-claude' })
    // An agent speaks only for the session it announced, and only in pools that session is in.
    agent.send({ t: 'pool_message', sessionId: 'ses_other', poolId: id, id: 'forged001', blob: 'x' })
    await Bun.sleep(100)
    expect(find(ownerApp, 'pool_message', m => m.message.id === 'forged001')).toBeUndefined()

    // On reconnecting, the agent gets its order again; its going offline shows.
    agent.socket.close()
    await eventually(() => find(ownerApp, 'pool_session', m => !m.session.online), 'the session offline')
    const again = await connect('/ws/agent', machine.token)
    again.send({ t: 'hello', sessionId: 'ses_pool', info: 'sealed-info', channel: true })
    await eventually(() => again.messages.find(m => (m as { t: string }).t === 'pool_join'), 'the order again')

    // Leaving, the session's agent is told.
    memberApp.send({ t: 'pool_leave_session', poolId: id, sessionId: 'ses_pool' })
    await eventually(() => again.messages.find(m => (m as { t: string }).t === 'pool_left'), 'the leave order')
    await eventually(() => find(ownerApp, 'pool_session_left'), 'the session gone')
  })

  test('only owners and admins make a pool session the orchestrator; it goes when its session leaves', async () => {
    const owner = await account()
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
    const member = { id: created.accountId as string, token: created.token as string }
    const id = await pool(owner)
    await joinPool(member.token, (await invite(owner.token, id)).body.token)
    const agent = await connect('/ws/agent', machine.token)
    agent.send({ t: 'hello', sessionId: 'ses_lead', info: 'sealed-info', channel: true })
    const ownerApp = await connect('/ws/app', owner.token)
    const memberApp = await connect('/ws/app', member.token)
    ownerApp.send({ t: 'pool_subscribe', poolId: id })
    memberApp.send({ t: 'pool_subscribe', poolId: id })
    const first = await eventually(() => find(ownerApp, 'pool_snapshot'), 'the snapshot')
    expect(first.pool.orchestrator).toBeNull()
    memberApp.send({ t: 'pool_join_session', poolId: id, sessionId: 'ses_lead', order: 'sealed-order', profile: 'sealed-profile' })
    await eventually(() => find(ownerApp, 'pool_session'), 'the session')

    // Not a session of the pool; not from a member, even for its own session.
    ownerApp.send({ t: 'pool_orchestrator', poolId: id, orchestrator: { account: member.id, session: 'ses_nope' } })
    await eventually(() => find(ownerApp, 'pool_error', m => m.message.includes('orchestrator')), 'the refusal')
    memberApp.send({ t: 'pool_orchestrator', poolId: id, orchestrator: { account: member.id, session: 'ses_lead' } })
    await Bun.sleep(100)
    expect(find(memberApp, 'pool_orchestrator')).toBeUndefined()

    ownerApp.send({ t: 'pool_orchestrator', poolId: id, orchestrator: { account: member.id, session: 'ses_lead' } })
    const set = await eventually(() => find(memberApp, 'pool_orchestrator'), 'the orchestrator for the members')
    expect(set.orchestrator).toEqual({ account: member.id, session: 'ses_lead' })
    ownerApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => ownerApp.messages.filter(m => m.t === 'pool_snapshot').length === 2, 'a new snapshot')
    const again = ownerApp.messages.filter(m => m.t === 'pool_snapshot').at(-1) as Extract<PoolUpdate, { t: 'pool_snapshot' }>
    expect(again.pool.orchestrator).toEqual({ account: member.id, session: 'ses_lead' })

    // Its session leaves: the pool has no orchestrator any more.
    memberApp.send({ t: 'pool_leave_session', poolId: id, sessionId: 'ses_lead' })
    await eventually(() => find(ownerApp, 'pool_session_left'), 'the session gone')
    ownerApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => ownerApp.messages.filter(m => m.t === 'pool_snapshot').length === 3, 'a third snapshot')
    const last = ownerApp.messages.filter(m => m.t === 'pool_snapshot').at(-1) as Extract<PoolUpdate, { t: 'pool_snapshot' }>
    expect(last.pool.orchestrator).toBeNull()
    // None at all is allowed.
    ownerApp.send({ t: 'pool_orchestrator', poolId: id, orchestrator: null })
    await eventually(() => find(memberApp, 'pool_orchestrator', m => m.orchestrator === null), 'no orchestrator')
  })

  test('a member leaves; the owner deletes the pool for everyone', async () => {
    const owner = await account()
    const member = await account()
    const other = await account()
    const id = await pool(owner)
    await joinPool(member.token, (await invite(owner.token, id)).body.token)
    await joinPool(other.token, (await invite(owner.token, id)).body.token)
    const ownerApp = await connect('/ws/app', owner.token)
    const memberApp = await connect('/ws/app', member.token)
    const otherApp = await connect('/ws/app', other.token)
    for (const app of [ownerApp, memberApp, otherApp]) app.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => find(otherApp, 'pool_snapshot'), 'the snapshots')

    expect((await api(`/api/pools/${id}/leave`, owner.token, 'POST', {})).status).toBe(403)
    expect((await api(`/api/pools/${id}/leave`, member.token, 'POST', {})).status).toBe(200)
    await eventually(() => find(memberApp, 'pool_removed'), 'removed for the leaver')
    await eventually(() => find(ownerApp, 'pool_member_left', m => m.account !== undefined), 'the others told')
    expect((await api('/api/pools', member.token)).body).toEqual([])
    // Gone for it: no more updates.
    ownerApp.send({ t: 'pool_message', poolId: id, id: 'message01', blob: 'sealed' })
    await eventually(() => find(otherApp, 'pool_message'), 'the message to the others')
    expect(find(memberApp, 'pool_message')).toBeUndefined()

    expect((await api(`/api/pools/${id}`, other.token, 'DELETE')).status).toBe(403)
    expect((await api(`/api/pools/${id}`, owner.token, 'DELETE')).status).toBe(200)
    await eventually(() => find(otherApp, 'pool_removed'), 'removed for everyone')
    expect((await api('/api/pools', other.token)).body).toEqual([])
  })

  test('a member writes to a pool a bounded number of times a minute', async () => {
    const owner = await account()
    const id = await pool(owner)
    const app = await connect('/ws/app', owner.token)
    app.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => find(app, 'pool_snapshot'), 'the snapshot')
    for (let i = 0; i <= MAX_POOL_POSTS_PER_MINUTE; i++)
      app.send({ t: 'pool_event', poolId: id, id: `event${String(i).padStart(4, '0')}`, blob: 'e' })
    await eventually(() => find(app, 'pool_error'), 'the refusal')
    expect(app.messages.filter(m => m.t === 'pool_event')).toHaveLength(MAX_POOL_POSTS_PER_MINUTE)
  })

  test('deleting an account deletes the pools it owns', async () => {
    const owner = await account()
    const member = await account()
    const id = await pool(owner)
    await joinPool(member.token, (await invite(owner.token, id)).body.token)
    const memberApp = await connect('/ws/app', member.token)
    memberApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => find(memberApp, 'pool_snapshot'), 'the snapshot')
    expect((await api('/api/account', owner.token, 'DELETE')).status).toBe(200)
    await eventually(() => find(memberApp, 'pool_removed'), 'removed')
    expect((await api('/api/pools', member.token)).body).toEqual([])
  })
})

describe('roles, kick and key rotation', () => {
  /** An account that joined the pool, and its app following it. */
  async function joined(owner: { token: string }, id: string, role = 'member') {
    const who = await account()
    expect((await joinPool(who.token, (await invite(owner.token, id, { uses: 1, hours: 1, role })).body.token)).status).toBe(200)
    const app = await connect('/ws/app', who.token)
    app.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => find(app, 'pool_snapshot'), 'its snapshot')
    return { ...who, app }
  }

  test('the owner changes roles and hands the pool over; admins only change members and viewers', async () => {
    const owner = await account()
    const id = await pool(owner)
    const admin = await joined(owner, id, 'admin')
    const member = await joined(owner, id)
    const role = (who: { token: string }, target: string, value: string) =>
      api(`/api/pools/${id}/members/${target}/role`, who.token, 'POST', { role: value })

    expect((await role(admin, member.id, 'viewer')).status).toBe(200)
    await eventually(() => find(member.app, 'pool_member', m => m.member.role === 'viewer'), 'the new role')
    expect((await role(admin, member.id, 'admin')).status).toBe(403)
    expect((await role(admin, owner.id, 'member')).status).toBe(403)
    expect((await role(member, admin.id, 'viewer')).status).toBe(403)
    expect((await role(owner, admin.id, 'member')).status).toBe(200)
    expect((await role(owner, owner.id, 'member')).status).toBe(403)
    expect((await role(owner, member.id, 'owner')).status).toBe(400)
    expect((await role(owner, 'nobody000001', 'member')).status).toBe(404)

    // Handing the pool over: the new owner can delete it, the previous one stays as an admin.
    expect((await api(`/api/pools/${id}/owner`, admin.token, 'POST', { account: member.id })).status).toBe(403)
    expect((await api(`/api/pools/${id}/owner`, owner.token, 'POST', { account: member.id })).status).toBe(200)
    const members = (await api(`/api/pools/${id}/members`, member.token)).body as { account: string; role: string }[]
    expect(Object.fromEntries(members.map(m => [m.account, m.role]))).toEqual({
      [owner.id]: 'admin',
      [admin.id]: 'member',
      [member.id]: 'owner',
    })
    expect((await api(`/api/pools/${id}`, owner.token, 'DELETE')).status).toBe(403)
  })

  test('kicking rotates the key: each member left gets its own wrap, the kicked one nothing, invites are revoked', async () => {
    const owner = await account()
    const id = await pool(owner)
    const ownerApp = await connect('/ws/app', owner.token)
    ownerApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => find(ownerApp, 'pool_snapshot'), 'the snapshot')
    const bob = await joined(owner, id)
    const kicked = await joined(owner, id)
    const pending = (await invite(owner.token, id, { uses: 5, hours: 1 })).body
    const kick = (who: { token: string }, target: string, body: object) =>
      api(`/api/pools/${id}/members/${target}/kick`, who.token, 'POST', body)
    const wraps = [
      { account: owner.id, blob: 'wrap-owner' },
      { account: bob.id, blob: 'wrap-bob' },
    ]

    // A member cannot kick, nobody kicks the owner, and the wraps must go to members left, the author among them.
    expect((await kick(bob, kicked.id, { version: 2, wraps })).status).toBe(403)
    expect((await kick(bob, owner.id, { version: 2, wraps })).status).toBe(403)
    expect((await kick(owner, kicked.id, { version: 3, wraps })).status).toBe(409)
    expect((await kick(owner, kicked.id, { version: 2, wraps: [...wraps, { account: kicked.id, blob: 'x' }] })).status).toBe(400)
    expect((await kick(owner, kicked.id, { version: 2, wraps: [wraps[1]] })).status).toBe(400)
    expect((await kick(owner, kicked.id, { version: 2, wraps: [wraps[0], wraps[0]] })).status).toBe(400)

    expect((await kick(owner, kicked.id, { version: 2, wraps })).body).toEqual({ ok: true, keyVersion: 2 })
    await eventually(() => find(kicked.app, 'pool_removed'), 'the kicked member out')
    // Each member gets its own wrap, never another's.
    const bobKey = await eventually(() => find(bob.app, 'pool_key'), 'bob gets its wrap')
    expect(bobKey.wrap).toEqual({ version: 2, from: owner.id, blob: 'wrap-bob' })
    expect(bob.app.messages.some(m => m.t === 'pool_key' && m.wrap.blob === 'wrap-owner')).toBe(false)
    expect(find(kicked.app, 'pool_key')).toBeUndefined()
    await eventually(() => find(bob.app, 'pool_info', m => m.keyVersion === 2), 'the new version for everyone')
    await eventually(() => find(bob.app, 'pool_member_left', m => m.account === kicked.id), 'the others told')
    // The list and the snapshot carry each member's own wraps only.
    const listed = ((await api('/api/pools', bob.token)).body as { id: string; wraps: unknown[]; keyVersion: number }[]).find(
      p => p.id === id,
    )
    expect(listed).toMatchObject({ keyVersion: 2, wraps: [{ version: 2, from: owner.id, blob: 'wrap-bob' }] })
    const later = await connect('/ws/app', bob.token)
    later.send({ t: 'pool_subscribe', poolId: id })
    const snapshot = await eventually(() => find(later, 'pool_snapshot'), 'a fresh snapshot')
    expect(snapshot.pool.own).toEqual({ secret: 'secret-member', wraps: [{ version: 2, from: owner.id, blob: 'wrap-bob' }] })
    expect(JSON.stringify(snapshot.pool)).not.toContain('wrap-owner')

    // The kicked member is out for good: its old invite link, and every other one, is revoked.
    expect((await api('/api/pools', kicked.token)).body).toEqual([])
    expect((await joinPool(kicked.token, pending.token)).status).toBe(401)
    expect((await api(`/api/pools/${id}/invites`, owner.token)).body).toEqual([])
  })

  test('only the owner kicks admins; admins rotate; members publish their public key under each version', async () => {
    const owner = await account()
    const id = await pool(owner)
    const admin = await joined(owner, id, 'admin')
    const other = await joined(owner, id, 'admin')
    const viewer = await joined(owner, id, 'viewer')
    const everyone = [owner, admin, other, viewer].map(m => ({ account: m.id, blob: `wrap-${m.id}` }))
    expect((await api(`/api/pools/${id}/members/${other.id}/kick`, admin.token, 'POST', { version: 2, wraps: everyone })).status).toBe(403)
    expect((await api(`/api/pools/${id}/rotate`, viewer.token, 'POST', { version: 2, wraps: everyone })).status).toBe(403)
    expect((await api(`/api/pools/${id}/rotate`, admin.token, 'POST', { version: 2, wraps: everyone })).status).toBe(200)
    // Published again under version 2, kept next to version 1.
    viewer.app.send({ t: 'pool_member_key', poolId: id, publicKey: '2:public-viewer', secret: 'secret-viewer-2' })
    const updated = await eventually(
      () => find(admin.app, 'pool_member', m => m.member.account === viewer.id && m.member.publicKeys.length === 2),
      'the republished key',
    )
    expect(updated.member.publicKeys).toEqual(['public-member', '2:public-viewer'])
    const own = ((await api('/api/pools', viewer.token)).body as { id: string; secret: string }[]).find(p => p.id === id)
    expect(own?.secret).toBe('secret-viewer-2')
  })
})
