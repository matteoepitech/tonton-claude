// Pools end to end: a real relay, a real agent channel, and the client core in two apps of two accounts. The owner makes
// a pool and an invite; the other account joins with it, puts its Claude Code session in the pool, and the agent takes
// the order. What the pool says is sealed with the pool key all the way: the relay sees none of it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { RelayClient, type SocketLike } from '../shared/client'
import { newAccountKey, seal } from '../shared/crypto'
import { newPoolItemId, openPoolGrant, type PoolState, PoolVault, sealPoolSessionOrder } from '../shared/pool'
import { PoolApi } from '../shared/pool-api'
import { blobVersion, openPoolMemberKey, PoolKeyring, resolvePoolKeyring } from '../shared/pool-keys'
import { formatPoolInvite, parsePoolInvite } from '../shared/pool-link'
import type { PoolUpdate } from '../shared/pool-protocol'
import { Vault } from '../shared/vault'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const dir = mkdtempSync(join(tmpdir(), 'tonton-pools-e2e-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`
const sessionId = `session-${Date.now()}`

/** An app of one account, on the client core, keeping every pool message as it came and its raw traffic. */
interface App {
  token: string
  key: string
  client: RelayClient
  updates: PoolUpdate[]
  raw: string[]
  account: string
}

let owner: App
let member: App
let claude: Client

async function eventually<T>(read: () => T | undefined | false | Promise<T | undefined | false>, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const post = async (path: string, body: object, token?: string) =>
  (
    await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  ).json()

async function app(token: string, key: string, account: string): Promise<App> {
  const opened: App = { token, key, account, updates: [], raw: [], client: undefined as unknown as RelayClient }
  opened.client = new RelayClient({
    vault: new Vault(key),
    connect: () => {
      const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/app`, { headers: { authorization: `Bearer ${token}` } } as never)
      socket.addEventListener('message', event => opened.raw.push(String(event.data)))
      return socket as unknown as SocketLike
    },
    onChange: () => {},
    onPoolUpdate: update => opened.updates.push(update),
  })
  opened.client.start()
  await eventually(() => opened.client.state.connection === 'connected', 'the app to connect')
  return opened
}

/** The pool as this app reads it, from every message it got, opened with the pool key or a keyring. */
async function stateOf(peer: App, poolKey: string | PoolKeyring): Promise<PoolState | null> {
  const vault = new PoolVault(poolKey)
  let state: PoolState | null = null
  for (const update of peer.updates) {
    if (update.t === 'pool_snapshot') state = await vault.snapshot(update.pool)
    else if (state) state = await vault.apply(state, update)
  }
  return state
}

beforeAll(async () => {
  const ownerAccount = await post('/api/accounts', {})
  owner = await app(ownerAccount.token, newAccountKey(), ownerAccount.accountId)

  // The member has a machine with a Claude Code session.
  const memberAccount = await post('/api/accounts', {})
  const memberKey = newAccountKey()
  const { secret } = await post('/api/account/token', {}, memberAccount.token)
  const machine = await post('/api/machines/join', {
    account: memberAccount.accountId,
    secret,
    name: await seal(memberKey, { name: 'PC' }),
  })
  const home = join(dir, 'agent')
  mkdirSync(join(home, 'run'), { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: base, ...machine, key: memberKey, machine: 'PC', version: '0.3.0' }))
  const transcript = join(dir, 'transcript.jsonl')
  writeFileSync(transcript, `${JSON.stringify({ sessionId, type: 'user', uuid: 'u1', message: { content: 'hello' } })}\n`)
  writeFileSync(join(home, 'run', `${process.pid}.json`), JSON.stringify({ sessionId, transcriptPath: transcript, cwd: '/home/x/shop' }))
  const env = { ...process.env, TONTON_HOME: home, TONTON_CHANNEL: '1', TONTON_SERVICE: 'off' } as Record<string, string>
  claude = new Client({ name: 'claude-code', version: 'test' })
  await claude.connect(new StdioClientTransport({ command: 'bun', args: [AGENT, 'channel'], env }))
  member = await app(memberAccount.token, memberKey, memberAccount.accountId)
  await eventually(() => member.client.state.sessions.some(s => s.id === sessionId && s.agentOnline), 'the session online')
}, 20_000)

afterAll(async () => {
  owner?.client.stop()
  member?.client.stop()
  await claude?.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('pools end to end', () => {
  let poolId: string
  let poolKey: string

  test('the owner makes a pool and an invite; the other account joins with the link and reads the pool', async () => {
    const ownerApi = new PoolApi({ relay: base, token: owner.token })
    const created = await ownerApi.create(owner.key, owner.account, { name: 'SECRET hackathon', goal: 'Ship the app' }, { name: 'Owner' })
    poolId = created.pool.id
    poolKey = created.key
    const invite = await ownerApi.createInvite(poolId, { uses: 1, hours: 1 })
    const link = formatPoolInvite({ relay: base, pool: poolId, token: invite.token, key: poolKey, version: 1 })

    // The link travels; the member pastes it.
    const pasted = parsePoolInvite(link)
    if (!pasted) throw new Error('the link does not parse')
    const joined = await new PoolApi({ relay: base, token: member.token }).join(member.key, member.account, pasted, { name: 'Member' })
    expect(joined.role).toBe('member')
    // Its own copy of the key opens with its own account key: its other devices and its machines get it from there.
    expect(await openPoolGrant(member.key, joined.key, poolId)).toMatchObject({ key: poolKey })

    owner.client.subscribePool(poolId)
    member.client.subscribePool(poolId)
    const state = await eventually(async () => {
      const read = await stateOf(member, poolKey)
      return read?.members.length === 2 && read
    }, 'the pool at the member')
    expect(state.info).toEqual({ name: 'SECRET hackathon', goal: 'Ship the app' })
    expect(state.members.map(m => m.profile?.name).sort()).toEqual(['Member', 'Owner'])
  })

  test("the member's session joins with an order its agent checks; a forged order gets no answer", async () => {
    const vault = new PoolVault(poolKey)
    const profile = await vault.seal({ area: 'back', project: 'shop', tool: 'claude' })
    // Sealed with a key the account does not have: the agent drops it, so the session never becomes ready.
    const forged = await sealPoolSessionOrder(newAccountKey(), { poolId, sessionId, key: newAccountKey(), version: 1 })
    member.client.sendPool({ t: 'pool_join_session', poolId, sessionId, order: forged, profile })
    await eventually(async () => (await stateOf(owner, poolKey))?.sessions.some(s => s.session === sessionId && s.online), 'the session')
    await Bun.sleep(500)
    expect((await stateOf(owner, poolKey))?.sessions.find(s => s.session === sessionId)?.ready).toBe(false)

    const order = await sealPoolSessionOrder(member.key, { poolId, sessionId, key: poolKey, version: 1 })
    member.client.sendPool({ t: 'pool_join_session', poolId, sessionId, order, profile })
    const ready = await eventually(async () => {
      const session = (await stateOf(owner, poolKey))?.sessions.find(s => s.session === sessionId)
      return session?.ready && session
    }, 'the session ready')
    expect(ready.profile).toEqual({ area: 'back', project: 'shop', tool: 'claude' })
  })

  test('a task from the owner reaches the member sealed, and the relay never sees what it says', async () => {
    const vault = new PoolVault(poolKey)
    owner.client.sendPool({
      t: 'pool_task',
      poolId,
      id: newPoolItemId(),
      rev: 0,
      blob: await vault.seal({ title: 'SECRET API', state: 'todo', area: 'back' }),
    })
    owner.client.sendPool({
      t: 'pool_message',
      poolId,
      id: newPoolItemId(),
      blob: await vault.seal({ text: 'SECRET hello', to: { area: 'back' } }),
    })
    const state = await eventually(async () => {
      const read = await stateOf(member, poolKey)
      return read?.tasks.length && read.messages.length && read
    }, 'the task and the message')
    expect(state.tasks[0].task).toEqual({ title: 'SECRET API', state: 'todo', area: 'back' })
    expect(state.messages[0].body).toEqual({ text: 'SECRET hello', to: { area: 'back' } })
    for (const peer of [owner, member]) {
      const traffic = peer.raw.join('')
      for (const secret of ['SECRET', 'hackathon', 'Ship the app', 'shop']) expect(traffic).not.toContain(secret)
    }
  })

  test('kicking a third member rotates the key: the others read what follows, the kicked one gets nothing', async () => {
    const third = await post('/api/accounts', {})
    const kicked = await app(third.token, newAccountKey(), third.accountId)
    const ownerApi = new PoolApi({ relay: base, token: owner.token })
    const invite = await ownerApi.createInvite(poolId, { uses: 1, hours: 1 })
    await new PoolApi({ relay: base, token: kicked.token }).join(kicked.key, kicked.account, {
      relay: base,
      pool: poolId,
      token: invite.token,
      key: poolKey,
      version: 1,
    })
    kicked.client.subscribePool(poolId)
    await eventually(async () => (await stateOf(owner, poolKey))?.members.length === 3, 'three members')

    const rotated = await ownerApi.kick(owner.key, owner.account, poolId, kicked.account)
    expect(rotated.version).toBe(2)
    expect(rotated.skipped).toEqual([])
    await eventually(() => kicked.updates.some(u => u.t === 'pool_removed' && u.poolId === poolId), 'the kicked member out')
    expect((await new PoolApi({ relay: base, token: kicked.token }).list()).map(p => p.id)).not.toContain(poolId)

    // The member opens version 2 from the wrap the owner made for it, with its private key.
    const summary = (await new PoolApi({ relay: base, token: member.token }).list()).find(p => p.id === poolId)
    if (!summary) throw new Error('the member lost the pool')
    const grant = await openPoolGrant(member.key, summary.key, poolId)
    if (!grant) throw new Error('no grant')
    const members = await new PoolApi({ relay: base, token: member.token }).members(poolId)
    const { keyring } = await resolvePoolKeyring({
      accountKey: member.key,
      poolId,
      account: member.account,
      grant,
      secret: summary.secret,
      wraps: summary.wraps,
      members,
    })
    expect(keyring.key(2)).toBe(rotated.key)

    // What the owner writes now reads for the member and not with the key the kicked member had.
    const ownerKeys = new PoolKeyring(poolKey, 1)
    ownerKeys.add(2, rotated.key)
    const blob = await new PoolVault(ownerKeys).seal({ title: 'SECRET after the kick', state: 'todo' })
    expect(blobVersion(blob)).toBe(2)
    owner.client.sendPool({ t: 'pool_task', poolId, id: newPoolItemId(), rev: 0, blob })
    await eventually(async () => {
      const read = await stateOf(member, keyring)
      return read?.tasks.some(t => t.task?.title === 'SECRET after the kick')
    }, 'the new task at the member')
    expect(await new PoolVault(poolKey).read(blob, value => value)).toBeNull()
    expect(kicked.raw.join('')).not.toContain(blob)
    expect(kicked.updates.some(u => u.t === 'pool_key')).toBe(false)

    // The member's agent followed the rotation too: it published the member's public key under version 2.
    const republished = await eventually(async () => {
      const read = await stateOf(owner, ownerKeys)
      const blobs = read?.members.find(m => m.account === member.account)?.publicKeys ?? []
      return blobs.find(b => blobVersion(b) === 2)
    }, 'the public key under version 2')
    expect(await openPoolMemberKey(ownerKeys, republished, poolId, member.account)).not.toBeNull()
  })

  test('the member leaves: its session leaves with it, and the owner sees both go', async () => {
    await new PoolApi({ relay: base, token: member.token }).leave(poolId)
    await eventually(() => member.updates.some(u => u.t === 'pool_removed'), 'removed for the member')
    const state = await eventually(async () => {
      const read = await stateOf(owner, poolKey)
      return read?.members.length === 1 && read
    }, 'the member gone')
    expect(state.sessions).toEqual([])
  })
})
