// Clusters end to end: a real relay and the client core in the apps of three accounts. The owner makes a cluster and an
// invite link; the others join with it, put a session in, and a session's agent posts. What the cluster says is sealed
// with the cluster key all the way, through a kick and the new key it brings: the relay sees none of it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { RelayClient, type SocketLike } from '../shared/client'
import {
  type ClusterState,
  ClusterVault,
  decodeClusterNotes,
  newClusterItemId,
  openClusterSessionOrder,
  sealClusterSessionOrder,
} from '../shared/cluster'
import { ClusterApi, resolveClusterKeyring } from '../shared/cluster-api'
import { clusterInviteLink, parseClusterInvite } from '../shared/cluster-link'
import type { ClusterUpdate } from '../shared/cluster-protocol'
import { parseClusterToAgent, parseClusterUpdate } from '../shared/cluster-wire'
import { newAccountKey } from '../shared/crypto'
import { Vault } from '../shared/vault'

const dir = mkdtempSync(join(tmpdir(), 'tonton-clusters-e2e-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`
/** Written into every sealed thing: it must never be found in the relay's files. */
const MARKER = `marker-${Date.now()}-unreal-hero-rig`

interface App {
  token: string
  key: string
  account: string
  api: ClusterApi
  client: RelayClient
  updates: ClusterUpdate[]
}

const apps: App[] = []
const sockets: WebSocket[] = []

async function eventually<T>(read: () => T | undefined | false | Promise<T | undefined | false>, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function post(path: string, body: object, token?: string) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  return response.json()
}

async function app(): Promise<App> {
  const { accountId, token } = await post('/api/accounts', {})
  const key = newAccountKey()
  const opened: App = {
    token,
    key,
    account: accountId,
    updates: [],
    api: new ClusterApi({ relay: base, token }),
    client: undefined as never,
  }
  opened.client = new RelayClient({
    vault: new Vault(key),
    connect: () =>
      new WebSocket(`${base.replace('http', 'ws')}/ws/app`, {
        headers: { authorization: `Bearer ${token}` },
      } as never) as unknown as SocketLike,
    onChange: () => {},
    onClusterUpdate: update => opened.updates.push(update),
  })
  opened.client.start()
  await eventually(() => opened.client.state.connection === 'connected', 'the app connected')
  apps.push(opened)
  return opened
}

/** The agent of one session of the account: a machine joins, then its channel says hello. */
async function agentOf(owner: App, sessionId: string) {
  const { secret } = await post('/api/account/token', {}, owner.token)
  const machine = await post('/api/machines/join', { account: owner.account, secret, name: 'sealed-name' })
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/agent`, { headers: { authorization: `Bearer ${machine.token}` } } as never)
  sockets.push(socket)
  const messages: unknown[] = []
  socket.onmessage = event => messages.push(JSON.parse(String(event.data)))
  await new Promise(resolve => (socket.onopen = resolve))
  socket.send(JSON.stringify({ t: 'hello', sessionId, info: 'sealed-info', channel: true }))
  return { socket, messages, send: (message: object) => socket.send(JSON.stringify(message)) }
}

/** The state an app folds from its updates for one cluster, opened with the keys it holds. */
async function stateOf(app: App, vault: ClusterVault, clusterId: string): Promise<ClusterState | null> {
  let state: ClusterState | null = null
  for (const update of app.updates) {
    if (update.t === 'cluster_snapshot' && update.cluster.id === clusterId) state = await vault.snapshot(update.cluster)
    else if (state) state = await vault.apply(state, update)
  }
  return state
}

let alice: App
let bob: App
let carol: App

beforeAll(async () => {
  alice = await app()
  bob = await app()
  carol = await app()
})

afterAll(() => {
  for (const opened of apps) opened.client.stop()
  for (const socket of sockets) socket.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('a cluster between three accounts', () => {
  test('join by link, sealed posts and notes, a kick with a new key, and nothing readable on the relay', async () => {
    const { cluster, key } = await alice.api.create(alice.key, alice.account, { name: `Jam ${MARKER}` }, { name: `Alice ${MARKER}` })
    const made = await alice.api.createInvite(cluster.id, { uses: 2, hours: 1 })
    const link = clusterInviteLink({ relay: base, cluster: cluster.id, token: made.token, key, version: 1 })
    const invite = parseClusterInvite(link)
    expect(invite).toEqual({ relay: base, cluster: cluster.id, token: made.token, key, version: 1 })
    if (!invite) return
    await bob.api.join(bob.key, bob.account, invite, { name: `Bob ${MARKER}` })
    await carol.api.join(carol.key, carol.account, invite, { name: 'Carol' })

    // Bob puts his session in, with an order only his agent opens.
    const bobAgent = await agentOf(bob, 'ses_bob')
    const order = await sealClusterSessionOrder(bob.key, { clusterId: cluster.id, sessionId: 'ses_bob', key, version: 1 })
    const vault = new ClusterVault(key)
    for (const member of [alice, bob]) member.client.subscribeCluster(cluster.id)
    await eventually(() => bob.updates.some(u => u.t === 'cluster_snapshot'), 'bob snapshot')
    bob.client.sendCluster({
      t: 'cluster_join_session',
      clusterId: cluster.id,
      sessionId: 'ses_bob',
      order,
      profile: await vault.seal({ name: `rigging ${MARKER}`, tool: 'claude', project: 'HeroGame' }),
    })
    const joinOrder = await eventually(
      () => bobAgent.messages.map(parseClusterToAgent).find(m => m?.t === 'cluster_join'),
      'the join order at bob agent',
    )
    if (joinOrder?.t !== 'cluster_join') return
    expect(await openClusterSessionOrder(bob.key, joinOrder.order, 'ses_bob', cluster.id)).toMatchObject({ key, version: 1 })
    // Another account's key, or another session, opens nothing.
    expect(await openClusterSessionOrder(alice.key, joinOrder.order, 'ses_bob', cluster.id)).toBeNull()
    expect(await openClusterSessionOrder(bob.key, joinOrder.order, 'ses_other', cluster.id)).toBeNull()
    bobAgent.send({ t: 'cluster_ack', sessionId: 'ses_bob', clusterId: cluster.id })

    // The agent posts as its session; Alice opens it with the cluster key.
    bobAgent.send({
      t: 'cluster_post',
      sessionId: 'ses_bob',
      clusterId: cluster.id,
      id: newClusterItemId(),
      blob: await vault.seal({ kind: 'event', text: `submitted ${MARKER}`, event: { type: 'submit', ok: true, ref: '1234' } }),
    })
    const seen = await eventually(async () => {
      const state = await stateOf(alice, vault, cluster.id)
      return state?.posts.find(p => p.body?.kind === 'event') && state
    }, 'the post at alice')
    expect(seen.posts.at(-1)?.body).toEqual({
      kind: 'event',
      text: `submitted ${MARKER}`,
      event: { type: 'submit', ok: true, ref: '1234' },
    })
    expect(seen.posts.at(-1)).toMatchObject({ account: bob.account, session: 'ses_bob' })
    expect(seen.sessions.find(s => s.session === 'ses_bob')?.profile).toEqual({
      name: `rigging ${MARKER}`,
      tool: 'claude',
      project: 'HeroGame',
    })
    expect(seen.members.find(m => m.account === bob.account)?.profile).toEqual({ name: `Bob ${MARKER}` })

    // Alice writes the notes from her app; Bob reads them.
    alice.client.sendCluster({
      t: 'cluster_doc',
      clusterId: cluster.id,
      name: 'notes',
      rev: 0,
      blob: await vault.seal({ text: `Use ${MARKER}` }),
    })
    const notes = await eventually(async () => {
      const state = await stateOf(bob, vault, cluster.id)
      return state && (await vault.doc(state, 'notes', decodeClusterNotes))
    }, 'the notes at bob')
    expect(notes).toEqual({ text: `Use ${MARKER}` })

    // Alice kicks Carol: the key moves to version 2, which Bob opens from his wrap and Carol never gets.
    const rotated = await alice.api.kick(alice.key, alice.account, cluster.id, carol.account)
    expect(rotated).toMatchObject({ version: 2, skipped: [] })
    expect(await carol.api.list()).toEqual([])
    const bobSummary = (await bob.api.list()).find(c => c.id === cluster.id)
    if (!bobSummary) throw new Error('bob lost the cluster')
    const resolved = await resolveClusterKeyring(bob.key, bob.account, bobSummary, await bob.api.members(cluster.id))
    expect(resolved?.keyring.versions()).toEqual([1, 2])
    expect(resolved?.keyring.current).toBe(rotated.key)
    // What is sealed with the new key opens for Bob, and still reads what came before.
    const next = new ClusterVault(resolved?.keyring ?? key)
    const sealed = await next.seal({ text: 'after the kick' })
    expect(await next.read(sealed, decodeClusterNotes)).toEqual({ text: 'after the kick' })
    expect(await new ClusterVault(key).read(sealed, decodeClusterNotes)).toBeNull()

    // The relay's files hold none of it.
    const files = readdirSync(join(dir, 'data')).map(name => readFileSync(join(dir, 'data', name)).toString('latin1'))
    expect(files.length).toBeGreaterThan(0)
    for (const content of files) expect(content.includes(MARKER)).toBe(false)
  })

  test('the wire reader drops what has the wrong shape', () => {
    expect(parseClusterUpdate({ t: 'cluster_post', clusterId: 'x', post: { id: 1 } })).toBeNull()
    expect(
      parseClusterUpdate({
        t: 'cluster_doc',
        clusterId: 'x',
        doc: { name: 'Bad Name', rev: 1, updatedAt: '', blob: '', account: 'a', session: null },
      }),
    ).toBeNull()
    expect(parseClusterUpdate({ t: 'cluster_unknown', clusterId: 'x' })).toBeNull()
    expect(parseClusterToAgent({ t: 'cluster_join', sessionId: 's', clusterId: 'c' })).toBeNull()
  })
})
