import { expect, test } from 'bun:test'
import { newAccountKey } from '../../shared/crypto'
import { PoolVault, sealPoolSessionOrder } from '../../shared/pool'
import {
  blobVersion,
  newPoolMemberSecret,
  PoolKeyring,
  publicKeyOf,
  sealPoolMemberKey,
  sealPoolMemberSecret,
  wrapPoolKey,
} from '../../shared/pool-keys'
import type { PoolSnapshot } from '../../shared/pool-protocol'
import type { AgentMessage } from '../../shared/protocol'
import { SessionPools } from '../src/channel/pools'

const accountKey = newAccountKey()
const poolKey = newAccountKey()

/** A `SessionPools` for `ses_1`, with what it posts in order. */
function pools() {
  const sent: AgentMessage[] = []
  let outbox = Promise.resolve()
  const post = (build: () => Promise<AgentMessage | null>) => {
    outbox = outbox.then(async () => {
      const message = await build()
      if (message) sent.push(message)
    })
  }
  const changed: string[] = []
  const set = new SessionPools(
    () => 'ses_1',
    accountKey,
    post,
    poolId => changed.push(poolId),
  )
  return { set, sent, changed, flushed: () => outbox }
}

const order = (fields: { sessionId?: string; poolId?: string; key?: string } = {}, sealWith = accountKey) =>
  sealPoolSessionOrder(sealWith, { poolId: 'pool00000001', sessionId: 'ses_1', key: poolKey, version: 1, ...fields })

async function snapshot(): Promise<PoolSnapshot> {
  const vault = new PoolVault(poolKey)
  return {
    id: 'pool00000001',
    createdAt: 'x',
    paused: false,
    keyVersion: 1,
    info: await vault.seal({ name: 'Hackathon' }),
    members: [],
    sessions: [],
    tasks: [
      { id: 'task0001', rev: 1, updatedAt: 'x', account: 'a', session: null, blob: await vault.seal({ title: 'API', state: 'todo' }) },
    ],
    notes: null,
    messages: [],
    events: [],
  }
}

test("the session's own order is taken and acknowledged, then the pool opens with its key", async () => {
  const { set, sent, changed, flushed } = pools()
  set.receive('pool00000001', await order())
  await flushed()
  expect(sent).toEqual([{ t: 'pool_ack', sessionId: 'ses_1', poolId: 'pool00000001' }])
  expect(set.ids()).toEqual(['pool00000001'])

  set.apply({ t: 'pool_snapshot', pool: await snapshot() })
  await set.settled()
  expect(set.state('pool00000001')?.info).toEqual({ name: 'Hackathon' })
  expect(set.state('pool00000001')?.tasks[0].task).toEqual({ title: 'API', state: 'todo' })
  const blob = await new PoolVault(poolKey).seal({ title: 'API', state: 'done' })
  set.apply({ t: 'pool_task', poolId: 'pool00000001', task: { id: 'task0001', rev: 2, updatedAt: 'y', account: 'a', session: null, blob } })
  await set.settled()
  expect(set.state('pool00000001')?.tasks[0].task?.state).toBe('done')
  expect(changed.length).toBeGreaterThanOrEqual(3)

  // Leaving, or the pool going away, forgets it and its key.
  set.apply({ t: 'pool_removed', poolId: 'pool00000001' })
  await set.settled()
  expect(set.ids()).toEqual([])
  expect(set.vault('pool00000001')).toBeNull()
})

test('an order for another session or pool, or not sealed with the account key, is dropped without an answer', async () => {
  const { set, sent, flushed } = pools()
  set.receive('pool00000001', await order({ sessionId: 'ses_2' }))
  set.receive('pool00000001', await order({ poolId: 'pool00000002' }))
  set.receive('pool00000001', await order({}, newAccountKey()))
  await flushed()
  expect(sent).toEqual([])
  // Updates of a pool the session is not in are ignored.
  set.apply({ t: 'pool_snapshot', pool: await snapshot() })
  await set.settled()
  expect(set.state('pool00000001')).toBeNull()
})

test('a rotation reaches the session: it opens the new key from its wrap, reads what follows, and republishes', async () => {
  const { set, sent, flushed } = pools()
  const poolId = 'pool00000001'
  const v1 = new PoolKeyring(poolKey, 1)
  // The owner and this session's member, each with a key pair; the member's private key sealed with the account key.
  const ownerSecret = await newPoolMemberSecret(poolId)
  const memberSecret = await newPoolMemberSecret(poolId)
  const members = [
    {
      account: 'owner0000001',
      role: 'owner' as const,
      joinedAt: 'x',
      profile: null,
      publicKeys: [await sealPoolMemberKey(v1, poolId, 'owner0000001', ownerSecret)],
    },
    {
      account: 'member000001',
      role: 'member' as const,
      joinedAt: 'x',
      profile: null,
      publicKeys: [await sealPoolMemberKey(v1, poolId, 'member000001', memberSecret)],
    },
  ]
  const base = await snapshot()
  const own = { secret: await sealPoolMemberSecret(accountKey, memberSecret), wraps: [] }
  const session = { account: 'member000001', session: 'ses_1', joinedAt: 'x', profile: null, online: true, ready: true }
  set.receive(poolId, await order())
  await flushed()
  set.apply({ t: 'pool_snapshot', pool: { ...base, members, sessions: [session], own } })
  await set.settled()

  const v2 = newAccountKey()
  const wrap = await wrapPoolKey(ownerSecret, publicKeyOf(memberSecret), {
    poolId,
    version: 2,
    key: v2,
    from: 'owner0000001',
    to: 'member000001',
  })
  set.apply({ t: 'pool_key', poolId, wrap: { version: 2, from: 'owner0000001', blob: wrap } })
  await set.settled()
  await flushed()
  expect(set.vault(poolId)?.keyring.versions()).toEqual([1, 2])
  // Its public key, published under version 2 for the members who join later.
  const republished = sent.find(m => m.t === 'pool_member_key')
  if (republished?.t !== 'pool_member_key') throw new Error('no republished key')
  expect(blobVersion(republished.publicKey)).toBe(2)

  const keyring = new PoolKeyring(poolKey, 1)
  keyring.add(2, v2)
  const blob = await new PoolVault(keyring).seal({ title: 'After the kick', state: 'todo' })
  set.apply({ t: 'pool_task', poolId, task: { id: 'task0002', rev: 1, updatedAt: 'y', account: 'owner0000001', session: null, blob } })
  await set.settled()
  expect(set.state(poolId)?.tasks.find(t => t.id === 'task0002')?.task?.title).toBe('After the kick')

  // A wrap made by someone else than the admin it names does not open: nothing changes.
  const forged = await wrapPoolKey(memberSecret, publicKeyOf(memberSecret), {
    poolId,
    version: 3,
    key: newAccountKey(),
    from: 'owner0000001',
    to: 'member000001',
  })
  set.apply({ t: 'pool_key', poolId, wrap: { version: 3, from: 'owner0000001', blob: forged } })
  await set.settled()
  expect(set.vault(poolId)?.keyring.versions()).toEqual([1, 2])
})
