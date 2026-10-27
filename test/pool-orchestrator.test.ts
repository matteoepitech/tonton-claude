// The orchestrator end to end: a real relay, three accounts and three sessions behind real agents. A Claude Code session
// is the orchestrator, chosen by the pool's owner; it plans in the shared notes, then writes two tasks the rules hand out:
// the small one to the OpenCode session, the large one to the other Claude Code session. The test plays Claude Code (MCP
// clients) and Tonton's OpenCode plugin (the bridge's pipes). The relay only ever carries sealed blobs.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { PluginCommand } from '../agent/src/opencode/bridge'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { RelayClient, type SocketLike } from '../shared/client'
import { newAccountKey, seal } from '../shared/crypto'
import { type PoolState, PoolVault, sealPoolSessionOrder } from '../shared/pool'
import { PoolApi } from '../shared/pool-api'
import { PoolKeyring } from '../shared/pool-keys'
import { formatPoolInvite, parsePoolInvite } from '../shared/pool-link'
import type { PoolSessionProfile, PoolUpdate } from '../shared/pool-protocol'
import { Vault } from '../shared/vault'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const FIXTURE = join(import.meta.dir, '../agent/test/fixtures/opencode-2.0.32.jsonl')
const OPENCODE = 'ses_e872d9012ffeqUp0ZMJp9G4Gx2'
const LEAD = `lead-${Date.now()}`
const WORKER = `worker-${Date.now()}`
const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-lead-'))
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

let owner: App
let front: App
let back: App
let lead: Claude
let worker: Claude
let bridge: ReturnType<typeof Bun.spawn>
const commands: PluginCommand[] = []
let poolId: string
let poolKey: string

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

/** An account with one machine, its app on the client core, and the agent's home folder. */
async function account(name: string): Promise<{ app: App; home: string }> {
  const created = await post('/api/accounts', {})
  const key = newAccountKey()
  const { secret } = await post('/api/account/token', {}, created.token)
  const machine = await post('/api/machines/join', { account: created.accountId, secret, name: await seal(key, { name }) })
  const home = join(dir, name)
  mkdirSync(join(home, 'run'), { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: base, ...machine, key, machine: name, version: '0.9.0' }))
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
  return { app, home }
}

/** A Claude Code session on that machine: a transcript, the hook's run file, and the channel the test talks MCP to. */
async function claudeSession(home: string, sessionId: string, model: string): Promise<Claude> {
  const transcript = join(home, `${sessionId}.jsonl`)
  writeFileSync(
    transcript,
    [
      { sessionId, type: 'user', uuid: 'u1', message: { content: 'hello' } },
      { sessionId, type: 'assistant', uuid: 'a1', message: { model, content: [{ type: 'text', text: 'hi' }] } },
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
  return claude
}

const call = async (claude: Claude, name: string, args: Record<string, unknown> = {}) => {
  const result = (await claude.client.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return result.content[0].text
}

const poolNotices = (claude: Claude, kind: string) =>
  claude.notifications.filter(n => n.params?.meta?.sender === 'pool' && n.params.content?.startsWith(`<pool kind="${kind}"`))

const promptsToOpenCode = () => commands.filter((c): c is Extract<PluginCommand, { op: 'prompt' }> => c.op === 'prompt')

async function stateOf(peer: App): Promise<PoolState | null> {
  const vault = new PoolVault(new PoolKeyring(poolKey, 1))
  let state: PoolState | null = null
  for (const update of peer.updates) {
    if (update.t === 'pool_snapshot') state = await vault.snapshot(update.pool)
    else if (state) state = await vault.apply(state, update)
  }
  return state
}

async function joinSession(app: App, sessionId: string, profile: PoolSessionProfile, autoStart: boolean) {
  const order = await sealPoolSessionOrder(app.key, { poolId, sessionId, key: poolKey, version: 1, autoStart })
  const sealed = await new PoolVault(new PoolKeyring(poolKey, 1)).seal(profile)
  app.client.sendPool({ t: 'pool_join_session', poolId, sessionId, order, profile: sealed })
}

beforeAll(async () => {
  const first = await account('Lead')
  owner = first.app
  lead = await claudeSession(first.home, LEAD, 'claude-opus-5-5')
  const second = await account('Front')
  front = second.app
  bridge = Bun.spawn(['bun', AGENT, 'opencode'], {
    env: { ...process.env, TONTON_HOME: second.home, TONTON_SERVICE: 'off' },
    stdin: 'pipe',
    stdout: 'pipe',
  })
  void (async () => {
    let buffer = ''
    for await (const chunk of bridge.stdout as ReadableStream<Uint8Array>) {
      buffer += new TextDecoder().decode(chunk)
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        commands.push(JSON.parse(buffer.slice(0, newline)))
        buffer = buffer.slice(newline + 1)
      }
    }
  })()
  bridge.stdin.write(readFileSync(FIXTURE, 'utf8'))
  bridge.stdin.flush()
  const third = await account('Back')
  back = third.app
  worker = await claudeSession(third.home, WORKER, 'claude-sonnet-5-5')
  await eventually(() => owner.client.state.sessions.some(s => s.id === LEAD && s.agentOnline), 'the lead session')
  await eventually(() => front.client.state.sessions.some(s => s.id === OPENCODE && s.agentOnline), 'the OpenCode session')
  await eventually(() => back.client.state.sessions.some(s => s.id === WORKER && s.agentOnline), 'the worker session')
}, 40_000)

afterAll(async () => {
  for (const app of [owner, front, back]) app?.client.stop()
  bridge?.kill()
  await lead?.client.close()
  await worker?.client.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('the orchestrator end to end', () => {
  test('three accounts put a session each in the pool; the owner makes its own Claude Code session the orchestrator', async () => {
    const api = new PoolApi({ relay: base, token: owner.token })
    const created = await api.create(owner.key, owner.accountId, { name: 'SECRET hackathon', goal: 'Ship the shop' }, { name: 'Ana' })
    poolId = created.pool.id
    poolKey = created.key
    for (const [app, name] of [
      [front, 'Bob'],
      [back, 'Eve'],
    ] as const) {
      const invite = await api.createInvite(poolId, { uses: 1, hours: 1 })
      const pasted = parsePoolInvite(formatPoolInvite({ relay: base, pool: poolId, token: invite.token, key: poolKey, version: 1 }))
      if (!pasted) throw new Error('the invite does not parse')
      await new PoolApi({ relay: base, token: app.token }).join(app.key, app.accountId, pasted, { name })
    }
    for (const app of [owner, front, back]) app.client.subscribePool(poolId)
    await joinSession(owner, LEAD, { tool: 'claude' }, true)
    await joinSession(front, OPENCODE, { area: 'front', tool: 'opencode' }, true)
    await joinSession(back, WORKER, { area: 'back', tool: 'claude' }, true)
    await eventually(async () => {
      const state = await stateOf(owner)
      return state?.sessions.length === 3 && state.sessions.every(s => s.ready)
    }, 'three sessions ready')

    expect((await lead.client.listTools()).tools.map(t => t.name)).not.toContain('plan_create')
    owner.client.sendPool({ t: 'pool_orchestrator', poolId, orchestrator: { account: owner.accountId, session: LEAD } })
    await eventually(async () => (await lead.client.listTools()).tools.some(t => t.name === 'plan_create'), 'the planning tools')
    const role = await eventually(() => poolNotices(lead, 'role')[0], 'the guide')
    expect(role.params?.content).toContain('Never single steps')
    // The others are no orchestrators: the tools answer them so.
    expect(await call(worker, 'task_create', { title: 'x', goal: 'x', criteria: ['x'] })).toContain("Only the pool's orchestrator")
  })

  test('it plans in the notes, and every worker hears of them without their text', async () => {
    const said = await call(lead, 'plan_create', {
      goal: 'SECRET a small shop',
      contracts: 'GET /v1/items returns [{id, name, price}]',
      stack: 'Bun, React',
      areas: ['front: web/', 'back: api/'],
    })
    expect(said).toContain('The plan is in the notes')
    const toWorker = await eventually(() => poolNotices(worker, 'notes')[0], 'the notes notice in Claude Code')
    expect(toWorker.params?.content).toContain('goal, stack, contracts, 2 areas')
    expect(toWorker.params?.content).not.toContain('SECRET')
    await eventually(() => promptsToOpenCode().find(p => p.text.startsWith('<pool kind="notes"')), 'the notes notice in OpenCode')
  })

  test('the small task goes to OpenCode and the large one to the other Claude Code, each on its own branch', async () => {
    const small = await call(lead, 'task_create', {
      title: 'Item list page',
      goal: 'The page that lists the items from GET /v1/items, following the existing page pattern',
      criteria: ['shows every item', 'its tests pass'],
      area: 'front',
      size: 'small',
      assign: 'auto',
    })
    expect(small).toContain('Assigned to Bob · front')
    const large = await call(lead, 'task_create', {
      title: 'Items API',
      goal: 'GET /v1/items with its storage, validation and tests, as the contracts say',
      criteria: ['the contract holds', 'its tests pass'],
      area: 'back',
      assign: 'auto',
    })
    expect(large).toContain('Assigned to Eve · back')

    const toOpenCode = await eventually(() => promptsToOpenCode().find(p => p.text.startsWith('<pool kind="task"')), 'the task in OpenCode')
    expect(toOpenCode.text).toContain('from="Ana · orchestrator"')
    expect(toOpenCode.text).toContain('Its area owns: web/')
    expect(toOpenCode.text).toMatch(/git switch pool\/[a-z0-9]+-item-list-page/)
    const toWorker = await eventually(() => poolNotices(worker, 'task')[0], 'the task in Claude Code')
    const id = /task="([^"]+)"/.exec(toWorker.params?.content ?? '')?.[1] as string
    expect(toWorker.params?.content).toContain('Start it: call task_claim')

    expect(await call(worker, 'task_claim', { task: id })).toStartWith('Started.')
    expect(await call(worker, 'task_done', { task: id, summary: 'SECRET API done' })).toContain('which tests')
    expect(await call(worker, 'task_done', { task: id, summary: 'SECRET API done', tests: 'bun test' })).toBe('Done: the pool sees it.')
    const notice = await eventually(
      () => poolNotices(lead, 'notice').find(n => n.params?.content?.includes('is done by')),
      'the done notice',
    )
    expect(notice.params?.content).toContain('Items API')
    const done = await eventually(async () => {
      const item = (await stateOf(front))?.tasks.find(t => t.id === id)
      return item?.task?.state === 'done' && item.task
    }, 'the task done for everyone')
    expect(done.branch).toMatch(/^pool\/[a-z0-9]+-items-api$/)
    expect(JSON.parse(await call(lead, 'pool_overview')).sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ session: OPENCODE, tool: 'opencode', takes: 'small', free: false }),
        expect.objectContaining({ session: WORKER, tool: 'claude', takes: 'large', free: true }),
      ]),
    )
  })

  test('the relay only ever carried sealed blobs', () => {
    for (const peer of [owner, front, back]) {
      const traffic = peer.raw.join('')
      for (const secret of ['SECRET', 'Item list page', 'GET /v1/items', 'web/', 'pool/']) expect(traffic).not.toContain(secret)
    }
  })
})
