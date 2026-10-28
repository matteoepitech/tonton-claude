// The orchestrator machine's session against a real relay (docs/pool-autopilot.md): the machine's service starts it in
// its clone of the repository and the relay makes it the pool's orchestrator; one that ends is started again; a
// restarted service finds it again; and once the admin chooses no machine, it ends. Stand-ins replace git and the terminal.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../relay/src/config'
import { startRelay } from '../../relay/src/main'
import { RelayClient, type SocketLike } from '../../shared/client'
import { newAccountKey, seal } from '../../shared/crypto'
import { PoolApi } from '../../shared/pool-api'
import { PoolWatch } from '../../shared/pool-watch'
import { Vault } from '../../shared/vault'
import { RelayConnection } from '../src/channel/relay-connection'
import type { launchForPool } from '../src/launch'
import { PoolLead } from '../src/service/pool-lead'
import { MachinePools } from '../src/service/pool-machines'

const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-lead-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`

async function eventually<T>(read: () => T | undefined | null | false, label: string): Promise<T> {
  for (let i = 0; i < 160; i++) {
    const value = read()
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

let accountId: string
let accountKey: string
let machine: { machineId: string; token: string }
let poolId: string
let watch: PoolWatch
let client: RelayClient
const sessions = new Map<string, { socket: WebSocket; alive: boolean }>()
const launched: { id: string; cwd: string; tool: string }[] = []
const home = join(dir, 'home')
let count = 0

/** A Claude Code session showing up as its channel would, on the machine. */
const launch: typeof launchForPool = async (id, cwd, tool) => {
  launched.push({ id, cwd, tool })
  const sessionId = `ses_lead_${++count}`
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/agent`, { headers: { authorization: `Bearer ${machine.token}` } } as never)
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data))
    if (message.t === 'pool_join') socket.send(JSON.stringify({ t: 'pool_ack', sessionId, poolId: message.poolId }))
  }
  await new Promise(resolve => (socket.onopen = resolve))
  socket.send(
    JSON.stringify({ t: 'hello', sessionId, info: await seal(accountKey, { machine: 'Lead', cwd, project: 'shop' }), channel: true }),
  )
  const tmux = `tonton-pool-${id}-${count}`
  sessions.set(tmux, { socket, alive: true })
  return { sessionId, tmux }
}

function service() {
  const config = { server: base, machineId: machine.machineId, token: machine.token, key: accountKey, machine: 'Lead' }
  let lead: PoolLead | null = null
  const connection: RelayConnection = new RelayConnection(config, 'service', {
    connected: () => {},
    message: message => {
      if (message.t === 'pool_machine_join') pools.receive(message.poolId, message.order)
      if (message.t === 'pool_machine_leave') pools.remove(message.poolId)
    },
    pool: update => pools.apply(update),
  })
  const pools = new MachinePools(
    accountKey,
    machine.machineId,
    build => connection.post(build),
    id => lead?.changed(id),
    join(home, 'pm.json'),
  )
  lead = new PoolLead(pools, {
    machineName: 'Lead',
    home,
    launch,
    prepare: async workdir => ({ clone: join(workdir, 'repo') }),
    runs: tmux => sessions.get(tmux)?.alive === true,
    end: tmux => {
      const session = sessions.get(tmux)
      if (session) session.alive = false
    },
    retryMs: [200],
  })
  connection.connect()
  return { connection, pools, lead }
}

let running: ReturnType<typeof service>
const state = () => watch.pool(poolId)?.state

beforeAll(async () => {
  const account = await post('/api/accounts', {})
  accountId = account.accountId
  accountKey = newAccountKey()
  const { secret } = await post('/api/account/token', {}, account.token)
  machine = await post('/api/machines/join', { account: accountId, secret, name: await seal(accountKey, { name: 'Lead' }) })
  const api = new PoolApi({ relay: base, token: account.token })
  poolId = (await api.create(accountKey, accountId, { name: 'Shop', repo: 'https://example.com/shop.git' }, { name: 'Ana' })).pool.id
  client = new RelayClient({
    vault: new Vault(accountKey),
    connect: () => new WebSocket(`${base.replace('http', 'ws')}/ws/app`, ['tonton', `bearer.${account.token}`]) as unknown as SocketLike,
    onChange: () => {},
    onPoolUpdate: update => void watch.handle(update),
  })
  watch = new PoolWatch({ api, accountKey, account: accountId, relay: base, link: client, onChange: () => {} })
  client.start()
  await eventually(() => client.state.connection === 'connected', 'the app')
  await watch.refresh()
  watch.open(poolId)
  await eventually(() => state(), 'the pool')
  running = service()
  await watch.addMachine(poolId, machine.machineId, { tool: 'opencode', capacity: 1, workdir: join(dir, 'work'), mode: 'full' })
  await eventually(() => state()?.machines?.[0]?.ready, 'the machine ready')
}, 20_000)

afterAll(() => {
  running?.lead.stop()
  running?.connection.stop()
  client?.stop()
  for (const session of sessions.values()) session.socket.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('the orchestrator machine', () => {
  test('its service starts Claude Code in its clone, and the relay makes that session the orchestrator', async () => {
    expect(launched).toEqual([])
    watch.setOrchestratorMachine(poolId, { account: accountId, machine: machine.machineId })
    const lead = await eventually(() => state()?.orchestrator, 'the orchestrator session')
    expect(lead).toEqual({ account: accountId, session: 'ses_lead_1' })
    // Claude Code, whatever its workers run, in the repository.
    expect(launched[0]).toEqual({ id: `lead-${poolId}`, cwd: join(dir, 'work', 'repo'), tool: 'claude' })
    expect(running.lead.session(poolId)).toBe('ses_lead_1')
  })

  test('a session that ends is started again, and is the orchestrator again', async () => {
    const [first] = [...sessions.values()]
    first.alive = false
    running.lead.changed(poolId)
    await eventually(() => state()?.orchestrator?.session === 'ses_lead_2', 'the second session leading')
    await running.lead.settled()
    expect(launched).toHaveLength(2)
  })

  test('a restarted service finds its session again; once no machine is chosen, it ends', async () => {
    running.lead.stop()
    running.connection.stop()
    running = service()
    await eventually(() => running.pools.state(poolId), 'the pool after the restart')
    await running.lead.settled()
    expect(running.lead.session(poolId)).toBe('ses_lead_2')
    expect(launched).toHaveLength(2)

    watch.setOrchestratorMachine(poolId, null)
    await eventually(() => running.lead.session(poolId) === null, 'the session ended')
    expect([...sessions.values()].every(session => !session.alive)).toBe(true)
    await eventually(() => !state()?.sessions.some(s => s.session === 'ses_lead_2'), 'the session out of the pool')
  })
})
