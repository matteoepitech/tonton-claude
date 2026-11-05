// The game jam rehearsal (#321, docs/game-jam.md): two people, two accounts, two machines, one Unreal project in
// Perforce. Ana runs Claude Code behind a real agent channel, Bob OpenCode behind a real bridge, both on a real relay.
// Ana's Claude opens the level for edit and Bob's Claude sees it held, waits for her submit, gets it, asks her a question
// and gets the answer, and fetches the screenshot she shares. The test plays both Claudes and Perforce's output; the relay
// sees none of what they say.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readGuardState } from '../agent/src/cluster/guard'
import type { PluginCommand } from '../agent/src/opencode/bridge'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { RelayClient, type SocketLike } from '../shared/client'
import { type ClusterState, ClusterVault, sealClusterSessionOrder } from '../shared/cluster'
import { ClusterApi } from '../shared/cluster-api'
import type { ClusterUpdate } from '../shared/cluster-protocol'
import { newAccountKey, seal } from '../shared/crypto'
import { Vault } from '../shared/vault'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const FIXTURE = join(import.meta.dir, '../agent/test/fixtures/opencode-2.0.32.jsonl')
const OPENCODE = 'ses_e872d9012ffeqUp0ZMJp9G4Gx2'
const CLAUDE = `jam-${Date.now()}`
/** Written into what the Claudes say and share: it must never be found in the relay's files. */
const MARKER = `marker-${Date.now()}-lighting-pass`
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 7, 7])
const dir = mkdtempSync(join(tmpdir(), 'tonton-jam-'))
/** Ana's Unreal project, named as in the depot (`//depot/Hero/…`), so Perforce's paths read relative to it. */
const project = join(dir, 'Hero')
const transcript = join(dir, 'transcript.jsonl')
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
let line = 0

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

async function putIn(app: App, sessionId: string, tool: 'claude' | 'opencode') {
  const order = await sealClusterSessionOrder(app.key, { clusterId, sessionId, key: clusterKey, version: 1 })
  const profile = await new ClusterVault(clusterKey).seal({ name: `${tool} session`, tool })
  app.client.sendCluster({ t: 'cluster_join_session', clusterId, sessionId, order, profile })
}

/** Plays Tonton's OpenCode plugin: a tool Bob's OpenCode called, and the bridge's answer. */
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

/** Plays Ana's Claude running a shell command, as its transcript records the call and the output. */
function anaRuns(command: string, output: string) {
  const id = `toolu_jam_${++line}`
  const lines = [
    {
      sessionId: CLAUDE,
      type: 'assistant',
      uuid: `a${line}`,
      message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
    },
    {
      sessionId: CLAUDE,
      type: 'user',
      uuid: `r${line}`,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] },
    },
  ]
  appendFileSync(transcript, lines.map(entry => `${JSON.stringify(entry)}\n`).join(''))
}

const fromCluster = () => notifications.filter(n => n.params?.meta?.sender === 'cluster').map(n => n.params?.content ?? '')

beforeAll(async () => {
  mkdirSync(join(project, 'Content', 'Maps'), { recursive: true })
  mkdirSync(join(project, 'Saved', 'Screenshots'), { recursive: true })
  writeFileSync(join(project, 'Hero.uproject'), '{}')
  writeFileSync(join(project, 'Saved', 'Screenshots', 'lighting.png'), PNG)

  // Claude Code, on Ana's Mac, in the project.
  ana = await account('Mac')
  writeFileSync(
    transcript,
    `${JSON.stringify({ sessionId: CLAUDE, type: 'user', uuid: 'u0', message: { content: `Light the main level ${MARKER}` } })}\n`,
  )
  writeFileSync(
    join(ana.home, 'run', `${process.pid}.json`),
    JSON.stringify({ sessionId: CLAUDE, transcriptPath: transcript, cwd: project, event: 'Stop', permissionMode: 'default' }),
  )
  claude = new Client({ name: 'claude-code', version: 'test' })
  claude.fallbackNotificationHandler = async notification => {
    notifications.push(notification as (typeof notifications)[number])
  }
  const claudeEnv = { ...process.env, TONTON_HOME: ana.home, TONTON_CHANNEL: '1', TONTON_SERVICE: 'off' } as Record<string, string>
  await claude.connect(new StdioClientTransport({ command: 'bun', args: [AGENT, 'channel'], env: claudeEnv }))

  // OpenCode, on Bob's Windows PC.
  bob = await account('Windows')
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

  // The cluster: Ana makes it, Bob joins with the invite, each puts in their own session.
  const created = await new ClusterApi({ relay: base, token: ana.token }).create(ana.key, ana.accountId, { name: 'Jam' }, { name: 'Ana' })
  clusterId = created.cluster.id
  clusterKey = created.key
  const invite = await new ClusterApi({ relay: base, token: ana.token }).createInvite(clusterId, { uses: 1, hours: 1 })
  await new ClusterApi({ relay: base, token: bob.token }).join(
    bob.key,
    bob.accountId,
    { relay: base, cluster: clusterId, token: invite.token, key: clusterKey, version: 1 },
    { name: 'Bob' },
  )
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
  await eventually(async () => (await claude.listTools()).tools.some(tool => tool.name === 'cluster_share'), "Claude Code's tools")
}, 40_000)

afterAll(async () => {
  ana?.client.stop()
  bob?.client.stop()
  bridge?.kill()
  await claude?.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('a game jam rehearsal', () => {
  test("Ana's p4 edit holds the level: Bob's Claude sees it, and his edit guard knows who holds it", async () => {
    anaRuns('p4 edit Content/Maps/Main.umap', '//depot/Hero/Content/Maps/Main.umap#3 - opened for edit\n')
    const claims = await eventually(async () => {
      const listed = await openCodeTool('cluster_claims', {})
      return listed.includes('Content/Maps/Main.umap') && listed
    }, 'the claim at Bob')
    expect(claims).toContain('Ana')
    const guard = await eventually(() => readGuardState(OPENCODE, join(bob.home, 'cluster-guard')), "Bob's guard file")
    expect(guard.clusters[0]?.claims).toMatchObject([{ paths: ['Content/Maps/Main.umap'], holder: "Ana's Claude", session: CLAUDE }])
  }, 30_000)

  test("Bob's Claude waits for the submit, which also lets the level go", async () => {
    const waiting = openCodeTool('cluster_wait', { type: 'submit', word: '1234', minutes: 1 })
    await Bun.sleep(300)
    anaRuns(
      'p4 submit -d "Lighting pass"',
      'Submitting change 1234.\nLocking 1 files ...\nedit //depot/Hero/Content/Maps/Main.umap#4\nChange 1234 submitted.\n',
    )
    const got = await waiting
    expect(got).toContain('<cluster kind="event"')
    expect(got).toContain('Submitted change 1234')
    await eventually(async () => (await openCodeTool('cluster_claims', {})).startsWith('No session'), 'the level let go')
    await eventually(() => readGuardState(OPENCODE, join(bob.home, 'cluster-guard')) === null, "Bob's guard file emptied")
  }, 30_000)

  test("Bob's Claude asks Ana's, which answers", async () => {
    const asking = openCodeTool('cluster_ask', { to_session: CLAUDE, text: 'Which input action jumps?', minutes: 1 })
    const ask = await eventually(() => fromCluster().find(text => text.includes('Which input action jumps?')), 'the ask at Ana')
    const id = /reply_to "([\w-]+)"/.exec(ask)?.[1]
    expect(id).toBeString()
    expect(await callClaude('cluster_send', { text: `IA_Jump ${MARKER}`, reply_to: id })).toMatch(/^Sent/)
    expect(await asking).toContain(`IA_Jump ${MARKER}`)
  }, 30_000)

  test("Ana's Claude shares a screenshot; Bob's fetches the same bytes", async () => {
    const shared = await callClaude('cluster_share', { path: 'Saved/Screenshots/lighting.png', text: `The new lighting ${MARKER}` })
    const id = / as file ([\w-]+)\.$/.exec(shared)?.[1]
    expect(id).toBeString()
    const saved = await openCodeTool('cluster_file', { id })
    const path = /to (.+)\. Open it with your Read tool to see the image\.$/.exec(saved)?.[1]
    expect(path?.startsWith(bob.home)).toBe(true)
    expect([...readFileSync(path as string)]).toEqual([...PNG])
  }, 30_000)

  test('the relay keeps none of it in clear', () => {
    const data = join(dir, 'data')
    for (const name of readdirSync(data)) expect(readFileSync(join(data, name)).toString('latin1').includes(MARKER)).toBe(false)
  })
})
