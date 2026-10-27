// Pool tools end to end: a real relay, a Claude Code session behind a real agent channel and an OpenCode session behind a
// real bridge, on two accounts and two machines, in one pool. The test plays Claude Code (an MCP client) and Tonton's
// OpenCode plugin (the bridge's pipes). Messages go both ways, either session takes and finishes a task, and the relay
// only ever carries sealed blobs.
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
import { newPoolItemId, type PoolState, PoolVault, sealPoolSessionOrder } from '../shared/pool'
import { PoolApi } from '../shared/pool-api'
import { PoolKeyring } from '../shared/pool-keys'
import { formatPoolInvite, parsePoolInvite } from '../shared/pool-link'
import type { PoolTask, PoolUpdate } from '../shared/pool-protocol'
import { Vault } from '../shared/vault'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const FIXTURE = join(import.meta.dir, '../agent/test/fixtures/opencode-2.0.32.jsonl')
const OPENCODE = 'ses_e872d9012ffeqUp0ZMJp9G4Gx2'
const CLAUDE = `session-${Date.now()}`
const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-tools-'))
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

let back: App
let front: App
let claude: Client
const notifications: { method: string; params?: { content?: string; meta?: { sender?: string } } }[] = []
let bridge: ReturnType<typeof Bun.spawn>
const commands: PluginCommand[] = []
let poolId: string
let poolKey: string

async function eventually<T>(read: () => T | undefined | false | Promise<T | undefined | false>, label: string): Promise<T> {
  for (let i = 0; i < 160; i++) {
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
  const app: App = {
    accountId: created.accountId,
    token: created.token,
    key,
    updates: [],
    raw: [],
    client: undefined as unknown as RelayClient,
  }
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

async function stateOf(peer: App): Promise<PoolState | null> {
  const vault = new PoolVault(new PoolKeyring(poolKey, 1))
  let state: PoolState | null = null
  for (const update of peer.updates) {
    if (update.t === 'pool_snapshot') state = await vault.snapshot(update.pool)
    else if (state) state = await vault.apply(state, update)
  }
  return state
}

/** Plays Tonton's OpenCode plugin: a pool tool OpenCode called, and the bridge's answer. */
async function openCodeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const callID = `call-${Math.random()}`
  bridge.stdin.write(`${JSON.stringify({ type: 'tonton.tool', data: { callID, sessionID: OPENCODE, name, args } })}\n`)
  bridge.stdin.flush()
  const result = await eventually(
    () => commands.find(c => c.op === 'tool_result' && c.callID === callID) as Extract<PluginCommand, { op: 'tool_result' }> | undefined,
    `the answer to ${name}`,
  )
  return result.output
}

const callClaude = async (name: string, args: Record<string, unknown> = {}) => {
  const result = (await claude.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return result.content[0].text
}

const promptsToOpenCode = () => commands.filter((c): c is Extract<PluginCommand, { op: 'prompt' }> => c.op === 'prompt')

beforeAll(async () => {
  // Claude Code, on the back end, on the first account's machine.
  const first = await account('Mac')
  back = first.app
  const transcript = join(dir, 'transcript.jsonl')
  writeFileSync(
    transcript,
    [
      { sessionId: CLAUDE, type: 'user', uuid: 'u1', message: { content: 'hello' } },
      { sessionId: CLAUDE, type: 'assistant', uuid: 'a1', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }] } },
    ]
      .map(line => JSON.stringify(line))
      .join('\n')
      .concat('\n'),
  )
  writeFileSync(
    join(first.home, 'run', `${process.pid}.json`),
    JSON.stringify({ sessionId: CLAUDE, transcriptPath: transcript, cwd: '/home/a/shop' }),
  )
  claude = new Client({ name: 'claude-code', version: 'test' })
  claude.fallbackNotificationHandler = async notification => {
    notifications.push(notification as (typeof notifications)[number])
  }
  const claudeEnv = { ...process.env, TONTON_HOME: first.home, TONTON_CHANNEL: '1', TONTON_SERVICE: 'off' } as Record<string, string>
  await claude.connect(new StdioClientTransport({ command: 'bun', args: [AGENT, 'channel'], env: claudeEnv }))

  // OpenCode, on the front end, on the second account's machine.
  const second = await account('Linux')
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
  await eventually(() => back.client.state.sessions.some(s => s.id === CLAUDE && s.agentOnline), 'the Claude Code session')
  await eventually(() => front.client.state.sessions.some(s => s.id === OPENCODE && s.agentOnline), 'the OpenCode session')
}, 30_000)

afterAll(async () => {
  back?.client.stop()
  front?.client.stop()
  bridge?.kill()
  await claude?.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('pool tools end to end', () => {
  test('both sessions join one pool, each from its own account', async () => {
    const api = new PoolApi({ relay: base, token: back.token })
    const created = await api.create(back.key, back.accountId, { name: 'SECRET hackathon', goal: 'Ship the app' }, { name: 'Ana' })
    poolId = created.pool.id
    poolKey = created.key
    const invite = await api.createInvite(poolId, { uses: 1, hours: 1 })
    const pasted = parsePoolInvite(formatPoolInvite({ relay: base, pool: poolId, token: invite.token, key: poolKey, version: 1 }))
    if (!pasted) throw new Error('the invite does not parse')
    await new PoolApi({ relay: base, token: front.token }).join(front.key, front.accountId, pasted, { name: 'Bob' })
    back.client.subscribePool(poolId)
    front.client.subscribePool(poolId)

    const vault = new PoolVault(new PoolKeyring(poolKey, 1))
    // The Claude Code session's owner lets it start pool tasks at once; the OpenCode one asks first.
    const claudeOrder = await sealPoolSessionOrder(back.key, { poolId, sessionId: CLAUDE, key: poolKey, version: 1, autoStart: true })
    back.client.sendPool({
      t: 'pool_join_session',
      poolId,
      sessionId: CLAUDE,
      order: claudeOrder,
      profile: await vault.seal({ area: 'back', tool: 'claude' }),
    })
    const openCodeOrder = await sealPoolSessionOrder(front.key, { poolId, sessionId: OPENCODE, key: poolKey, version: 1 })
    front.client.sendPool({
      t: 'pool_join_session',
      poolId,
      sessionId: OPENCODE,
      order: openCodeOrder,
      profile: await vault.seal({ area: 'front', tool: 'opencode' }),
    })
    await eventually(async () => {
      const state = await stateOf(back)
      return state?.sessions.length === 2 && state.sessions.every(s => s.ready)
    }, 'both sessions ready')
  })

  test('Claude Code gets the pool tools, and pool_status shows each session with its tool and model', async () => {
    const { tools } = await claude.listTools()
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['pool_status', 'task_claim', 'task_done', 'pool_send']))
    const status = await eventually(async () => {
      const read = JSON.parse(await callClaude('pool_status'))
      return read.sessions.every((s: { model?: string }) => s.model) && read
    }, 'both sessions described')
    const sessions = Object.fromEntries(status.sessions.map((s: { session: string }) => [s.session, s]))
    expect(sessions[CLAUDE]).toMatchObject({ member: 'Ana', area: 'back', tool: 'claude', model: 'claude-opus-5-5', you: true })
    expect(sessions[OPENCODE]).toMatchObject({ member: 'Bob', area: 'front', tool: 'opencode' })
    // The same tools answer OpenCode.
    expect(JSON.parse(await openCodeTool('pool_status', {})).sessions).toHaveLength(2)
  })

  test('a message from Claude Code reaches the OpenCode session, and back', async () => {
    expect(await callClaude('pool_send', { text: 'SECRET the API is at /v1', to_session: OPENCODE })).toBe('Sent.')
    const received = await eventually(
      () => promptsToOpenCode().find(p => p.text.includes('SECRET the API is at /v1')),
      'the message in OpenCode',
    )
    expect(received.sessionID).toBe(OPENCODE)
    expect(received.text).toStartWith('<pool kind="message" from="Ana · back"')

    expect(await openCodeTool('pool_send', { text: 'SECRET the page is ready', to_area: 'back' })).toBe('Sent.')
    const answer = await eventually(
      () => notifications.find(n => n.method === 'notifications/claude/channel' && n.params?.content?.includes('SECRET the page is ready')),
      'the answer in Claude Code',
    )
    expect(answer.params?.meta?.sender).toBe('pool')
    expect(answer.params?.content).toContain('from="Bob · front"')
  })

  test('a task handed to the OpenCode session: it asks the user first, then claims and finishes it', async () => {
    const id = newPoolItemId()
    const task: PoolTask = {
      title: 'SECRET login page',
      state: 'assigned',
      area: 'front',
      assignee: { account: front.accountId, session: OPENCODE },
    }
    back.client.sendPool({ t: 'pool_task', poolId, id, rev: 0, blob: await new PoolVault(new PoolKeyring(poolKey, 1)).seal(task) })
    const delivered = await eventually(() => promptsToOpenCode().find(p => p.text.includes(`task="${id}"`)), 'the task in OpenCode')
    expect(delivered.text).toContain('Do not start it yet')
    expect(await openCodeTool('task_claim', { task: id })).toStartWith('Started.')
    expect(await openCodeTool('task_done', { task: id, summary: 'Page done', branch: 'feat/login' })).toContain('which tests')
    expect(await openCodeTool('task_done', { task: id, summary: 'Page done', branch: 'feat/login', tests: 'bun test' })).toBe(
      'Done: the pool sees it.',
    )
    const done = await eventually(async () => {
      const item = (await stateOf(back))?.tasks.find(t => t.id === id)
      return item?.task?.state === 'done' && item.task
    }, 'the task done for the other account')
    expect(done).toMatchObject({ summary: 'Page done\n\nTests: bun test', branch: 'feat/login', assignee: { session: OPENCODE } })
  })

  test('a task handed to the Claude Code session: it starts at once, as its owner chose', async () => {
    const id = newPoolItemId()
    const task: PoolTask = {
      title: 'SECRET sessions API',
      state: 'assigned',
      area: 'back',
      assignee: { account: back.accountId, session: CLAUDE },
    }
    front.client.sendPool({ t: 'pool_task', poolId, id, rev: 0, blob: await new PoolVault(new PoolKeyring(poolKey, 1)).seal(task) })
    const delivered = await eventually(
      () => notifications.find(n => n.params?.meta?.sender === 'pool' && n.params?.content?.includes(`task="${id}"`)),
      'the task in Claude Code',
    )
    expect(delivered.params?.content).toContain('Start it: call task_claim')
    expect(await callClaude('task_claim', { task: id })).toStartWith('Started.')
    expect(await callClaude('task_done', { task: id, summary: 'API done', tests: 'bun test' })).toContain('which branch')
    expect(await callClaude('task_done', { task: id, summary: 'API done', tests: 'bun test', branch: 'feat/sessions-api' })).toBe(
      'Done: the pool sees it.',
    )
    await eventually(async () => (await stateOf(front))?.tasks.find(t => t.id === id)?.task?.state === 'done', 'the task done')
  })

  test('the relay only ever carried sealed blobs', () => {
    for (const peer of [back, front]) {
      const traffic = peer.raw.join('')
      for (const secret of ['SECRET', 'hackathon', 'Ship the app', 'feat/login', 'Page done']) expect(traffic).not.toContain(secret)
    }
  })
})
