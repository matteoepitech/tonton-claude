// Pool machines end to end (docs/pool-autopilot.md): a real relay, two accounts on the client core the website runs
// (shared/pool-watch.ts), and the background service of a member's machine on its own socket. The member puts the
// machine in the pool; only that machine's service opens the order, with the member's account key; the admin chooses
// its own machine as the orchestrator and starts the dispatch. What the machine is and where it works stays sealed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { RelayClient, type SocketLike } from '../shared/client'
import { newAccountKey, seal } from '../shared/crypto'
import { PoolVault } from '../shared/pool'
import { PoolApi } from '../shared/pool-api'
import { PoolKeyring } from '../shared/pool-keys'
import { openPoolMachineOrder, poolMachineProfile } from '../shared/pool-machines'
import type { PoolMachineProfile } from '../shared/pool-protocol'
import { PoolWatch } from '../shared/pool-watch'
import { parsePoolToMachine, parsePoolUpdate } from '../shared/pool-wire'
import { Vault } from '../shared/vault'

const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-machines-e2e-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`

interface Browser {
  account: string
  key: string
  token: string
  client: RelayClient
  watch: PoolWatch
  raw: string[]
}

interface Service {
  machineId: string
  socket: WebSocket
  messages: { t: string; [field: string]: unknown }[]
  raw: string[]
}

let ana: Browser
let bob: Browser
let poolId: string

async function eventually<T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>, label: string): Promise<T> {
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

async function browser(): Promise<Browser> {
  const created = await post('/api/accounts', {})
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
  return { account: created.accountId, key, token: created.token, client, watch, raw }
}

/** A machine of the account, and its background service connected to the relay. */
async function service(owner: Browser): Promise<Service> {
  const { secret } = await post('/api/account/token', {}, owner.token)
  const machine = await post('/api/machines/join', {
    account: owner.account,
    secret,
    name: await seal(owner.key, { name: 'SECRET Studio' }),
  })
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/agent`, {
    headers: { authorization: `Bearer ${machine.token}`, 'x-tonton-role': 'service', 'x-tonton-agent': '0.9.0' },
  } as never)
  const opened: Service = { machineId: machine.machineId, socket, messages: [], raw: [] }
  socket.onmessage = event => {
    opened.raw.push(String(event.data))
    opened.messages.push(JSON.parse(String(event.data)))
  }
  await new Promise(resolve => (socket.onopen = resolve))
  return opened
}

const stateOf = (peer: Browser) => peer.watch.pool(poolId)?.state

beforeAll(async () => {
  ana = await browser()
  bob = await browser()
})

afterAll(() => {
  for (const peer of [ana, bob]) peer?.client.stop()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('pool machines end to end', () => {
  let studio: Service
  let lead: Service
  const profile = poolMachineProfile({
    name: 'SECRET Studio',
    tool: 'claude',
    capacity: 2,
    workdir: '~/SECRET-work',
    mode: 'edits',
    areas: ['back'],
  }) as PoolMachineProfile

  test("a member puts its machine in the pool; only its service opens the order, with the member's account key", async () => {
    const id = await ana.watch.create({ name: 'SECRET hackathon' }, { name: 'Ana' })
    if (!id) throw new Error(`no pool: ${ana.watch.problem}`)
    poolId = id
    ana.watch.open(poolId)
    await eventually(() => stateOf(ana), 'the pool at Ana')
    const made = await ana.watch.invite(poolId, { uses: 1, hours: 1, role: 'member' })
    if (!made) throw new Error('no invite')
    await bob.watch.join(made.link, { name: 'Bob' })
    bob.watch.open(poolId)
    await eventually(() => stateOf(bob), 'the pool at Bob')
    expect(stateOf(bob)?.machines).toEqual([])

    studio = await service(bob)
    expect(typeof profile).toBe('object')
    expect(await bob.watch.addMachine(poolId, studio.machineId, profile)).toBe(true)
    const order = parsePoolToMachine(await eventually(() => studio.messages.find(m => m.t === 'pool_machine_join'), 'the order'))
    if (order?.t !== 'pool_machine_join') throw new Error('no order')
    // Ana holds the pool key, not Bob's account key: the order is Bob's own.
    expect(await openPoolMachineOrder(ana.key, order.order, studio.machineId, poolId)).toBeNull()
    const opened = await openPoolMachineOrder(bob.key, order.order, studio.machineId, poolId)
    expect(opened?.profile).toEqual(profile)

    // The members see the machine and what it is for; online, and ready once the service took the order.
    const seen = await eventually(() => stateOf(ana)?.machines?.[0], 'the machine at Ana')
    expect(seen).toMatchObject({ account: bob.account, machine: studio.machineId, profile, online: true, ready: false })
    studio.socket.send(JSON.stringify({ t: 'pool_machine_ack', machineId: studio.machineId, poolId }))
    await eventually(() => stateOf(ana)?.machines?.[0]?.ready, 'the machine ready')
    const snapshot = parsePoolUpdate(await eventually(() => studio.messages.find(m => m.t === 'pool_snapshot'), 'the snapshot'))
    if (snapshot?.t !== 'pool_snapshot' || !opened) throw new Error('no snapshot')
    const read = await new PoolVault(new PoolKeyring(opened.key, opened.version)).snapshot(snapshot.pool)
    expect(read.info?.name).toBe('SECRET hackathon')
    expect(read.machines?.[0].profile).toEqual(profile)
  })

  test('the admin runs the orchestrator on its own machine and starts the dispatch; every member sees it', async () => {
    lead = await service(ana)
    expect(await ana.watch.addMachine(poolId, lead.machineId, { ...profile, name: 'SECRET lead', workdir: '/srv/SECRET-lead' })).toBe(true)
    await eventually(() => lead.messages.find(m => m.t === 'pool_machine_join'), 'the order at the lead')
    // Bob's machine is not Ana's own.
    ana.watch.setOrchestratorMachine(poolId, { account: bob.account, machine: studio.machineId })
    await eventually(() => ana.watch.pool(poolId)?.problem?.includes('your own'), 'refused')
    ana.watch.clearProblem(poolId)
    ana.watch.setOrchestratorMachine(poolId, { account: ana.account, machine: lead.machineId })
    await eventually(() => stateOf(bob)?.orchestratorMachine?.machine === lead.machineId, 'the orchestrator machine at Bob')

    expect(await bob.watch.setDispatch(poolId, { on: true })).toBe(true)
    await eventually(() => bob.watch.pool(poolId)?.problem, 'a member cannot')
    expect(await ana.watch.setDispatch(poolId, { on: true, note: 'SECRET go' })).toBe(true)
    const on = await eventually(() => stateOf(bob)?.dispatch?.value, 'the dispatch at Bob')
    expect(on).toEqual({ on: true, note: 'SECRET go' })
    expect(stateOf(bob)?.audit.map(line => line.action)).toEqual(expect.arrayContaining(['machine_added', 'dispatch_set']))
  })

  test('the member takes its machine out; the relay never saw what it is', async () => {
    expect(bob.watch.removeMachine(poolId, studio.machineId)).toBe(true)
    await eventually(() => studio.messages.find(m => m.t === 'pool_machine_leave'), 'the service told')
    await eventually(() => stateOf(ana)?.machines?.length === 1, 'the machine gone at Ana')
    for (const traffic of [ana.raw, bob.raw, studio.raw, lead.raw].map(raw => raw.join(''))) {
      for (const secret of ['SECRET', '~/', '/srv/', 'edits', 'Studio']) expect(traffic).not.toContain(secret)
    }
  })
})
