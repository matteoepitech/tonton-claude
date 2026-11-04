// The clusters as the website and the island follow them (shared/cluster-watch.ts): two accounts on a real relay make a
// cluster, invite, join, put a session in, see each other's sessions, posts and clock, and the owner kicks; then three
// share or keep their Tonton on the leaderboard. Each side reads through its own ClusterWatch, as a browser would.

import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { RelayClient } from '../shared/client'
import { ClusterVault, newClusterItemId, openClusterSessionOrder } from '../shared/cluster'
import { ClusterApi } from '../shared/cluster-api'
import { CLUSTER_LEADERBOARD, rankClusterHeroes } from '../shared/cluster-heroes'
import { CLUSTERS_UNSUPPORTED, ClusterWatch } from '../shared/cluster-watch'
import { parseClusterToAgent } from '../shared/cluster-wire'
import { newAccountKey } from '../shared/crypto'
import { newRPGState, type RPGState } from '../shared/rpg'
import { Vault } from '../shared/vault'

const dir = mkdtempSync(join(tmpdir(), 'tonton-cluster-watch-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`

interface Member {
  token: string
  key: string
  account: string
  client: RelayClient
  watch: ClusterWatch
}

const members: Member[] = []
const sockets: WebSocket[] = []

async function eventually<T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>, label: string): Promise<T> {
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

async function member(): Promise<Member> {
  const { accountId, token } = await post('/api/accounts', {})
  const key = newAccountKey()
  let watch: ClusterWatch | null = null
  const client = new RelayClient({
    vault: new Vault(key),
    connect: () =>
      new WebSocket(`${base.replace('http', 'ws')}/ws/app`, { headers: { authorization: `Bearer ${token}` } } as never) as never,
    onChange: () => {},
    onClusterUpdate: update => void watch?.handle(update),
  })
  watch = new ClusterWatch({
    api: new ClusterApi({ relay: base, token }),
    accountKey: key,
    account: accountId,
    relay: base,
    link: client,
    onChange: () => {},
  })
  client.start()
  await eventually(() => client.state.connection === 'connected', 'the app connected')
  const made = { token, key, account: accountId, client, watch }
  members.push(made)
  return made
}

/** The agent of one session of the account: a machine joins, then its channel says hello. */
async function agentOf(owner: Member, sessionId: string) {
  const { secret } = await post('/api/account/token', {}, owner.token)
  const machine = await post('/api/machines/join', { account: owner.account, secret, name: 'sealed-name' })
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/agent`, { headers: { authorization: `Bearer ${machine.token}` } } as never)
  sockets.push(socket)
  const messages: unknown[] = []
  socket.onmessage = event => messages.push(JSON.parse(String(event.data)))
  await new Promise(resolve => (socket.onopen = resolve))
  socket.send(JSON.stringify({ t: 'hello', sessionId, info: 'sealed-info', channel: true }))
  return { messages, send: (message: object) => socket.send(JSON.stringify(message)) }
}

let alice: Member
let bob: Member

beforeAll(async () => {
  alice = await member()
  bob = await member()
})

afterAll(() => {
  for (const m of members) m.client.stop()
  for (const socket of sockets) socket.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('following clusters from a browser', () => {
  test('create, invite, join, a session in with its delivery, posts, the clock and a kick', async () => {
    const id = await alice.watch.create({ name: 'Game jam' }, { name: 'Alice' })
    if (!id) throw new Error(alice.watch.problem ?? 'no cluster')
    expect(alice.watch.clusters.map(c => [c.summary.role, c.info?.name])).toEqual([['owner', 'Game jam']])
    alice.watch.open(id)
    await eventually(() => alice.watch.cluster(id)?.state, 'alice opened the cluster')

    const invite = await alice.watch.invite(id, { uses: 1, hours: 1 })
    if (!invite) throw new Error(alice.watch.problem ?? 'no invite')
    expect(invite.link.startsWith(`${base}/#tontoncluster1.`)).toBe(true)
    expect(await bob.watch.join('tontonpool1.nope')).toBeNull()
    expect(bob.watch.problem).toContain('not a cluster invite')
    expect(await bob.watch.join(invite.link, { name: 'Bob' })).toBe(id)
    expect(bob.watch.clusters[0]?.info?.name).toBe('Game jam')
    bob.watch.open(id)

    // Bob puts his session in, muted; his agent gets an order only his key opens, with that delivery.
    const agent = await agentOf(bob, 'ses_bob')
    await eventually(() => bob.watch.cluster(id)?.state, 'bob opened the cluster')
    expect(await bob.watch.putSession(id, 'ses_bob', { name: 'rigging', tool: 'opencode', project: 'Hero' }, { delivery: 'muted' })).toBe(
      true,
    )
    const order = await eventually(
      () => agent.messages.map(parseClusterToAgent).find(m => m?.t === 'cluster_join'),
      'the join order at the agent',
    )
    if (order?.t !== 'cluster_join') throw new Error('no order')
    const opened = await openClusterSessionOrder(bob.key, order.order, 'ses_bob', id)
    expect(opened).toMatchObject({ clusterId: id, sessionId: 'ses_bob', delivery: 'muted', version: 1 })
    agent.send({ t: 'cluster_ack', sessionId: 'ses_bob', clusterId: id })

    // Alice sees Bob, his session and what it posts, opened in her watch.
    const seen = await eventually(
      () => alice.watch.cluster(id)?.state?.sessions.find(s => s.session === 'ses_bob' && s.ready),
      'bob session at alice',
    )
    expect(seen.profile).toEqual({ name: 'rigging', tool: 'opencode', project: 'Hero' })
    expect(
      alice.watch
        .cluster(id)
        ?.state?.members.map(m => m.profile?.name)
        .sort(),
    ).toEqual(['Alice', 'Bob'])
    const vault = new ClusterVault(opened?.key ?? '')
    agent.send({
      t: 'cluster_post',
      sessionId: 'ses_bob',
      clusterId: id,
      id: newClusterItemId(),
      blob: await vault.seal({ kind: 'message', text: 'The rig is in Content/Hero' }),
    })
    const posted = await eventually(() => alice.watch.cluster(id)?.state?.posts.find(p => p.body?.kind === 'message'), 'the post')
    expect(posted).toMatchObject({ account: bob.account, session: 'ses_bob', body: { text: 'The rig is in Content/Hero' } })

    // The owner sets the clock; Bob reads it. A write over a stale revision is refused and says so.
    const clock = {
      startedAt: '2026-11-06T18:00:00.000Z',
      deadline: '2026-11-08T18:00:00.000Z',
      milestones: [{ name: 'Art lock', at: '2026-11-08T12:00:00.000Z' }],
    }
    expect(await alice.watch.setClock(id, clock)).toBe(true)
    expect(await eventually(() => bob.watch.cluster(id)?.clock, 'the clock at bob')).toEqual(clock)
    await eventually(() => alice.watch.cluster(id)?.clock, 'the clock at alice')
    const later = { ...clock, deadline: '2026-11-08T20:00:00.000Z' }
    expect(await alice.watch.setClock(id, later)).toBe(true)
    expect(
      await eventually(
        () => bob.watch.cluster(id)?.clock?.deadline === later.deadline && bob.watch.cluster(id)?.clock,
        'the moved deadline',
      ),
    ).toEqual(later)

    // Bob takes his session out; then Alice kicks Bob, who loses the cluster.
    expect(bob.watch.takeSessionOut(id, 'ses_bob')).toBe(true)
    await eventually(() => !alice.watch.cluster(id)?.state?.sessions.some(s => s.session === 'ses_bob'), 'the session left')
    expect(await alice.watch.kick(id, bob.account)).toEqual([])
    await eventually(() => alice.watch.cluster(id)?.state?.members.length === 1, 'bob kicked at alice')
    await bob.watch.refresh()
    expect(bob.watch.clusters).toEqual([])
    expect(bob.watch.cluster(id)).toBeNull()
  })

  test('the leaderboard: ranks move as XP comes in, a member who does not share has no numbers, the relay sees none', async () => {
    const carol = await member()
    const id = await alice.watch.create({ name: 'XP race' }, { name: 'Alice' })
    if (!id) throw new Error(alice.watch.problem ?? 'no cluster')
    alice.watch.open(id)
    await eventually(() => alice.watch.cluster(id)?.state, 'alice opened the cluster')
    const invite = await alice.watch.invite(id, { uses: 2, hours: 1 })
    if (!invite) throw new Error(alice.watch.problem ?? 'no invite')
    expect(await bob.watch.join(invite.link, { name: 'Bob' })).toBe(id)
    expect(await carol.watch.join(invite.link, { name: 'Carol' })).toBe(id)
    for (const m of [bob, carol]) m.watch.open(id)
    for (const m of [alice, bob, carol]) await eventually(() => m.watch.cluster(id)?.state?.members.length === 3, 'three members')

    // What an agent's awards leave in a hero: XP, and the gains it came from.
    const hero = (xp: number, gained: number[]): RPGState => {
      const at = new Date(Date.now() + 1000).toISOString()
      const gains = gained.map((amount, index) => ({
        id: `${xp}`.padStart(32, '0') + `${index}`.padStart(32, '0'),
        kind: 'turn' as const,
        day: at.slice(0, 10),
        xp: amount,
        sparks: 1,
        at,
      }))
      return { ...newRPGState(), xp, gains, owned: ['hat-rare'], equipped: { hat: 'hat-rare' } }
    }
    const ranks = (m: Member) => rankClusterHeroes(m.watch.cluster(id)?.leaderboard ?? null, m.watch.cluster(id)?.state?.members ?? [])

    // Alice and Bob share at once over the same revision: one write crosses the other and is made again, alone.
    expect(await Promise.all([alice.watch.shareHero(id, hero(400, [60, 40])), bob.watch.shareHero(id, hero(250, [30]))])).toEqual([
      true,
      true,
    ])
    const first = await eventually(() => {
      const board = ranks(carol)
      return board.filter(rank => rank.hero).length === 2 && board
    }, 'both entries at carol')
    expect(first.map(rank => [rank.account, rank.rank, rank.hero?.since ?? null])).toEqual([
      [alice.account, 1, 100],
      [bob.account, 2, 30],
      [carol.account, null, null],
    ])
    expect(first[0].hero?.equipped).toEqual({ hat: 'hat-rare' })
    expect(alice.watch.cluster(id)?.problem).toBeNull()
    expect(bob.watch.cluster(id)?.problem).toBeNull()
    expect(bob.watch.sharesHero(id)).toBe(true)
    expect(carol.watch.sharesHero(id)).toBe(false)

    // Bob's agent earns a long turn: he passes Alice, at Alice's too, and his level-up is on the board for the feed.
    await eventually(() => ranks(bob).some(rank => rank.account === bob.account && rank.hero), 'bob reads his own entry')
    expect(await bob.watch.shareHero(id, hero(420, [30, 65, 25, 100]))).toBe(true)
    const second = await eventually(() => {
      const board = ranks(alice)
      return board[0]?.account === bob.account && board
    }, 'bob first at alice')
    // 420 − his base of 220: 200 since the start, past Alice's 100.
    expect(second.map(rank => [rank.account, rank.rank, rank.hero?.level ?? null])).toEqual([
      [bob.account, 1, 3],
      [alice.account, 2, 3],
      [carol.account, null, null],
    ])
    expect(second[0].hero?.levelUps.map(up => up.level)).toEqual([3])

    // Alice stops sharing: she keeps her place in the list, without numbers.
    expect(await alice.watch.shareHero(id, null)).toBe(true)
    await eventually(() => ranks(bob).find(rank => rank.account === alice.account)?.rank === null, 'alice without numbers')

    // The relay holds one sealed blob: no level, no XP, no item in it.
    const db = new Database(join(dir, 'data', 'tonton.db'), { readonly: true })
    const row = db.query('SELECT blob FROM cluster_docs WHERE cluster_id = ? AND name = ?').get(id, CLUSTER_LEADERBOARD) as { blob: string }
    db.close()
    expect(typeof row.blob).toBe('string')
    for (const clear of ['since', 'level', 'hat-rare', 'heroes', bob.account]) expect(row.blob).not.toContain(clear)
    // A third account, a cluster and five rounds of sealed writes: more than the default 5 seconds in a busy full run.
  }, 30_000)

  test('a relay from before clusters says it needs updating', async () => {
    const old = new ClusterWatch({
      api: new ClusterApi({
        relay: base,
        token: alice.token,
        fetch: (async () => new Response('{"error":"not found"}', { status: 404 })) as never,
      }),
      accountKey: alice.key,
      account: alice.account,
      relay: base,
      link: alice.client,
      onChange: () => {},
    })
    await old.refresh()
    expect(old.supported).toBe(false)
    expect(old.problem).toBe(CLUSTERS_UNSUPPORTED)
  })
})
