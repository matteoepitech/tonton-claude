// Pool safety end to end (docs/pools.md, Control): a real relay, a real Claude Code channel and a real OpenCode bridge
// on two accounts. A paused pool holds a task back, a stop interrupts a session and takes it out, and a rule the owner
// proposes is applied only once the machine owner accepted it for its session, for Claude Code and OpenCode alike.
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
import { newPoolItemId, type PoolState, PoolVault, sealPoolRulesAcceptance, sealPoolSessionOrder } from '../shared/pool'
import { PoolApi } from '../shared/pool-api'
import { PoolKeyring } from '../shared/pool-keys'
import { formatPoolInvite, parsePoolInvite } from '../shared/pool-link'
import type { PoolRules, PoolTask, PoolUpdate } from '../shared/pool-protocol'
import { Vault } from '../shared/vault'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const FIXTURE = join(import.meta.dir, '../agent/test/fixtures/opencode-2.0.32.jsonl')
const OPENCODE = 'ses_e872d9012ffeqUp0ZMJp9G4Gx2'
const CLAUDE = `session-${Date.now()}`
const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-safety-'))
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
let claudeHome: string

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
  claudeHome = first.home
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

const vault = () => new PoolVault(new PoolKeyring(poolKey, 1))

/** What the Claude Code session's PermissionRequest hook prints for a command: an approval, or nothing. */
async function hookAsks(command: string): Promise<string> {
  const input = { hook_event_name: 'PermissionRequest', session_id: CLAUDE, tool_name: 'Bash', tool_input: { command } }
  const env = { ...process.env, TONTON_HOME: claudeHome, TONTON_SERVICE: 'off' } as Record<string, string>
  const hook = Bun.spawn(['bun', AGENT, 'hook'], { env, stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe' })
  return new Response(hook.stdout).text()
}

/** OpenCode asks before running a command: the bridge answers it by a rule, or shows the request in the notch. */
function openCodeAsks(id: string, command: string) {
  const event = {
    id: `evt_${id}`,
    created: Date.now(),
    type: 'permission.asked',
    data: { sessionID: OPENCODE, id, action: 'shell', resources: [command], source: { type: 'tool', id: `call_${id}` } },
  }
  bridge.stdin.write(`${JSON.stringify(event)}\n`)
  bridge.stdin.flush()
}

const replied = (id: string) => commands.find(c => c.op === 'reply' && c.requestID === id)

describe('pool safety end to end', () => {
  test('both sessions join one pool, each from its own account', async () => {
    const api = new PoolApi({ relay: base, token: back.token })
    const created = await api.create(back.key, back.accountId, { name: 'Hackathon' }, { name: 'Ana' })
    poolId = created.pool.id
    poolKey = created.key
    const invite = await api.createInvite(poolId, { uses: 1, hours: 1 })
    const pasted = parsePoolInvite(formatPoolInvite({ relay: base, pool: poolId, token: invite.token, key: poolKey, version: 1 }))
    if (!pasted) throw new Error('the invite does not parse')
    await new PoolApi({ relay: base, token: front.token }).join(front.key, front.accountId, pasted, { name: 'Bob' })
    back.client.subscribePool(poolId)
    front.client.subscribePool(poolId)
    const claudeOrder = await sealPoolSessionOrder(back.key, { poolId, sessionId: CLAUDE, key: poolKey, version: 1, autoStart: true })
    back.client.sendPool({
      t: 'pool_join_session',
      poolId,
      sessionId: CLAUDE,
      order: claudeOrder,
      profile: await vault().seal({ area: 'back' }),
    })
    const openCodeOrder = await sealPoolSessionOrder(front.key, { poolId, sessionId: OPENCODE, key: poolKey, version: 1, autoStart: true })
    front.client.sendPool({
      t: 'pool_join_session',
      poolId,
      sessionId: OPENCODE,
      order: openCodeOrder,
      profile: await vault().seal({ area: 'front', tool: 'opencode' }),
    })
    await eventually(async () => {
      const state = await stateOf(back)
      return state?.sessions.length === 2 && state.sessions.every(s => s.ready)
    }, 'both sessions ready')
  })

  test('a paused pool holds a task back from its session, and hands it over when it resumes', async () => {
    back.client.sendPool({ t: 'pool_pause', poolId, paused: true })
    await eventually(async () => (await stateOf(front))?.paused, 'the pause')
    const id = newPoolItemId()
    const task: PoolTask = {
      title: 'Login page',
      state: 'assigned',
      area: 'front',
      assignee: { account: front.accountId, session: OPENCODE },
    }
    back.client.sendPool({ t: 'pool_task', poolId, id, rev: 0, blob: await vault().seal(task) })
    await eventually(async () => (await stateOf(front))?.tasks.some(t => t.id === id), 'the task, seen by the apps')
    await Bun.sleep(500)
    expect(promptsToOpenCode().some(p => p.text.includes(`task="${id}"`))).toBe(false)
    expect(await openCodeTool('task_claim', { task: id })).toContain('paused')

    back.client.sendPool({ t: 'pool_pause', poolId, paused: false })
    await eventually(() => promptsToOpenCode().find(p => p.text.includes(`task="${id}"`)), 'the task in OpenCode once resumed')
    const log = (await stateOf(front))?.audit.map(line => line.action) ?? []
    expect(log).toEqual(expect.arrayContaining(['paused', 'resumed']))
  })

  test('a proposed rule is applied only where the machine owner accepted it, for Claude Code and OpenCode', async () => {
    const rules: PoolRules = {
      rules: [
        { tool: 'Bash', pattern: 'make deploy' },
        { tool: 'Bash', pattern: 'make deploy *' },
      ],
      note: 'deploys',
    }
    back.client.sendPool({ t: 'pool_rules', poolId, rev: 0, blob: await vault().seal(rules) })
    await eventually(async () => (await stateOf(back))?.rules?.value?.rules.length === 2, 'the proposal')
    // Proposed is not accepted: both sessions still ask.
    expect(await hookAsks('make deploy --prod')).toBe('')
    openCodeAsks('per_before', 'make deploy --prod')
    await Bun.sleep(500)
    expect(replied('per_before')).toBeUndefined()

    // The pool's owner does not own the OpenCode machine: its acceptance for that session is refused.
    const forged = await sealPoolRulesAcceptance(back.key, { poolId, sessionId: OPENCODE, rev: 1, rules: rules.rules })
    back.client.sendPool({ t: 'pool_accept_rules', poolId, sessionId: OPENCODE, rev: 1, acceptance: forged })

    // Each machine owner accepts for its own session.
    const forClaude = await sealPoolRulesAcceptance(back.key, { poolId, sessionId: CLAUDE, rev: 1, rules: rules.rules })
    back.client.sendPool({ t: 'pool_accept_rules', poolId, sessionId: CLAUDE, rev: 1, acceptance: forClaude })
    await eventually(async () => (await hookAsks('make deploy --prod')) !== '', 'the Claude Code hook to approve')
    expect(JSON.parse(await hookAsks('make deploy --staging'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
    expect(await hookAsks('make clean')).toBe('')
    expect(await hookAsks('make deploy && rm -rf ~')).toBe('')

    openCodeAsks('per_refused', 'make deploy --prod')
    await Bun.sleep(500)
    expect(replied('per_refused')).toBeUndefined()
    const forOpenCode = await sealPoolRulesAcceptance(front.key, { poolId, sessionId: OPENCODE, rev: 1, rules: rules.rules })
    front.client.sendPool({ t: 'pool_accept_rules', poolId, sessionId: OPENCODE, rev: 1, acceptance: forOpenCode })
    await eventually(
      async () => (await stateOf(back))?.sessions.find(s => s.session === OPENCODE)?.accepted === 1,
      'accepted, as the pool sees it',
    )
    openCodeAsks('per_after', 'make deploy --prod')
    expect(await eventually(() => replied('per_after'), 'the automatic reply')).toMatchObject({ decision: 'once' })
    const log = (await stateOf(back))?.audit.filter(line => line.action === 'rules_accepted') ?? []
    expect(log.map(line => line.target?.session).sort()).toEqual([CLAUDE, OPENCODE].sort())
  })

  test('a stop interrupts the OpenCode turn and takes both sessions out of the pool', async () => {
    const before = commands.filter(c => c.op === 'interrupt').length
    back.client.sendPool({ t: 'pool_stop', poolId, target: { account: front.accountId, session: OPENCODE } })
    await eventually(() => commands.filter(c => c.op === 'interrupt' && c.sessionID === OPENCODE).length > before, 'the interrupt')
    await eventually(async () => (await stateOf(back))?.sessions.length === 1, 'the OpenCode session out')
    expect(await openCodeTool('pool_status', {})).toBe('This session is not in a pool.')

    // The Claude Code session is still in, with its tools.
    expect(JSON.parse(await callClaude('pool_status')).pool).toBe('Hackathon')
    back.client.sendPool({ t: 'pool_stop', poolId, target: null })
    await eventually(async () => (await stateOf(back))?.sessions.length === 0, 'every session out')
    // Out of the pool, its accepted rules no longer apply.
    await eventually(async () => (await hookAsks('make deploy --prod')) === '', 'the pool rules gone')
    const { tools } = await claude.listTools()
    expect(tools.some(tool => tool.name.startsWith('pool_'))).toBe(false)
  })

  test('the relay only ever carried sealed rules', () => {
    for (const peer of [back, front]) expect(peer.raw.join('')).not.toContain('make deploy')
  })
})
