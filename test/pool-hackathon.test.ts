// Hackathon mode end to end: a real relay, a real agent channel, and the website's own client core. The owner makes a
// pool from the hackathon template (its deadline in the info, its roles in the notes), puts a Claude Code session in
// it and makes that session the orchestrator. The session gets the hackathon guide, sees the deadline in
// pool_overview, and its agent tells it when half the time is gone. The relay only carries sealed blobs.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { HACKATHON_GUIDE } from '../agent/src/channel/pool-orchestrator'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { RelayClient, type SocketLike } from '../shared/client'
import { newAccountKey, seal } from '../shared/crypto'
import { newPoolItemId, openPoolGrant, PoolVault, sealPoolSessionOrder } from '../shared/pool'
import { PoolApi } from '../shared/pool-api'
import { HACKATHON_ROLES, hackathonInfo, hackathonNotes } from '../shared/pool-hackathon'
import { PoolKeyring } from '../shared/pool-keys'
import { PoolWatch } from '../shared/pool-watch'
import { Vault } from '../shared/vault'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const LEAD = `lead-${Date.now()}`
const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-hackathon-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`
const MIN = 60_000

let accountId: string
let accountKey: string
let client: RelayClient
let watch: PoolWatch
let claude: Client
const notifications: { method: string; params?: { content?: string; meta?: { sender?: string } } }[] = []
const raw: string[] = []
let poolId: string
let poolKey: string
// Set when the pool is made: half time comes 15 seconds later, once the session leads; one hour left is before the
// start, so it is no mark.
let startedAt: Date
let deadline: Date

async function eventually<T>(read: () => T | undefined | false | Promise<T | undefined | false>, label: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
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

const notices = (kind: string) =>
  notifications.filter(n => n.params?.meta?.sender === 'pool' && n.params.content?.startsWith(`<pool kind="${kind}"`))

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = (await claude.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return result.content[0].text
}

beforeAll(async () => {
  const created = await post('/api/accounts', {})
  accountId = created.accountId
  accountKey = newAccountKey()
  const { secret } = await post('/api/account/token', {}, created.token)
  const machine = await post('/api/machines/join', { account: accountId, secret, name: await seal(accountKey, { name: 'Lead' }) })
  const home = join(dir, 'lead')
  mkdirSync(join(home, 'run'), { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: base, ...machine, key: accountKey, machine: 'Lead', version: '0.9.0' }))

  client = new RelayClient({
    vault: new Vault(accountKey),
    connect: () => {
      const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/app`, {
        headers: { authorization: `Bearer ${created.token}` },
      } as never)
      socket.addEventListener('message', event => raw.push(String(event.data)))
      return socket as unknown as SocketLike
    },
    onChange: () => {},
    onPoolUpdate: update => void watch.handle(update),
  })
  watch = new PoolWatch({
    api: new PoolApi({ relay: base, token: created.token }),
    accountKey,
    account: accountId,
    relay: base,
    link: client,
    onChange: () => {},
  })
  client.start()
  await eventually(() => client.state.connection === 'connected', 'the app')

  const transcript = join(home, `${LEAD}.jsonl`)
  writeFileSync(
    transcript,
    `${JSON.stringify({ sessionId: LEAD, type: 'assistant', uuid: 'a1', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }] } })}\n`,
  )
  writeFileSync(
    join(home, 'run', `${process.pid}.json`),
    JSON.stringify({ sessionId: LEAD, transcriptPath: transcript, cwd: '/home/x/shop' }),
  )
  claude = new Client({ name: 'claude-code', version: 'test' })
  claude.fallbackNotificationHandler = async notification => {
    notifications.push(notification as (typeof notifications)[number])
  }
  const env = { ...process.env, TONTON_HOME: home, TONTON_CHANNEL: '1', TONTON_SERVICE: 'off' } as Record<string, string>
  await claude.connect(new StdioClientTransport({ command: 'bun', args: [AGENT, 'channel'], env }))
  await eventually(() => client.state.sessions.some(s => s.id === LEAD && s.agentOnline), 'the session')
}, 40_000)

afterAll(async () => {
  client?.stop()
  await claude?.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('hackathon mode end to end', () => {
  test('the template puts the deadline in the info and the roles in the notes', async () => {
    await watch.refresh()
    startedAt = new Date(Date.now() - 20 * MIN)
    deadline = new Date(Date.now() + 20 * MIN + 30_000)
    const setup = { deadline: deadline.toISOString(), repo: 'github.com/team/SECRET-shop', roles: HACKATHON_ROLES }
    const info = { ...hackathonInfo({ name: 'SECRET Basel Hack', goal: 'Ship the shop' }, setup), startedAt: startedAt.toISOString() }
    const id = await watch.create(info, { name: 'Ana' }, hackathonNotes(setup))
    if (!id) throw new Error(watch.problem ?? 'the pool was not made')
    poolId = id
    watch.open(poolId)
    const state = await eventually(() => {
      const opened = watch.pool(poolId)?.state
      return opened?.notes?.areas?.length && opened
    }, 'the notes with their areas')
    expect(state.info).toMatchObject({ template: 'hackathon', deadline: deadline.toISOString() })
    expect(state.notes?.areas?.map(area => area.name)).toEqual(['front', 'back', 'infra', 'qa'])
    const summary = watch.pools.find(listed => listed.summary.id === poolId)?.summary
    const grant = summary ? await openPoolGrant(accountKey, summary.key, poolId) : null
    if (!grant) throw new Error('no pool key')
    poolKey = grant.key
  })

  test('the owner makes its session the orchestrator: it gets the hackathon guide and sees the deadline', async () => {
    const order = await sealPoolSessionOrder(accountKey, { poolId, sessionId: LEAD, key: poolKey, version: 1, autoStart: true })
    const profile = await new PoolVault(new PoolKeyring(poolKey, 1)).seal({ tool: 'claude' as const })
    client.sendPool({ t: 'pool_join_session', poolId, sessionId: LEAD, order, profile })
    await eventually(() => watch.pool(poolId)?.state?.sessions.some(s => s.session === LEAD && s.ready), 'the session in the pool')
    expect(watch.setOrchestrator(poolId, { account: accountId, session: LEAD })).toBe(true)
    await eventually(() => watch.pool(poolId)?.state?.orchestrator?.session === LEAD, 'the orchestrator on the relay')
    const role = await eventually(() => notices('role')[0], 'the guide')
    expect(role.params?.content).toContain('Never single steps')
    expect(role.params?.content).toContain(HACKATHON_GUIDE)
    const overview = JSON.parse(await call('pool_overview'))
    expect(overview).toMatchObject({ deadline: deadline.toISOString(), timeLeft: expect.stringContaining('min left') })
  })

  test('its agent tells it when half the time is gone, once', async () => {
    expect(notices('notice').some(n => n.params?.content?.includes('Half the time'))).toBe(false)
    await Bun.sleep(Math.max(0, startedAt.getTime() + (deadline.getTime() - startedAt.getTime()) / 2 - Date.now() + 200))
    // Anything that changes in the pool makes the agent look; so does its timer, each minute.
    const vault = new PoolVault(new PoolKeyring(poolKey, 1))
    client.sendPool({ t: 'pool_message', poolId, id: newPoolItemId(), blob: await vault.seal({ text: 'SECRET how is it going?' }) })
    const half = await eventually(
      () => notices('notice').find(n => n.params?.content?.includes('Half the time is gone')),
      'the half-time notice',
    )
    expect(half.params?.content).toContain('min left')
    client.sendPool({ t: 'pool_message', poolId, id: newPoolItemId(), blob: await vault.seal({ text: 'again' }) })
    await Bun.sleep(500)
    expect(notices('notice').filter(n => n.params?.content?.includes('Half the time'))).toHaveLength(1)
    for (const secret of ['SECRET', 'Basel', 'front", "back']) expect(raw.join('')).not.toContain(secret)
  }, 40_000)
})
