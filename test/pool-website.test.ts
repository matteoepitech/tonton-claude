// The pools of the relay's website, end to end: a real relay, and three accounts each going through the same client-core
// calls the page makes (shared/pool-watch.ts). No browser runs here: the page only renders what these calls return.
// The owner makes a pool and an invite link; two others join with it; tasks are made, moved and fought over; a
// viewer cannot write; a member is removed and the pool key changes under everyone left. The relay sees none of it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { RelayClient, type SocketLike } from '../shared/client'
import { newAccountKey } from '../shared/crypto'
import { PoolApi } from '../shared/pool-api'
import { board, moved } from '../shared/pool-board'
import { formatPoolInvite, parsePoolInvite } from '../shared/pool-link'
import { PoolWatch } from '../shared/pool-watch'
import { Vault } from '../shared/vault'

const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-site-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`

interface Browser {
  account: string
  client: RelayClient
  watch: PoolWatch
  raw: string[]
}

let ana: Browser
let bob: Browser
let zed: Browser
let poolId: string

async function eventually<T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** A browser signed in to one new account, on the page's code: a relay client and the pools it follows. */
async function browser(): Promise<Browser> {
  const created = await (await fetch(`${base}/api/accounts`, { method: 'POST' })).json()
  const key = newAccountKey()
  const raw: string[] = []
  let watch: PoolWatch | null = null
  const client = new RelayClient({
    vault: new Vault(key),
    connect: () => {
      const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/app`, ['tonton', `bearer.${created.token}`])
      socket.addEventListener('message', event => raw.push(String(event.data)))
      return socket as unknown as SocketLike
    },
    onChange: () => {},
    onPoolUpdate: update => void watch?.handle(update),
  })
  watch = new PoolWatch({
    api: new PoolApi({ relay: base, token: created.token }),
    accountKey: key,
    account: created.accountId,
    relay: base,
    link: client,
    onChange: () => {},
  })
  client.start()
  await eventually(() => client.state.connection === 'connected', 'the socket')
  return { account: created.accountId, client, watch, raw }
}

const tasksOf = (peer: Browser) => peer.watch.pool(poolId)?.state?.tasks ?? []

beforeAll(async () => {
  ana = await browser()
  bob = await browser()
  zed = await browser()
})

afterAll(() => {
  for (const peer of [ana, bob, zed]) peer?.client.stop()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('pools on the website', () => {
  test('the relay serves the page with its Pools tab', async () => {
    const html = await (await fetch(`${base}/`)).text()
    const script = html.match(/src="\.?(\/[^"]+\.js)"/)?.[1]
    if (!script) throw new Error('no script on the page')
    const code = await (await fetch(`${base}${script}`)).text()
    for (const text of ['New pool', 'New task', 'Make owner', 'tontonpool1.']) expect(code).toContain(text)
  })

  test('a pool is made, and two accounts join it with the invite link', async () => {
    const id = await ana.watch.create({ name: 'SECRET Basel Hack', goal: 'Ship the app' }, { name: 'Ana' })
    if (!id) throw new Error(`no pool: ${ana.watch.problem}`)
    poolId = id
    expect(ana.watch.pools.map(pool => pool.info?.name)).toEqual(['SECRET Basel Hack'])
    ana.watch.open(poolId)
    await eventually(() => ana.watch.pool(poolId)?.state, 'the pool to open')

    const made = await ana.watch.invite(poolId, { uses: 2, hours: 1, role: 'member' })
    if (!made) throw new Error(`no invite: ${ana.watch.problem}`)
    expect(parsePoolInvite(made.link)?.pool).toBe(poolId)
    expect((await ana.watch.invites(poolId))?.[0]).toMatchObject({ usesLeft: 2, role: 'member' })

    for (const [peer, name] of [
      [bob, 'Bob'],
      [zed, 'Zed'],
    ] as const) {
      expect(await peer.watch.join(made.link, { name })).toBe(poolId)
      expect(peer.watch.pools[0]?.info?.name).toBe('SECRET Basel Hack')
      peer.watch.open(poolId)
      await eventually(() => peer.watch.pool(poolId)?.state, 'the pool to open')
    }
    await eventually(() => ana.watch.pool(poolId)?.state?.members.length === 3, 'the members')
    // An invite for another relay is refused before anything is sent.
    const elsewhere = parsePoolInvite(made.link)
    if (!elsewhere) throw new Error('the invite does not parse')
    expect(await bob.watch.join(formatPoolInvite({ ...elsewhere, relay: 'https://other.example.com' }))).toBeNull()
    expect(bob.watch.problem).toContain('other.example.com')
    bob.watch.clearProblem()
  })

  test("a task made by one shows on everyone's board, and moves for everyone", async () => {
    const id = await ana.watch.saveTask(poolId, null, { title: 'SECRET checkout page', state: 'todo', area: 'front' })
    if (!id) throw new Error('not saved')
    for (const peer of [bob, zed])
      await eventually(() => tasksOf(peer).some(task => task.task?.title === 'SECRET checkout page'), 'the task')
    const mine = tasksOf(bob).find(task => task.id === id)
    if (!mine?.task) throw new Error('no task')
    await bob.watch.saveTask(poolId, id, moved(mine.task, 'in_progress'))
    await eventually(() => board(tasksOf(ana)).columns.find(column => column.state === 'in_progress')?.tasks.length === 1, 'the move')
    // Each change leaves an event: the task's history.
    await eventually(() => ana.watch.pool(poolId)?.state?.events.filter(event => event.body?.taskId === id).length === 2, 'the history')
  })

  test('two changes over the same revision: the second is refused and shows the first', async () => {
    const id = tasksOf(ana)[0].id
    const seen = tasksOf(ana).find(task => task.id === id)
    if (!seen?.task) throw new Error('no task')
    // Both saw the same revision; Bob's change lands first.
    await bob.watch.saveTask(poolId, id, { ...seen.task, branch: 'feat/bob' })
    await eventually(() => tasksOf(zed).find(task => task.id === id)?.task?.branch === 'feat/bob', 'the first change')
    // Ana's page still shows the older revision, as when she opened the editor before Bob saved: the relay refuses hers.
    const state = ana.watch.pool(poolId)?.state
    if (!state) throw new Error('no state')
    state.tasks = state.tasks.map(task => (task.id === id ? seen : task))
    await ana.watch.saveTask(poolId, id, { ...seen.task, branch: 'feat/ana' })
    await eventually(() => ana.watch.pool(poolId)?.conflicts.has(id), 'the conflict')
    expect(tasksOf(ana).find(task => task.id === id)?.task?.branch).toBe('feat/bob')
  })

  test('a viewer reads the board and cannot change it', async () => {
    expect(await ana.watch.setRole(poolId, zed.account, 'viewer')).toBe(true)
    await eventually(
      () => zed.watch.pool(poolId)?.state?.members.find(member => member.account === zed.account)?.role === 'viewer',
      'the role',
    )
    await zed.watch.refresh()
    expect(zed.watch.pool(poolId)?.role).toBe('viewer')
    const before = tasksOf(ana).length
    await zed.watch.saveTask(poolId, null, { title: 'From a viewer', state: 'todo' })
    await Bun.sleep(300)
    expect(tasksOf(ana).length).toBe(before)
  })

  test('removing a member changes the key: the others read what follows, the removed one gets nothing', async () => {
    const skipped = await ana.watch.kick(poolId, zed.account)
    expect(skipped).toEqual([])
    await eventually(() => zed.watch.pool(poolId) === null || zed.watch.pools.length === 0, 'the removed member to lose the pool')
    await eventually(() => (ana.watch.pool(poolId)?.state?.keyVersion ?? 0) >= 2, 'the new key for the owner')
    await eventually(() => (bob.watch.pool(poolId)?.state?.keyVersion ?? 0) >= 2, 'the new key for Bob')
    const zedSaw = zed.raw.length
    await ana.watch.saveTask(poolId, null, { title: 'SECRET after the kick', state: 'todo' })
    await eventually(() => tasksOf(bob).some(task => task.task?.title === 'SECRET after the kick'), 'the new task for Bob')
    // The removed member got nothing of it, and never had the new key.
    expect(zed.raw.slice(zedSaw).join('')).not.toContain('pool_task')
  })

  test('the relay only ever saw sealed blobs', () => {
    const traffic = [ana, bob, zed].flatMap(peer => peer.raw).join('')
    for (const secret of ['SECRET', 'Basel Hack', 'checkout', 'feat/bob']) expect(traffic).not.toContain(secret)
  })
})
