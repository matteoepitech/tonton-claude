// Clusters on a real relay (docs/cluster.md): create, invite, join, kick with a new key, sessions put in by their owner,
// posts from sessions only, shared documents with revisions, and nothing that crosses accounts but sealed blobs. The
// blobs are opaque here: the relay neither opens nor checks what is sealed.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClusterUpdate } from '../../shared/cluster-protocol'
import { loadConfig } from '../src/config'
import { MAX_CLUSTER_POSTS_PER_MINUTE } from '../src/limits'
import { startRelay } from '../src/main'

const dir = mkdtempSync(join(tmpdir(), 'tonton-clusters-'))
// Behind a trusted proxy, so that each account the tests make comes from its own address: signups are rate limited.
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir, TONTON_TRUST_PROXY: '1' }))
const base = `http://127.0.0.1:${relay.server.port}`
const sockets: WebSocket[] = []

afterAll(() => {
  for (const socket of sockets) socket.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

type Message = ClusterUpdate | { t: string; [key: string]: unknown }

interface Client {
  socket: WebSocket
  messages: Message[]
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

const find = <T extends ClusterUpdate['t']>(
  client: Client,
  t: T,
  where: (m: Extract<ClusterUpdate, { t: T }>) => boolean = () => true,
): Extract<ClusterUpdate, { t: T }> | undefined =>
  client.messages.find(m => m.t === t && where(m as Extract<ClusterUpdate, { t: T }>)) as Extract<ClusterUpdate, { t: T }> | undefined

let addresses = 0
const fromNewAddress = () => ({ 'x-forwarded-for': `10.1.${Math.floor(++addresses / 250)}.${addresses % 250}` })

/** An account, and a machine of it whose agent can connect. */
async function account() {
  const created = (await (await fetch(`${base}/api/accounts`, { method: 'POST', headers: fromNewAddress() })).json()) as {
    accountId: string
    token: string
  }
  const { secret } = await (
    await fetch(`${base}/api/account/token`, { method: 'POST', headers: { authorization: `Bearer ${created.token}` }, body: '{}' })
  ).json()
  const machine = (await (
    await fetch(`${base}/api/machines/join`, {
      method: 'POST',
      // Machine joins are rate limited per address too.
      headers: { 'content-type': 'application/json', ...fromNewAddress() },
      body: JSON.stringify({ account: created.accountId, secret, name: 'sealed-name' }),
    })
  ).json()) as { token: string }
  return { id: created.accountId, token: created.token, machine: machine.token }
}

/** The agent of one session of the account's machine. */
async function agent(owner: { machine: string }, sessionId: string): Promise<Client> {
  const client = await connect('/ws/agent', owner.machine)
  client.send({ t: 'hello', sessionId, info: 'sealed-info', channel: true })
  return client
}

let ids = 0
const clusterId = () => `clus${String(++ids).padStart(8, '0')}`
/** The key pair a member publishes, sealed: opaque to the relay. */
const keys = (who: string) => ({ publicKey: `public-${who}`, secret: `secret-${who}` })

async function cluster(owner: { token: string }) {
  const id = clusterId()
  const created = await api('/api/clusters', owner.token, 'POST', {
    id,
    info: 'sealed-info',
    key: 'sealed-grant',
    profile: 'sealed-owner',
    ...keys('owner'),
  })
  expect(created.status).toBe(200)
  return id
}

async function invite(token: string, id: string) {
  return api(`/api/clusters/${id}/invites`, token, 'POST', { uses: 1, hours: 1 })
}

async function joinCluster(token: string, inviteToken: string, who = 'member') {
  return api(
    '/api/clusters/join',
    token,
    'POST',
    { invite: inviteToken, key: `sealed-grant-${who}`, profile: `sealed-${who}`, ...keys(who) },
    fromNewAddress(),
  )
}

/** A cluster with an owner and one member, each with one session in it whose agent took its order. */
async function twoMembers() {
  const alice = await account()
  const bob = await account()
  const id = await cluster(alice)
  await joinCluster(bob.token, (await invite(alice.token, id)).body.token)
  const aliceAgent = await agent(alice, 'ses_alice')
  const bobAgent = await agent(bob, 'ses_bob')
  const aliceApp = await connect('/ws/app', alice.token)
  const bobApp = await connect('/ws/app', bob.token)
  for (const [app, sessionId, who] of [
    [aliceApp, 'ses_alice', aliceAgent],
    [bobApp, 'ses_bob', bobAgent],
  ] as const) {
    app.send({ t: 'cluster_subscribe', clusterId: id })
    await eventually(() => find(app, 'cluster_snapshot'), 'the snapshot')
    app.send({ t: 'cluster_join_session', clusterId: id, sessionId, order: `order-${sessionId}`, profile: `profile-${sessionId}` })
    await eventually(() => who.messages.find(m => m.t === 'cluster_join'), 'the order')
    who.send({ t: 'cluster_ack', sessionId, clusterId: id })
    await eventually(() => who.messages.find(m => m.t === 'cluster_snapshot'), 'the agent snapshot')
  }
  return { alice, bob, id, aliceAgent, bobAgent, aliceApp, bobApp }
}

describe('clusters on the relay', () => {
  test('the owner creates a cluster, sees its sealed info and its own copy of the key; others do not see it', async () => {
    const owner = await account()
    const id = await cluster(owner)
    expect((await api('/api/clusters', owner.token)).body).toEqual([
      {
        id,
        role: 'owner',
        createdAt: expect.any(String),
        keyVersion: 1,
        info: 'sealed-info',
        key: 'sealed-grant',
        members: 1,
        secret: 'secret-owner',
        wraps: [],
      },
    ])
    expect((await api('/api/clusters', owner.token, 'POST', { id, info: 'x', key: 'y', ...keys('x') })).status).toBe(409)
    expect((await api('/api/clusters', owner.token, 'POST', { id: 'short', info: 'x', key: 'y', ...keys('x') })).status).toBe(400)
    expect((await api('/api/clusters', owner.token, 'POST', { id: clusterId(), info: 'x', key: 'y' })).status).toBe(400)
    const stranger = await account()
    expect((await api('/api/clusters', stranger.token)).body).toEqual([])
    expect((await api(`/api/clusters/${id}/members`, stranger.token)).status).toBe(404)
  })

  test('an invite lets an account in once, as a member; only the owner invites and kicks', async () => {
    const owner = await account()
    const member = await account()
    const late = await account()
    const id = await cluster(owner)
    const made = await invite(owner.token, id)
    expect(made.body.token).toStartWith('tc_')
    const joined = await joinCluster(member.token, made.body.token)
    expect(joined.body.cluster).toMatchObject({ id, role: 'member', key: 'sealed-grant-member', members: 2 })
    // Used up: the next account is refused; the member opening it again spends nothing.
    expect((await joinCluster(late.token, made.body.token, 'late')).status).toBe(401)
    expect((await joinCluster(member.token, made.body.token)).status).toBe(200)
    // A pool invite is not a cluster invite.
    expect((await joinCluster(late.token, made.body.token.replace('tc_', 'tp_'), 'late')).status).toBe(401)
    // A member neither invites nor kicks, and the owner cannot leave.
    expect((await invite(member.token, id)).status).toBe(403)
    expect((await api(`/api/clusters/${id}/members/${owner.id}/kick`, member.token, 'POST', { version: 2, wraps: [] })).status).toBe(403)
    expect((await api(`/api/clusters/${id}/leave`, owner.token, 'POST', {})).status).toBe(403)
    const members = await api(`/api/clusters/${id}/members`, member.token)
    expect(members.body.map((m: { account: string; role: string }) => [m.account, m.role])).toEqual([
      [owner.id, 'owner'],
      [member.id, 'member'],
    ])
  })

  test("a session joins through its owner's app; its agent gets the order, acknowledges, and follows the cluster", async () => {
    const { alice, bob, id, aliceAgent, bobAgent, aliceApp, bobApp } = await twoMembers()
    // Only the account's own sessions.
    aliceApp.send({ t: 'cluster_join_session', clusterId: id, sessionId: 'ses_bob', order: 'forged', profile: 'forged' })
    await eventually(() => find(aliceApp, 'cluster_error'), 'the refusal')
    expect(bobAgent.messages.filter(m => m.t === 'cluster_join')).toHaveLength(1)
    // Both sessions show to both members, ready, with the machine of their agent.
    await eventually(() => find(aliceApp, 'cluster_session', m => m.session.session === 'ses_bob' && m.session.ready), 'bob ready')
    // Bob subscribed once Alice's session was in: he sees it in his snapshot.
    const shown = find(bobApp, 'cluster_snapshot')?.cluster.sessions.find(s => s.session === 'ses_alice')
    expect(shown).toMatchObject({ ready: true })
    expect(shown).toMatchObject({ account: alice.id, online: true, profile: 'profile-ses_alice', machine: expect.any(String) })

    // A post from a session reaches the other session's agent, its own agent, and the apps, with its author attested.
    aliceAgent.send({ t: 'cluster_post', sessionId: 'ses_alice', clusterId: id, id: 'post00001', blob: 'sealed-hello' })
    const got = await eventually(() => find(bobAgent, 'cluster_post'), 'the post at bob')
    expect(got.post).toMatchObject({
      id: 'post00001',
      account: alice.id,
      session: 'ses_alice',
      blob: 'sealed-hello',
      machine: expect.any(String),
    })
    await eventually(() => find(aliceAgent, 'cluster_post'), 'the echo')
    await eventually(() => find(bobApp, 'cluster_post'), 'the post at bob app')
    // The same id twice is refused.
    aliceAgent.send({ t: 'cluster_post', sessionId: 'ses_alice', clusterId: id, id: 'post00001', blob: 'again' })
    await eventually(() => find(aliceAgent, 'cluster_error'), 'the duplicate refused')

    // Apps never post, and an agent speaks only for its own session.
    bobApp.send({ t: 'cluster_post', clusterId: id, id: 'fromapp01', blob: 'sealed' })
    aliceAgent.send({ t: 'cluster_post', sessionId: 'ses_bob', clusterId: id, id: 'forged001', blob: 'sealed' })
    await Bun.sleep(150)
    expect(find(aliceApp, 'cluster_post', m => m.post.id === 'fromapp01' || m.post.id === 'forged001')).toBeUndefined()

    // A status line from the agent reaches the members.
    bobAgent.send({ t: 'cluster_session_profile', sessionId: 'ses_bob', clusterId: id, profile: 'profile-busy' })
    await eventually(() => find(aliceApp, 'cluster_session', m => m.session.profile === 'profile-busy'), 'the new profile')

    // On reconnecting, the agent gets its order again; going offline shows.
    bobAgent.socket.close()
    await eventually(() => find(aliceApp, 'cluster_session', m => m.session.session === 'ses_bob' && !m.session.online), 'bob offline')
    const again = await agent(bob, 'ses_bob')
    await eventually(() => again.messages.find(m => m.t === 'cluster_join'), 'the order again')

    // Leaving, the agent is told and the members see it go.
    bobApp.send({ t: 'cluster_leave_session', clusterId: id, sessionId: 'ses_bob' })
    await eventually(() => again.messages.find(m => m.t === 'cluster_left'), 'the leave order')
    await eventually(() => find(aliceApp, 'cluster_session_left'), 'the session gone')
  })

  test('an agent puts its own session in, never another one', async () => {
    const owner = await account()
    const id = await cluster(owner)
    const own = await agent(owner, 'ses_self')
    const other = await agent(owner, 'ses_other')
    own.send({ t: 'cluster_join_session', sessionId: 'ses_self', clusterId: id, order: 'self-order', profile: 'self-profile' })
    await eventually(() => own.messages.find(m => m.t === 'cluster_join' && m.order === 'self-order'), 'its own order back')
    // Naming another session from this socket is dropped: once announced, a socket speaks only for its session.
    own.send({ t: 'cluster_join_session', sessionId: 'ses_other', clusterId: id, order: 'forged', profile: 'forged' })
    await Bun.sleep(150)
    expect(other.messages.find(m => m.t === 'cluster_join')).toBeUndefined()
  })

  test("a machine reads its account's clusters and their members, and changes nothing", async () => {
    const { alice, id } = await twoMembers()
    const list = await api('/api/agent/clusters', alice.machine)
    expect(list.body.map((c: { id: string; role: string }) => [c.id, c.role])).toEqual([[id, 'owner']])
    expect((await api(`/api/agent/clusters/${id}/members`, alice.machine)).body).toHaveLength(2)
    expect((await api(`/api/agent/clusters/${id}/members`, alice.machine, 'POST', {})).status).toBe(405)
    const stranger = await account()
    expect((await api(`/api/agent/clusters/${id}/members`, stranger.machine)).status).toBe(404)
    // A machine token is not an account token.
    expect((await api('/api/clusters', alice.machine)).status).toBe(401)
  })

  test('documents take a revision: a stale write gets the current one back; apps and sessions both write them', async () => {
    const { id, aliceAgent, bobApp, aliceApp } = await twoMembers()
    bobApp.send({ t: 'cluster_doc', clusterId: id, name: 'clock', rev: 0, blob: 'sealed-clock' })
    const doc = await eventually(() => find(aliceAgent, 'cluster_doc'), 'the doc at the agent')
    expect(doc.doc).toMatchObject({ name: 'clock', rev: 1, blob: 'sealed-clock', session: null })
    aliceAgent.send({ t: 'cluster_doc', sessionId: 'ses_alice', clusterId: id, name: 'clock', rev: 0, blob: 'stale' })
    const conflict = await eventually(() => find(aliceAgent, 'cluster_conflict'), 'the conflict')
    expect(conflict.current).toMatchObject({ rev: 1, blob: 'sealed-clock' })
    aliceAgent.send({ t: 'cluster_doc', sessionId: 'ses_alice', clusterId: id, name: 'clock', rev: 1, blob: 'sealed-clock-2' })
    await eventually(() => find(aliceApp, 'cluster_doc', m => m.doc.rev === 2 && m.doc.session === 'ses_alice'), 'the second revision')
    // A bad name is dropped; a new subscriber gets the documents in its snapshot.
    bobApp.send({ t: 'cluster_doc', clusterId: id, name: 'Bad Name', rev: 0, blob: 'x' })
    bobApp.send({ t: 'cluster_subscribe', clusterId: id })
    const snapshots = await eventually(
      () => bobApp.messages.filter(m => m.t === 'cluster_snapshot').length >= 2 && bobApp.messages.filter(m => m.t === 'cluster_snapshot'),
      'a new snapshot',
    )
    const last = snapshots.at(-1) as Extract<ClusterUpdate, { t: 'cluster_snapshot' }>
    expect(last.cluster.docs.map(d => [d.name, d.rev])).toEqual([['clock', 2]])
  })

  test('a member posts at most so many times a minute', async () => {
    const { id, aliceAgent } = await twoMembers()
    for (let i = 0; i <= MAX_CLUSTER_POSTS_PER_MINUTE; i++) {
      aliceAgent.send({ t: 'cluster_post', sessionId: 'ses_alice', clusterId: id, id: `flood${String(i).padStart(6, '0')}`, blob: 'x' })
    }
    await eventually(() => find(aliceAgent, 'cluster_error', m => m.message.includes('in a minute')), 'the limit')
  })

  test('a kick takes the member out with its sessions, rotates the key and revokes the invites', async () => {
    const { alice, bob, id, bobAgent, aliceApp, bobApp } = await twoMembers()
    const open = await invite(alice.token, id)
    // Wraps for the members left only, the owner among them.
    const bad = await api(`/api/clusters/${id}/members/${bob.id}/kick`, alice.token, 'POST', {
      version: 2,
      wraps: [{ account: bob.id, blob: 'w' }],
    })
    expect(bad.status).toBe(400)
    const kicked = await api(`/api/clusters/${id}/members/${bob.id}/kick`, alice.token, 'POST', {
      version: 2,
      wraps: [{ account: alice.id, blob: 'wrap-alice' }],
    })
    expect(kicked.body).toEqual({ ok: true, keyVersion: 2 })
    await eventually(() => bobAgent.messages.find(m => m.t === 'cluster_left'), 'bob agent told')
    await eventually(() => find(bobApp, 'cluster_removed'), 'bob app told')
    await eventually(() => find(aliceApp, 'cluster_member_left', m => m.account === bob.id), 'alice sees bob go')
    await eventually(() => find(aliceApp, 'cluster_key', m => m.wrap.version === 2), 'alice gets her wrap')
    await eventually(() => find(aliceApp, 'cluster_info', m => m.keyVersion === 2), 'the new version')
    expect((await joinCluster(bob.token, open.body.token, 'again')).status).toBe(401)
    expect((await api('/api/clusters', bob.token)).body).toEqual([])
    // Bob's agent can no longer post to it.
    bobAgent.send({ t: 'cluster_post', sessionId: 'ses_bob', clusterId: id, id: 'afterkick', blob: 'x' })
    await Bun.sleep(150)
    expect(find(aliceApp, 'cluster_post', m => m.post.id === 'afterkick')).toBeUndefined()
  })

  test("nothing but sealed posts crosses accounts: a member's app cannot prompt, answer or stop another member's session", async () => {
    const { id, bobAgent, aliceApp } = await twoMembers()
    const before = bobAgent.messages.length
    aliceApp.send({ t: 'prompt', sessionId: 'ses_bob', payload: 'sealed-prompt' })
    aliceApp.send({ t: 'verdict', sessionId: 'ses_bob', requestId: 'req1', behavior: 'allow' })
    aliceApp.send({ t: 'pool_stop', poolId: id, target: null })
    aliceApp.send({ t: 'cluster_leave_session', clusterId: id, sessionId: 'ses_bob' })
    await Bun.sleep(200)
    expect(bobAgent.messages.slice(before).map(m => m.t)).toEqual([])
  })

  test('the owner deletes the cluster: everyone is told and it is gone', async () => {
    const { alice, bob, id, bobAgent, bobApp } = await twoMembers()
    expect((await api(`/api/clusters/${id}`, bob.token, 'DELETE')).status).toBe(403)
    expect((await api(`/api/clusters/${id}`, alice.token, 'DELETE')).body).toEqual({ ok: true })
    await eventually(() => find(bobApp, 'cluster_removed'), 'bob app told')
    await eventually(() => bobAgent.messages.find(m => m.t === 'cluster_left'), 'bob agent told')
    expect((await api('/api/clusters', alice.token)).body).toEqual([])
  })
})
