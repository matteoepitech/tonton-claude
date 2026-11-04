// Cluster tools end to end: a real relay, a Claude Code session behind a real agent channel and an OpenCode session behind
// a real bridge, on two accounts and two machines, in one cluster each owner put its own session in. The test plays
// Claude Code (an MCP client) and Tonton's OpenCode plugin (the bridge's pipes), and the Claude in each: they ask and
// answer each other, a digest waits for the next prompt, a muted session gets nothing, and the relay sees none of it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { PluginCommand } from '../agent/src/opencode/bridge'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { RelayClient, type SocketLike } from '../shared/client'
import { type ClusterState, ClusterVault, sealClusterSessionOrder } from '../shared/cluster'
import { ClusterApi } from '../shared/cluster-api'
import { clusterInviteLink, parseClusterInvite } from '../shared/cluster-link'
import type { ClusterDelivery, ClusterUpdate } from '../shared/cluster-protocol'
import { newAccountKey, seal } from '../shared/crypto'
import { Vault } from '../shared/vault'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const FIXTURE = join(import.meta.dir, '../agent/test/fixtures/opencode-2.0.32.jsonl')
const OPENCODE = 'ses_e872d9012ffeqUp0ZMJp9G4Gx2'
const CLAUDE = `session-${Date.now()}`
/** Written into everything sealed: it must never be found in the relay's files. */
const MARKER = `marker-${Date.now()}-hand-socket`
const dir = mkdtempSync(join(tmpdir(), 'tonton-cluster-tools-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`

interface App {
  accountId: string
  token: string
  key: string
  home: string
  client: RelayClient
  updates: ClusterUpdate[]
}

let ana: App
let bob: App
let claude: Client
const notifications: { method: string; params?: { content?: string; meta?: { sender?: string } } }[] = []
let bridge: ReturnType<typeof Bun.spawn>
const commands: PluginCommand[] = []
let clusterId: string
let clusterKey: string

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
async function account(name: string): Promise<App> {
  const created = await post('/api/accounts', {})
  const key = newAccountKey()
  const { secret } = await post('/api/account/token', {}, created.token)
  const machine = await post('/api/machines/join', { account: created.accountId, secret, name: await seal(key, { name }) })
  const home = join(dir, name)
  mkdirSync(join(home, 'run'), { recursive: true })
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ server: base, ...machine, account: created.accountId, key, machine: name, version: '0.9.0' }),
  )
  const app: App = { accountId: created.accountId, token: created.token, key, home, updates: [], client: undefined as never }
  app.client = new RelayClient({
    vault: new Vault(key),
    connect: () =>
      new WebSocket(`${base.replace('http', 'ws')}/ws/app`, {
        headers: { authorization: `Bearer ${created.token}` },
      } as never) as unknown as SocketLike,
    onChange: () => {},
    onClusterUpdate: update => app.updates.push(update),
  })
  app.client.start()
  await eventually(() => app.client.state.connection === 'connected', `${name}'s app`)
  return app
}

async function stateOf(app: App): Promise<ClusterState | null> {
  const vault = new ClusterVault(clusterKey)
  let state: ClusterState | null = null
  for (const update of app.updates) {
    if (update.t === 'cluster_snapshot' && update.cluster.id === clusterId) state = await vault.snapshot(update.cluster)
    else if (state) state = await vault.apply(state, update)
  }
  return state
}

/** The owner puts its own session in, from its app, with an order only its agent opens. */
async function putIn(app: App, sessionId: string, tool: 'claude' | 'opencode', delivery?: ClusterDelivery) {
  const order = await sealClusterSessionOrder(app.key, {
    clusterId,
    sessionId,
    key: clusterKey,
    version: 1,
    ...(delivery ? { delivery } : {}),
  })
  app.client.sendCluster({
    t: 'cluster_join_session',
    clusterId,
    sessionId,
    order,
    profile: await new ClusterVault(clusterKey).seal({ name: `${tool} session`, tool }),
  })
}

/** Plays Tonton's OpenCode plugin: a tool OpenCode called, and the bridge's answer. */
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
  return result.content[0]?.text ?? ''
}

const injected = () => commands.filter((c): c is Extract<PluginCommand, { op: 'inject' }> => c.op === 'inject')
const fromCluster = () => notifications.filter(n => n.params?.meta?.sender === 'cluster').map(n => n.params?.content ?? '')
const askId = (text: string) => /reply_to "([\w-]+)"/.exec(text)?.[1]

beforeAll(async () => {
  // Claude Code, on Ana's Mac.
  ana = await account('Mac')
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
  // What the hooks write: Claude is between turns.
  writeFileSync(
    join(ana.home, 'run', `${process.pid}.json`),
    JSON.stringify({ sessionId: CLAUDE, transcriptPath: transcript, cwd: '/home/ana/game', event: 'Stop', permissionMode: 'default' }),
  )
  claude = new Client({ name: 'claude-code', version: 'test' })
  claude.fallbackNotificationHandler = async notification => {
    notifications.push(notification as (typeof notifications)[number])
  }
  const claudeEnv = { ...process.env, TONTON_HOME: ana.home, TONTON_CHANNEL: '1', TONTON_SERVICE: 'off' } as Record<string, string>
  await claude.connect(new StdioClientTransport({ command: 'bun', args: [AGENT, 'channel'], env: claudeEnv }))

  // OpenCode, on Bob's Linux machine.
  bob = await account('Linux')
  bridge = Bun.spawn(['bun', AGENT, 'opencode'], {
    env: { ...process.env, TONTON_HOME: bob.home, TONTON_SERVICE: 'off' },
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
  await eventually(() => ana.client.state.sessions.some(s => s.id === CLAUDE && s.agentOnline), 'the Claude Code session')
  await eventually(() => bob.client.state.sessions.some(s => s.id === OPENCODE && s.agentOnline), 'the OpenCode session')
}, 30_000)

afterAll(async () => {
  ana?.client.stop()
  bob?.client.stop()
  bridge?.kill()
  await claude?.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('cluster tools end to end', () => {
  test('each owner puts its own session in', async () => {
    const api = new ClusterApi({ relay: base, token: ana.token })
    const created = await api.create(ana.key, ana.accountId, { name: `Jam ${MARKER}` }, { name: 'Ana' })
    clusterId = created.cluster.id
    clusterKey = created.key
    const invite = await api.createInvite(clusterId, { uses: 1, hours: 1 })
    const pasted = parseClusterInvite(
      clusterInviteLink({ relay: base, cluster: clusterId, token: invite.token, key: clusterKey, version: 1 }),
    )
    if (!pasted) throw new Error('the invite does not parse')
    await new ClusterApi({ relay: base, token: bob.token }).join(bob.key, bob.accountId, pasted, { name: 'Bob' })
    ana.client.subscribeCluster(clusterId)
    bob.client.subscribeCluster(clusterId)
    await eventually(
      () => ana.updates.some(u => u.t === 'cluster_snapshot') && bob.updates.some(u => u.t === 'cluster_snapshot'),
      'snapshots',
    )

    await putIn(ana, CLAUDE, 'claude')
    await putIn(bob, OPENCODE, 'opencode')
    await eventually(async () => {
      const state = await stateOf(ana)
      return state?.sessions.length === 2 && state.sessions.every(s => s.ready)
    }, 'both sessions ready')
  })

  test('both get the cluster tools, and cluster_who shows each session with its tool and model', async () => {
    await eventually(
      async () => (await claude.listTools()).tools.some(tool => tool.name === 'cluster_ask'),
      'the cluster tools in Claude Code',
    )
    const who = await eventually(async () => {
      const read = JSON.parse(await callClaude('cluster_who'))
      const sessions = read.members.flatMap((m: { sessions: { model?: string }[] }) => m.sessions)
      // Each agent says what its session runs on, after the profile its owner gave it.
      return sessions.length === 2 && sessions.every((s: { machine?: string }) => s.machine) && read
    }, 'both sessions described')
    const sessions = Object.fromEntries(
      who.members.flatMap((m: { name: string; sessions: { session: string }[] }) =>
        m.sessions.map(s => [s.session, { ...s, member: m.name }]),
      ),
    )
    expect(sessions[CLAUDE]).toMatchObject({
      member: 'Ana',
      tool: 'claude',
      machine: 'Mac',
      model: 'claude-opus-5-5',
      project: 'game',
      you: true,
    })
    expect(sessions[OPENCODE]).toMatchObject({ member: 'Bob', tool: 'opencode', machine: 'Linux' })
    // The same tools answer OpenCode. The pool tools stay apart: the session is in no pool.
    expect(JSON.parse(await openCodeTool('cluster_who', {})).id).toBe(clusterId)
    expect(await callClaude('pool_status')).toBe('This session is not in a pool.')
  })

  test('Claude Code asks OpenCode, which answers: the answer is the result of the ask', async () => {
    const asking = callClaude('cluster_ask', { to_session: OPENCODE, text: `Which socket holds the sword? ${MARKER}` })
    const ask = await eventually(() => injected().find(c => c.text.includes('Which socket holds the sword?')), 'the ask in OpenCode')
    // A synthetic part that wakes the idle session, never the user's text.
    expect(ask).toMatchObject({ sessionID: OPENCODE, wake: true })
    expect(ask.text).toStartWith('<cluster kind="ask" from="Ana · Mac · claude"')
    expect(commands.some(c => c.op === 'prompt' && c.text.includes('Which socket'))).toBe(false)
    const id = askId(ask.text)
    expect(await openCodeTool('cluster_send', { text: `hand_r ${MARKER}`, reply_to: id })).toStartWith('Sent')
    expect(JSON.parse(await asking)).toMatchObject({ answer: `hand_r ${MARKER}`, from: 'Bob · Linux · opencode' })
    // The answer came as the result: not a second time as a post.
    await Bun.sleep(300)
    expect(fromCluster().some(text => text.includes('hand_r'))).toBe(false)
  })

  test('OpenCode asks Claude Code, which answers through the channel', async () => {
    const callID = `call-${Math.random()}`
    bridge.stdin.write(
      `${JSON.stringify({ type: 'tonton.tool', data: { callID, sessionID: OPENCODE, name: 'cluster_ask', args: { to_session: CLAUDE, text: 'Is the API frozen?' } } })}\n`,
    )
    bridge.stdin.flush()
    const ask = await eventually(() => fromCluster().find(text => text.includes('Is the API frozen?')), 'the ask in Claude Code')
    expect(ask).toStartWith('<cluster kind="ask" from="Bob · Linux · opencode"')
    expect(await callClaude('cluster_send', { text: 'Yes, v1 is frozen.', reply_to: askId(ask) })).toStartWith('Sent')
    const result = await eventually(
      () => commands.find(c => c.op === 'tool_result' && c.callID === callID) as Extract<PluginCommand, { op: 'tool_result' }> | undefined,
      'the answer in OpenCode',
    )
    expect(JSON.parse(result.output)).toMatchObject({ answer: 'Yes, v1 is frozen.', from: 'Ana · Mac · claude' })
  })

  test('digest: what comes waits for the next prompt, and the hook hands it to Claude', async () => {
    const before = fromCluster().length
    await putIn(ana, CLAUDE, 'claude', 'digest')
    await eventually(async () => {
      const state = await stateOf(ana)
      return state?.sessions.find(s => s.session === CLAUDE)?.ready
    }, 'the new order taken')
    await Bun.sleep(300)
    expect(await openCodeTool('cluster_send', { text: `The rig is pushed ${MARKER}`, to_session: CLAUDE })).toStartWith('Sent')
    const folder = join(ana.home, 'run', 'cluster-digest', CLAUDE)
    await eventually(
      () =>
        readdirSync(folder, { withFileTypes: false }).some(file => readFileSync(join(folder, file), 'utf8').includes('The rig is pushed')),
      'the post kept',
    )
    expect(fromCluster()).toHaveLength(before)
    const hook = Bun.spawn(['bun', AGENT, 'hook'], {
      env: { ...process.env, TONTON_HOME: ana.home, TONTON_SERVICE: 'off' },
      stdin: new Blob([JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: CLAUDE, prompt: 'go on' })]),
      stdout: 'pipe',
    })
    const output = JSON.parse(await new Response(hook.stdout).text())
    expect(output.hookSpecificOutput.additionalContext).toContain('The rig is pushed')
    expect(output.hookSpecificOutput.additionalContext).toContain('<cluster kind="message" from="Bob · Linux · opencode"')
  })

  test('muted: the session receives nothing, not even at its next prompt', async () => {
    await putIn(bob, OPENCODE, 'opencode', 'muted')
    await Bun.sleep(500)
    const before = injected().length
    expect(await callClaude('cluster_send', { text: `Anyone there? ${MARKER}`, to_session: OPENCODE })).toStartWith('Sent')
    await eventually(async () => (await stateOf(bob))?.posts.some(p => p.body?.text.startsWith('Anyone there?')), 'the post on the relay')
    // A new turn of OpenCode would get a digest: there is none.
    bridge.stdin.write(`${JSON.stringify({ type: 'session.status', properties: { sessionID: OPENCODE, status: { type: 'busy' } } })}\n`)
    bridge.stdin.flush()
    await Bun.sleep(500)
    expect(injected()).toHaveLength(before)
    // Its Claude can still read it, when its user asks.
    expect(await openCodeTool('cluster_inbox', {})).toContain('Anyone there?')
  })

  test('the relay holds none of it', () => {
    const files = readdirSync(join(dir, 'data')).map(name => readFileSync(join(dir, 'data', name)).toString('latin1'))
    expect(files.length).toBeGreaterThan(0)
    for (const content of files) expect(content.includes(MARKER)).toBe(false)
  })
})
