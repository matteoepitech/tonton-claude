// Account limits and review in a pool, end to end: a real relay, four accounts and four Claude Code sessions behind real
// agents. One session's plan is used up: its agent shares it, sealed, and the orchestrator's rules skip it. The task goes
// to the other worker; when it is finished, the review session gets it, sends it back with notes, then accepts it. The
// test plays Claude Code with MCP clients. The relay only ever carries sealed blobs.
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
import { type PoolState, PoolVault, sealPoolSessionOrder } from '../shared/pool'
import { PoolApi } from '../shared/pool-api'
import { PoolKeyring } from '../shared/pool-keys'
import { formatPoolInvite, parsePoolInvite } from '../shared/pool-link'
import type { PoolSessionProfile, PoolUpdate } from '../shared/pool-protocol'
import { RPGClient } from '../shared/rpg-client'
import { Vault } from '../shared/vault'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const stamp = Date.now()
const LEAD = `lead-${stamp}`
const LOW = `low-${stamp}`
const OK = `ok-${stamp}`
const REV = `rev-${stamp}`
const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-review-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`

interface App {
  accountId: string
  token: string
  key: string
  client: RelayClient
  updates: PoolUpdate[]
  raw: string[]
}

interface Claude {
  client: Client
  notifications: { method: string; params?: { content?: string; meta?: { sender?: string } } }[]
}

const apps: App[] = []
const claudes: Claude[] = []
let owner: App
let lead: Claude
let low: Claude
let ok: Claude
let rev: Claude
let poolId: string
let poolKey: string
let taskId: string

async function eventually<T>(read: () => T | undefined | false | Promise<T | undefined | false>, label: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
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

/** An account with one machine running one Claude Code session, its app on the client core. */
async function member(name: string, sessionId: string, usage?: object): Promise<{ app: App; claude: Claude }> {
  const created = await post('/api/accounts', {})
  const key = newAccountKey()
  const { secret } = await post('/api/account/token', {}, created.token)
  const machine = await post('/api/machines/join', { account: created.accountId, secret, name: await seal(key, { name }) })
  const home = join(dir, name)
  mkdirSync(join(home, 'run'), { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: base, ...machine, key, machine: name, version: '0.9.0' }))
  // What the status line of this session last left for its channel: the plan's windows.
  if (usage) writeFileSync(join(home, 'run', `usage-${sessionId}.json`), JSON.stringify(usage))
  const app: App = { accountId: created.accountId, token: created.token, key, updates: [], raw: [], client: undefined as never }
  app.client = new RelayClient({
    vault: new Vault(key),
    connect: () => {
      const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/app`, {
        headers: { authorization: `Bearer ${created.token}` },
      } as never)
      socket.addEventListener('message', event => app.raw.push(String(event.data)))
      return socket as unknown as SocketLike
    },
    onChange: () => {},
    onPoolUpdate: update => app.updates.push(update),
  })
  app.client.start()
  await eventually(() => app.client.state.connection === 'connected', `${name}'s app`)
  const transcript = join(home, `${sessionId}.jsonl`)
  writeFileSync(
    transcript,
    [
      { sessionId, type: 'user', uuid: 'u1', message: { content: 'hello' } },
      { sessionId, type: 'assistant', uuid: 'a1', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }] } },
    ]
      .map(line => JSON.stringify(line))
      .join('\n')
      .concat('\n'),
  )
  writeFileSync(join(home, 'run', `${process.pid}.json`), JSON.stringify({ sessionId, transcriptPath: transcript, cwd: '/home/x/shop' }))
  const claude: Claude = { client: new Client({ name: 'claude-code', version: 'test' }), notifications: [] }
  claude.client.fallbackNotificationHandler = async notification => {
    claude.notifications.push(notification as Claude['notifications'][number])
  }
  const env = { ...process.env, TONTON_HOME: home, TONTON_CHANNEL: '1', TONTON_SERVICE: 'off' } as Record<string, string>
  await claude.client.connect(new StdioClientTransport({ command: 'bun', args: [AGENT, 'channel'], env }))
  await eventually(() => app.client.state.sessions.some(s => s.id === sessionId && s.agentOnline), `${name}'s session`)
  apps.push(app)
  claudes.push(claude)
  return { app, claude }
}

const call = async (claude: Claude, name: string, args: Record<string, unknown> = {}) => {
  const result = (await claude.client.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return result.content[0].text
}

const pooled = (claude: Claude, kind: string) =>
  claude.notifications.filter(n => n.params?.meta?.sender === 'pool' && n.params.content?.startsWith(`<pool kind="${kind}"`))

async function stateOf(peer: App): Promise<PoolState | null> {
  const vault = new PoolVault(new PoolKeyring(poolKey, 1))
  let state: PoolState | null = null
  for (const update of peer.updates) {
    if (update.t === 'pool_snapshot') state = await vault.snapshot(update.pool)
    else if (state) state = await vault.apply(state, update)
  }
  return state
}

async function joinSession(app: App, sessionId: string, profile: PoolSessionProfile) {
  const order = await sealPoolSessionOrder(app.key, { poolId, sessionId, key: poolKey, version: 1, autoStart: true })
  const sealed = await new PoolVault(new PoolKeyring(poolKey, 1)).seal(profile)
  app.client.sendPool({ t: 'pool_join_session', poolId, sessionId, order, profile: sealed })
}

const later = Math.floor(Date.now() / 1000) + 4 * 3600

beforeAll(async () => {
  ;({ app: owner, claude: lead } = await member('Lead', LEAD))
  // Low's plan is used up for the next four hours.
  const used = { fiveHourLimit: { usedPercent: 100, resetsAt: new Date(later * 1000).toISOString() } }
  const lowMember = await member('Low', LOW, used)
  low = lowMember.claude
  const okMember = await member('Ok', OK, { fiveHourLimit: { usedPercent: 12, resetsAt: new Date(later * 1000).toISOString() } })
  ok = okMember.claude
  const revMember = await member('Rev', REV)
  rev = revMember.claude

  const api = new PoolApi({ relay: base, token: owner.token })
  const created = await api.create(owner.key, owner.accountId, { name: 'SECRET hackathon', goal: 'Ship the shop' }, { name: 'Ana' })
  poolId = created.pool.id
  poolKey = created.key
  for (const [app, name] of [
    [lowMember.app, 'Leo'],
    [okMember.app, 'Oki'],
    [revMember.app, 'Rita'],
  ] as const) {
    const invite = await api.createInvite(poolId, { uses: 1, hours: 1 })
    const pasted = parsePoolInvite(formatPoolInvite({ relay: base, pool: poolId, token: invite.token, key: poolKey, version: 1 }))
    if (!pasted) throw new Error('the invite does not parse')
    await new PoolApi({ relay: base, token: app.token }).join(app.key, app.accountId, pasted, { name })
  }
  for (const app of apps) app.client.subscribePool(poolId)
  await joinSession(owner, LEAD, { tool: 'claude' })
  await joinSession(lowMember.app, LOW, { area: 'back', tool: 'claude' })
  await joinSession(okMember.app, OK, { area: 'back', tool: 'claude' })
  await joinSession(revMember.app, REV, { area: 'review', tool: 'claude' })
  await eventually(async () => {
    const state = await stateOf(owner)
    return state?.sessions.length === 4 && state.sessions.every(s => s.ready)
  }, 'four sessions ready')
  owner.client.sendPool({ t: 'pool_orchestrator', poolId, orchestrator: { account: owner.accountId, session: LEAD } })
  await eventually(async () => (await lead.client.listTools()).tools.some(t => t.name === 'task_create'), 'the planning tools')
}, 60_000)

afterAll(async () => {
  for (const app of apps) app.client.stop()
  await Promise.all(claudes.map(claude => claude.client.close()))
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
}, 20_000)

describe('limits and review end to end', () => {
  test('each Claude Code session shares its plan, and the orchestrator skips the one with none left', async () => {
    await eventually(async () => {
      const events = (await stateOf(owner))?.events ?? []
      return events.some(e => e.session === LOW && e.body?.kind === 'limits' && e.body.limits?.fiveHour?.usedPercent === 100)
    }, "Low's plan in the pool")
    const overview = await eventually(async () => {
      const view = JSON.parse(await call(lead, 'pool_overview'))
      const plan = view.sessions.find((s: { session: string }) => s.session === LOW)?.plan
      return typeof plan === 'object' && plan.fiveHour && view
    }, 'the plans in the overview')
    expect(overview.sessions.find((s: { session: string }) => s.session === LOW).plan.fiveHour).toContain('100 % used')

    const said = await call(lead, 'task_create', {
      title: 'Items API',
      goal: 'SECRET GET /v1/items with its storage, validation and tests',
      criteria: ['the contract holds', 'its tests pass'],
      area: 'back',
      assign: 'auto',
    })
    expect(said).toContain(`Assigned to Oki · back (${OK})`)
    // Named by hand, the session short of time is refused, with why.
    const other = await call(lead, 'task_create', {
      title: 'Orders API',
      goal: 'POST /v1/orders with its storage, validation and tests',
      criteria: ['the contract holds', 'its tests pass'],
      area: 'back',
      assign: LOW,
    })
    expect(other).toContain('used up')
    const task = await eventually(() => pooled(ok, 'task')[0], 'the task at Ok')
    taskId = /task="([^"]+)"/.exec(task.params?.content ?? '')?.[1] as string
    expect(pooled(low, 'task')).toEqual([])
  })

  test('finished, the task goes to the review session, which sends it back with notes', async () => {
    expect(await call(ok, 'task_claim', { task: taskId })).toStartWith('Started.')
    expect(await call(ok, 'task_done', { task: taskId, summary: 'SECRET API done', tests: 'bun test' })).toContain('Sent to review: Rita')
    const brief = await eventually(() => pooled(rev, 'review')[0], 'the review at Rev')
    expect(brief.params?.content).toMatch(/git switch pool\/[a-z0-9]+-items-api/)
    expect(brief.params?.content).toContain('Tests: bun test')
    expect(await call(rev, 'review_reject', { task: taskId, notes: 'SECRET the price is not validated' })).toContain('Sent back')
    const back = await eventually(
      () => pooled(ok, 'task').find(n => n.params?.content?.includes('Sent back by review')),
      'the task back at Ok',
    )
    expect(back.params?.content).toContain('the price is not validated')
    await eventually(
      () => pooled(lead, 'notice').find(n => n.params?.content?.includes('Review sent task')),
      'the notice to the orchestrator',
    )
  })

  test('done again, the reviewer accepts it and it is done for everyone', async () => {
    expect(await call(ok, 'task_claim', { task: taskId })).toStartWith('Started.')
    expect(await call(ok, 'task_done', { task: taskId, summary: 'Validated the price', tests: 'bun test' })).toContain('Sent to review')
    await eventually(() => pooled(rev, 'review').length >= 2, 'the second review')
    expect(await call(rev, 'review_accept', { task: taskId, notes: 'Checked the validation' })).toContain('Accepted')
    const done = await eventually(async () => {
      const item = (await stateOf(owner))?.tasks.find(t => t.id === taskId)
      return item?.task?.state === 'done' && item.task
    }, 'the task done for everyone')
    expect(done.review).toBe('Checked the validation')
    expect(done.completion?.assignee.session).toBe(OK)
    expect(done.completion?.reviewer?.session).toBe(REV)
    const author = apps.find(app => app.accountId === done.completion?.assignee.account)
    const reviewer = apps.find(app => app.accountId === done.completion?.reviewer?.account)
    if (!author || !reviewer) throw new Error('missing reward recipients')
    await eventually(async () => (await new RPGClient(`${base}/api/rpg`, author.token, author.key).read()).state.xp === 50, 'author XP')
    await eventually(
      async () => (await new RPGClient(`${base}/api/rpg`, reviewer.token, reviewer.key).read()).state.xp === 20,
      'reviewer XP',
    )
    await eventually(() => pooled(lead, 'notice').find(n => n.params?.content?.includes('is done by')), 'the done notice')
  })

  test('the relay only ever carried sealed blobs', () => {
    for (const peer of apps) {
      const traffic = peer.raw.join('')
      for (const secret of ['SECRET', 'Items API', '100 % used', 'usedPercent', 'pool/']) expect(traffic).not.toContain(secret)
    }
  })
})
