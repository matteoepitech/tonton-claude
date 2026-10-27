import { describe, expect, test } from 'bun:test'
import { RelayClient, type SocketLike } from '../client'
import { newAccountKey, seal } from '../crypto'
import {
  decodePoolEventBody,
  decodePoolMessageBody,
  decodePoolSessionProfile,
  decodePoolTask,
  grantPoolKey,
  newPoolId,
  newPoolItemId,
  openPoolGrant,
  openPoolSessionOrder,
  PoolVault,
  poolTaskSize,
  sealPoolSessionOrder,
} from '../pool'
import { formatPoolInvite, parsePoolInvite } from '../pool-link'
import type { PoolSnapshot, PoolTaskWire, PoolUpdate } from '../pool-protocol'
import { parsePoolToAgent, parsePoolUpdate } from '../pool-wire'
import { Vault } from '../vault'

const accountKey = newAccountKey()
const poolKey = newAccountKey()

async function eventually<T>(read: () => T | undefined | null | false, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('pool keys and invites', () => {
  test('an invite goes back to what made it, from a pasted text or the address bar; anything else is no invite', () => {
    const invite = {
      relay: 'https://tonton.example.com',
      pool: newPoolId(),
      token: `tp_${'a'.repeat(12)}_${'b'.repeat(43)}`,
      key: poolKey,
      version: 2,
    }
    const text = formatPoolInvite(invite)
    expect(text).toStartWith('tontonpool1.')
    expect(parsePoolInvite(`  ${text}\n`)).toEqual(invite)
    expect(parsePoolInvite(`#${text}`)).toEqual(invite)
    expect(parsePoolInvite(formatPoolInvite({ ...invite, token: 'ta_wrong' }))).toBeNull()
    expect(parsePoolInvite(formatPoolInvite({ ...invite, key: 'short' }))).toBeNull()
    expect(parsePoolInvite(formatPoolInvite({ ...invite, relay: 'javascript:alert(1)' }))).toBeNull()
    expect(parsePoolInvite(formatPoolInvite({ ...invite, version: 0 }))).toBeNull()
    expect(parsePoolInvite('tontonshare1.abc')).toBeNull()
  })

  test("a member's copy of the key opens with its account key, for its pool only", async () => {
    const grant = await grantPoolKey(accountKey, 'pool00000001', poolKey, 1)
    expect(await openPoolGrant(accountKey, grant, 'pool00000001')).toEqual({ poolId: 'pool00000001', key: poolKey, version: 1 })
    expect(await openPoolGrant(accountKey, grant, 'pool00000002')).toBeNull()
    expect(await openPoolGrant(newAccountKey(), grant, 'pool00000001')).toBeNull()
  })

  test('a session order is taken by the session it names, for the pool it names, sealed with the account key', async () => {
    const order = await sealPoolSessionOrder(accountKey, { poolId: 'pool00000001', sessionId: 'ses_1', key: poolKey, version: 1 })
    expect(await openPoolSessionOrder(accountKey, order, 'ses_1', 'pool00000001')).toMatchObject({ key: poolKey, version: 1 })
    expect(await openPoolSessionOrder(accountKey, order, 'ses_2', 'pool00000001')).toBeNull()
    expect(await openPoolSessionOrder(accountKey, order, 'ses_1', 'pool00000002')).toBeNull()
    expect(await openPoolSessionOrder(newAccountKey(), order, 'ses_1', 'pool00000001')).toBeNull()
    expect(newPoolItemId()).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })
})

describe('what other members sealed', () => {
  test('fields of the wrong type are dropped, never trusted', () => {
    expect(decodePoolTask({ title: 'API', state: 'flying' })).toBeNull()
    expect(decodePoolTask({ title: 7, state: 'todo' })).toBeNull()
    expect(
      decodePoolTask({ title: 'API', state: 'todo', criteria: ['tests pass', 3], assignee: { account: 'a' }, goal: { x: 1 } }),
    ).toEqual({
      title: 'API',
      state: 'todo',
      criteria: ['tests pass'],
    })
    expect(decodePoolSessionProfile({ area: 'front', tool: 'vim', orchestrator: 'yes' })).toEqual({ area: 'front' })
    expect(decodePoolSessionProfile({ takes: 'simple' })).toEqual({ takes: 'simple' })
    expect(decodePoolSessionProfile({ takes: 'huge' })).toEqual({})
    expect(decodePoolMessageBody({ text: 'hi', to: { area: 'back' } })).toEqual({ text: 'hi', to: { area: 'back' } })
    expect(decodePoolMessageBody({ text: 'hi', to: { nobody: true } })).toEqual({ text: 'hi' })
  })
})

test('a session takes the kind of task its owner chose, or by its tool: simple for OpenCode, large for Claude Code', () => {
  expect(poolTaskSize(null, 'opencode')).toBe('simple')
  expect(poolTaskSize(null, 'claude')).toBe('large')
  expect(poolTaskSize({ takes: 'large' }, 'opencode')).toBe('large')
  expect(poolTaskSize({ takes: 'simple' }, 'claude')).toBe('simple')
})

describe('the pool state', () => {
  const vault = new PoolVault(poolKey)
  const author = { account: 'acct', session: null }

  async function snapshot(): Promise<PoolSnapshot> {
    return {
      id: 'pool00000001',
      createdAt: '2026-10-27T10:00:00.000Z',
      paused: false,
      keyVersion: 1,
      info: await vault.seal({ name: 'Hackathon', goal: 'Ship the app' }),
      members: [
        {
          account: 'acct',
          role: 'owner',
          joinedAt: '2026-10-27T10:00:00.000Z',
          profile: await vault.seal({ name: 'Matteo' }),
          publicKeys: [],
        },
      ],
      sessions: [],
      tasks: [{ id: 'task0001', rev: 1, updatedAt: 'x', ...author, blob: await vault.seal({ title: 'API', state: 'todo' }) }],
      notes: null,
      messages: [],
      events: [],
    }
  }

  test('a snapshot opens with the pool key, and each update folds into a new state', async () => {
    const state = await vault.snapshot(await snapshot())
    expect(state.info).toEqual({ name: 'Hackathon', goal: 'Ship the app' })
    expect(state.members[0].profile).toEqual({ name: 'Matteo' })
    expect(state.tasks[0].task).toEqual({ title: 'API', state: 'todo' })

    const moved: PoolTaskWire = {
      id: 'task0001',
      rev: 2,
      updatedAt: 'y',
      ...author,
      blob: await vault.seal({ title: 'API', state: 'in_progress' }),
    }
    const next = await vault.apply(state, { t: 'pool_task', poolId: 'pool00000001', task: moved })
    expect(next?.tasks.map(t => [t.rev, t.task?.state])).toEqual([[2, 'in_progress']])
    expect(state.tasks[0].rev).toBe(1)

    const message = {
      id: 'message01',
      seq: 1,
      ts: 'z',
      ...author,
      blob: await vault.seal({ text: 'front is yours', to: { area: 'front' } }),
    }
    const withMessage = await vault.apply(next ?? state, { t: 'pool_message', poolId: 'pool00000001', message })
    expect(withMessage?.messages[0].body).toEqual({ text: 'front is yours', to: { area: 'front' } })

    // A blob sealed with another key opens to nothing, and leaves the rest alone.
    const foreign = { ...moved, id: 'task0002', rev: 1, blob: await seal(newAccountKey(), { title: 'Evil', state: 'todo' }) }
    const withForeign = await vault.apply(state, { t: 'pool_task', poolId: 'pool00000001', task: foreign })
    expect(withForeign?.tasks.map(t => t.task?.title ?? null)).toEqual(['API', null])

    expect(await vault.apply(state, { t: 'pool_removed', poolId: 'pool00000001' })).toBeNull()
    expect(await vault.apply(state, { t: 'pool_removed', poolId: 'pool00000002' })).toBe(state)
  })

  test("the relay's messages are checked: a wrong shape is dropped", async () => {
    const good = await snapshot()
    expect(parsePoolUpdate({ t: 'pool_snapshot', pool: good })).toEqual({ t: 'pool_snapshot', pool: good })
    expect(parsePoolUpdate({ t: 'pool_snapshot', pool: { ...good, tasks: 'nope' } })).toBeNull()
    // Records with the wrong shape are left out, the rest kept.
    const mixed = parsePoolUpdate({ t: 'pool_snapshot', pool: { ...good, members: [...good.members, { account: 'x', role: 'god' }] } })
    expect(mixed?.t === 'pool_snapshot' && mixed.pool.members).toHaveLength(1)
    expect(
      parsePoolUpdate({ t: 'pool_task', poolId: 'p', task: { id: 't', rev: -1, updatedAt: 'x', account: 'a', session: null, blob: 'b' } }),
    ).toBeNull()
    expect(parsePoolUpdate({ t: 'pool_conflict', poolId: 'p', kind: 'task', current: null })).toEqual({
      t: 'pool_conflict',
      poolId: 'p',
      kind: 'task',
      current: null,
    })
    expect(parsePoolUpdate({ t: 'pool_unknown', poolId: 'p' })).toBeNull()
    expect(parsePoolToAgent({ t: 'pool_join', sessionId: 's', poolId: 'p', order: 'o' })).toEqual({
      t: 'pool_join',
      sessionId: 's',
      poolId: 'p',
      order: 'o',
    })
    expect(parsePoolToAgent({ t: 'pool_join', sessionId: 's', poolId: 'p' })).toBeNull()
  })
})

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  sent: Record<string, unknown>[] = []
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {}
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

test('the relay client hands pool messages over unopened, and subscribes again after reconnecting', async () => {
  const sockets: FakeSocket[] = []
  const updates: PoolUpdate[] = []
  const client = new RelayClient({
    vault: new Vault(accountKey),
    connect: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    onChange: () => {},
    onPoolUpdate: update => updates.push(update),
    retryMs: 5,
  })
  client.start()
  sockets[0].receive({ t: 'snapshot', sessions: [], machines: [] })
  await eventually(() => client.state.connection === 'connected', 'connected')
  client.subscribePool('pool00000001')
  expect(sockets[0].sent).toContainEqual({ t: 'pool_subscribe', poolId: 'pool00000001' })
  sockets[0].receive({ t: 'pool_removed', poolId: 'pool00000001' })
  sockets[0].receive({ t: 'pool_task', poolId: 'pool00000001', task: { bad: true } })
  await eventually(() => updates.length === 1, 'the update')
  expect(updates).toEqual([{ t: 'pool_removed', poolId: 'pool00000001' }])
  // A pool message never reaches the account's state.
  expect(client.state.sessions).toEqual([])

  sockets[0].onclose?.({ code: 1006 })
  await eventually(() => sockets.length === 2, 'the reconnection')
  sockets[1].receive({ t: 'snapshot', sessions: [], machines: [] })
  await eventually(() => sockets[1].sent.some(m => m.t === 'pool_subscribe'), 'the subscription again')
  client.stop()
})

test("the machine owner's choice to start pool tasks at once comes with the order; a session event says its tool and model", async () => {
  const accountKey = newAccountKey()
  const order = { poolId: 'pool12345678', sessionId: 'ses_1', key: newAccountKey(), version: 1 }
  expect(
    (await openPoolSessionOrder(accountKey, await sealPoolSessionOrder(accountKey, order), 'ses_1', 'pool12345678'))?.autoStart,
  ).toBeUndefined()
  const started = await openPoolSessionOrder(
    accountKey,
    await sealPoolSessionOrder(accountKey, { ...order, autoStart: true }),
    'ses_1',
    'pool12345678',
  )
  expect(started?.autoStart).toBe(true)
  expect(decodePoolEventBody({ kind: 'session', tool: 'opencode', model: 'gpt-5' })).toEqual({
    kind: 'session',
    tool: 'opencode',
    model: 'gpt-5',
  })
  // An unknown tool is dropped, the event stays.
  expect(decodePoolEventBody({ kind: 'session', tool: 'vim', model: 3 })).toEqual({ kind: 'session' })
})
