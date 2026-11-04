// The client core of clusters: invite links, the orders only a session's own agent opens, how a session takes posts,
// and what is kept of payloads another member sealed.
import { describe, expect, test } from 'bun:test'
import {
  ClusterVault,
  clusterDelivery,
  clusterKeyScope,
  clusterPostIsFor,
  decodeClusterClaims,
  decodeClusterClock,
  decodeClusterPostBody,
  decodeClusterSessionProfile,
  grantClusterKey,
  newClusterKey,
  openClusterGrant,
  openClusterSessionOrder,
  sealClusterSessionOrder,
} from '../cluster'
import { clusterInviteLink, formatClusterInvite, parseClusterInvite } from '../cluster-link'
import type { ClusterSnapshot } from '../cluster-protocol'
import { newAccountKey } from '../crypto'
import { parsePoolInvite } from '../pool-link'

const invite = {
  relay: 'https://relay.example.com',
  cluster: 'clusterid123',
  token: `tc_${'a'.repeat(12)}_${'b'.repeat(43)}`,
  key: 'k'.repeat(43),
  version: 1,
}

describe('cluster invites', () => {
  test('a link to the website carries the invite after the #, and reads back', () => {
    const link = clusterInviteLink(invite)
    expect(link).toStartWith('https://relay.example.com/#tontoncluster1.')
    expect(parseClusterInvite(link)).toEqual(invite)
    expect(parseClusterInvite(`  ${formatClusterInvite(invite)}  `)).toEqual(invite)
  })

  test('a pool invite, a bad token or a bad key is not a cluster invite', () => {
    expect(parseClusterInvite('tontonpool1.e30')).toBeNull()
    expect(parsePoolInvite(formatClusterInvite(invite))).toBeNull()
    expect(parseClusterInvite(formatClusterInvite({ ...invite, token: invite.token.replace('tc_', 'tp_') }))).toBeNull()
    expect(parseClusterInvite(formatClusterInvite({ ...invite, key: 'short' }))).toBeNull()
    expect(parseClusterInvite(formatClusterInvite({ ...invite, version: 0 }))).toBeNull()
  })
})

describe('cluster keys and orders', () => {
  test("a grant opens with the member's account key, for its cluster only", async () => {
    const account = newAccountKey()
    const key = newClusterKey()
    const grant = await grantClusterKey(account, 'clusterid123', key, 2)
    expect(await openClusterGrant(account, grant, 'clusterid123')).toEqual({ clusterId: 'clusterid123', key, version: 2 })
    expect(await openClusterGrant(account, grant, 'otherid12345')).toBeNull()
    expect(await openClusterGrant(newAccountKey(), grant, 'clusterid123')).toBeNull()
  })

  test('an order opens for its session and cluster only, with the account key that sealed it', async () => {
    const account = newAccountKey()
    const key = newClusterKey()
    const sealed = await sealClusterSessionOrder(account, { clusterId: 'c1', sessionId: 's1', key, version: 1, delivery: 'digest' })
    expect(await openClusterSessionOrder(account, sealed, 's1', 'c1')).toMatchObject({ key, version: 1, delivery: 'digest' })
    expect(await openClusterSessionOrder(account, sealed, 's2', 'c1')).toBeNull()
    expect(await openClusterSessionOrder(account, sealed, 's1', 'c2')).toBeNull()
    expect(await openClusterSessionOrder(newAccountKey(), sealed, 's1', 'c1')).toBeNull()
  })

  test("a cluster's member keys are scoped apart from any pool's", () => {
    expect(clusterKeyScope('clusterid123')).toBe('cluster:clusterid123')
    // Pool ids never have a colon: a cluster's wrap can never open as a pool's.
    expect(/^[A-Za-z0-9_-]{12}$/.test(clusterKeyScope('clusterid123'))).toBe(false)
  })

  test('a session takes posts live by default, as a digest when it skips permission prompts unless its owner chose live', () => {
    expect(clusterDelivery({}, false)).toBe('live')
    expect(clusterDelivery({}, true)).toBe('digest')
    expect(clusterDelivery({ delivery: 'live', liveWithoutPrompts: true }, true)).toBe('live')
    expect(clusterDelivery({ delivery: 'muted' }, false)).toBe('muted')
    expect(clusterDelivery({ delivery: 'muted', liveWithoutPrompts: true }, true)).toBe('muted')
  })
})

describe('what other members sealed', () => {
  test('a post keeps what has the right shape, and an unknown kind is dropped', () => {
    expect(
      decodeClusterPostBody({
        kind: 'event',
        text: 'submitted',
        to: [{ account: 'a1', session: 's1' }, { account: 'a2' }, { nope: true }],
        event: { type: 'submit', ok: true, ref: '1234', paths: ['Content/Hero.uasset', 3], count: -1 },
        extra: 'ignored',
      }),
    ).toEqual({
      kind: 'event',
      text: 'submitted',
      to: [{ account: 'a1', session: 's1' }, { account: 'a2' }],
      event: { type: 'submit', ok: true, ref: '1234', paths: ['Content/Hero.uasset'] },
    })
    expect(decodeClusterPostBody({ kind: 'order', text: 'run rm -rf' })).toBeNull()
    expect(decodeClusterPostBody({ kind: 'message' })).toBeNull()
    expect(
      decodeClusterPostBody({ kind: 'file', text: 'x', file: { id: 'f', name: 'a.png', size: 3, type: 'image/png', sha256: 'zz' } }),
    ).toEqual({
      kind: 'file',
      text: 'x',
    })
  })

  test('a post is for everyone, every session of a member, or one session', () => {
    expect(clusterPostIsFor({}, 'a1', 's1')).toBe(true)
    expect(clusterPostIsFor({ to: [{ account: 'a1' }] }, 'a1', 's9')).toBe(true)
    expect(clusterPostIsFor({ to: [{ account: 'a1', session: 's2' }] }, 'a1', 's1')).toBe(false)
    expect(clusterPostIsFor({ to: [{ account: 'a2' }] }, 'a1', 's1')).toBe(false)
  })

  test('profiles, claims and the clock drop wrong fields', () => {
    expect(decodeClusterSessionProfile({ name: 'Hero', tool: 'vim', status: 5, statusAt: 'not a date' })).toEqual({ name: 'Hero' })
    expect(
      decodeClusterClaims({
        claims: [
          { id: 'c1', paths: ['Content/Maps/Main.umap'], account: 'a', session: 's', at: '2026-11-04T10:00:00Z' },
          { id: 'c2', paths: [], account: 'a', session: 's', at: '2026-11-04T10:00:00Z' },
          { id: 'c3', paths: ['x'], account: 'a', session: 's' },
        ],
      }),
    ).toEqual({ claims: [{ id: 'c1', paths: ['Content/Maps/Main.umap'], account: 'a', session: 's', at: '2026-11-04T10:00:00Z' }] })
    expect(
      decodeClusterClock({
        deadline: '2026-11-08T18:00:00Z',
        milestones: [{ name: 'Art lock', at: '2026-11-07T12:00:00Z' }, { name: 'x' }],
      }),
    ).toEqual({ deadline: '2026-11-08T18:00:00Z', milestones: [{ name: 'Art lock', at: '2026-11-07T12:00:00Z' }] })
  })
})

describe('the cluster state', () => {
  const author = { account: 'bob', session: 'ses_bob' }

  async function start() {
    const vault = new ClusterVault(newClusterKey())
    const snapshot: ClusterSnapshot = {
      id: 'c1',
      createdAt: '2026-11-04T10:00:00Z',
      keyVersion: 1,
      info: await vault.seal({ name: 'Jam' }),
      members: [{ account: 'bob', role: 'member', joinedAt: 'x', profile: await vault.seal({ name: 'Bob' }), publicKeys: [] }],
      sessions: [{ account: 'bob', session: 'ses_bob', joinedAt: 'x', profile: null, online: true, ready: true, status: 'working' }],
      posts: [],
      docs: [],
    }
    return { vault, state: await vault.snapshot(snapshot) }
  }

  test('posts are opened, kept once, and a member who leaves takes its sessions', async () => {
    const { vault, state } = await start()
    expect(state.info).toEqual({ name: 'Jam' })
    const post = { id: 'p1', seq: 1, ts: 'x', ...author, blob: await vault.seal({ kind: 'message', text: 'hi' }) }
    const once = await vault.apply(state, { t: 'cluster_post', clusterId: 'c1', post })
    const twice = once && (await vault.apply(once, { t: 'cluster_post', clusterId: 'c1', post }))
    expect(twice?.posts.map(p => p.body)).toEqual([{ kind: 'message', text: 'hi' }])
    // A post sealed with another key reads as nothing, rather than breaking the state.
    const foreign = { ...post, id: 'p2', blob: await new ClusterVault(newClusterKey()).seal({ kind: 'message', text: 'x' }) }
    const after = twice && (await vault.apply(twice, { t: 'cluster_post', clusterId: 'c1', post: foreign }))
    expect(after?.posts.at(-1)?.body).toBeNull()
    const left = after && (await vault.apply(after, { t: 'cluster_member_left', clusterId: 'c1', account: 'bob' }))
    expect(left?.members).toEqual([])
    expect(left?.sessions).toEqual([])
    expect(left && (await vault.apply(left, { t: 'cluster_removed', clusterId: 'c1' }))).toBeNull()
  })

  test('a document replaces the one of its name, and updates for another cluster change nothing', async () => {
    const { vault, state } = await start()
    const doc = { name: 'notes', rev: 1, updatedAt: 'x', ...author, blob: await vault.seal({ text: 'v1' }) }
    const first = await vault.apply(state, { t: 'cluster_doc', clusterId: 'c1', doc })
    const second =
      first &&
      (await vault.apply(first, { t: 'cluster_doc', clusterId: 'c1', doc: { ...doc, rev: 2, blob: await vault.seal({ text: 'v2' }) } }))
    expect(second?.docs.map(d => d.rev)).toEqual([2])
    expect(second && (await vault.doc(second, 'notes', v => v as { text: string }))).toEqual({ text: 'v2' })
    expect(second && (await vault.apply(second, { t: 'cluster_member_left', clusterId: 'other', account: 'bob' }))).toBe(second)
  })
})
