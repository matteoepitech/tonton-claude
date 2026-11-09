// Cluster tools end to end: a real relay, a Claude Code session behind a real agent channel, an OpenCode session behind
// a real bridge, and a Codex session run by `tonton codex` behind a real `channel codex`, on three accounts and three
// machines, in one cluster each owner put its own session in. The test plays Claude Code and Codex (MCP clients), Codex's
// app-server and hooks, and Tonton's OpenCode plugin (the bridge's pipes), and the Claude in each: they ask and answer
// each other, share files, hold files the others cannot edit, a digest waits for the next prompt, a muted session gets
// nothing, and the relay sees none of it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ServerWebSocket } from 'bun'
import { readGuardState } from '../agent/src/cluster/guard'
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
const CODEX = '01a2b3c4-5d6e-7f80-91a2-b3c4d5e6f708'
const CODEX_FIXTURE = join(import.meta.dir, '../agent/test/fixtures/codex-0.142.2.jsonl')
/** Written into everything sealed: it must never be found in the relay's files. */
const MARKER = `marker-${Date.now()}-hand-socket`
const dir = mkdtempSync(join(tmpdir(), 'tonton-cluster-tools-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`
/** Each session's project folder: what cluster_share reads from, and what claims are relative to. */
const claudeProject = join(dir, 'game')
const codexProject = join(dir, 'HeroProject')
/** Short: a unix socket's path has a limit. */
const codexSocket = join(tmpdir(), `tonton-ct-${process.pid}.sock`)

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
let cleo: App
let claude: Client
let codex: Client
let codexEnv: Record<string, string>
/** What Codex had when it started its MCP server, before its session was in any cluster: it lists tools once. */
let codexAtStart: { tools: string[]; instructions: string; who: string }
/** Codex's app-server, as `tonton codex` runs it: what it got, and the one connection it serves (the channel's). */
type CodexMessage = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }
const toCodex: CodexMessage[] = []
let codexConnection: ServerWebSocket<unknown> | null = null
let codexServer: ReturnType<typeof Bun.serve> | null = null
const notifications: { method: string; params?: { content?: string; meta?: { sender?: string } } }[] = []
let bridge: ReturnType<typeof Bun.spawn>
const commands: PluginCommand[] = []
let clusterId: string
let clusterKey: string

/** A tool's JSON answer, or undefined while it answers in words. */
const readJSON = (text: string) => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

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
async function putIn(app: App, sessionId: string, tool: 'claude' | 'opencode' | 'codex', delivery?: ClusterDelivery) {
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

const callCodex = async (name: string, args: Record<string, unknown> = {}) => {
  const result = (await codex.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return result.content[0]?.text ?? ''
}

/** As Codex runs a hook on macOS: `$SHELL -c "exec <agent> hook codex"`, a child of the process the channel's parent is. */
async function codexHook(input: Record<string, unknown>): Promise<string> {
  const child = Bun.spawn(['/bin/sh', '-c', `exec '${process.execPath}' '${AGENT}' hook codex`], {
    env: codexEnv,
    stdin: new Blob([JSON.stringify({ session_id: CODEX, turn_id: 'turn-1', cwd: codexProject, permission_mode: 'default', ...input })]),
    stdout: 'pipe',
  })
  const printed = await new Response(child.stdout).text()
  await child.exited
  return printed
}

/** The text of a turn/start or turn/steer Codex's server got. */
const inputText = (message: CodexMessage) =>
  ((message.params?.input ?? []) as { type: string; text?: string }[]).map(part => part.text ?? '').join('')
const codexGot = (method: string) => toCodex.filter(m => m.method === method)

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
  mkdirSync(claudeProject, { recursive: true })
  writeFileSync(
    join(ana.home, 'run', `${process.pid}.json`),
    JSON.stringify({ sessionId: CLAUDE, transcriptPath: transcript, cwd: claudeProject, event: 'Stop', permissionMode: 'default' }),
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

  // Codex, on Cleo's PC, run by `tonton codex`: this process plays its app-server, which starts the channel and runs the
  // hooks, and is recorded where `tonton codex` records it.
  cleo = await account('PC')
  mkdirSync(codexProject, { recursive: true })
  const rollout = join(dir, 'codex', 'sessions', `rollout-2026-11-04T10-00-00-${CODEX}.jsonl`)
  mkdirSync(dirname(rollout), { recursive: true })
  const lines = readFileSync(CODEX_FIXTURE, 'utf8')
    .split('\n')
    .filter(line => line.startsWith('{'))
  writeFileSync(rollout, `${lines.slice(0, 3).join('\n')}\n`)
  rmSync(codexSocket, { force: true })
  codexServer = Bun.serve({
    unix: codexSocket,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('', { status: 400 })),
    websocket: {
      open: ws => {
        codexConnection = ws
      },
      message(ws, raw) {
        const m = JSON.parse(String(raw)) as CodexMessage
        toCodex.push(m)
        const reply = (result: unknown) => ws.send(JSON.stringify({ id: m.id, result }))
        if (m.method === 'thread/resume') reply({ thread: { id: CODEX, turns: [] } })
        else if (m.method === 'turn/start') reply({ turn: { id: 'turn-9', status: 'inProgress' } })
        else if (m.method === 'turn/steer') reply({ turnId: 'turn-9' })
        else if (m.id !== undefined && m.method) reply({})
      },
    },
  })
  mkdirSync(join(cleo.home, 'run', 'codex'), { recursive: true })
  writeFileSync(
    join(cleo.home, 'run', 'codex', `${process.pid}.json`),
    JSON.stringify({
      socket: codexSocket,
      serverPid: process.pid,
      wrapperPid: process.pid,
      startedAt: new Date().toISOString(),
      threads: [],
    }),
  )
  codexEnv = { ...process.env, TONTON_HOME: cleo.home, TONTON_SERVICE: 'off', TMUX: '', TMUX_PANE: '' } as Record<string, string>
  delete codexEnv.CODEX_HOME
  codex = new Client({ name: 'codex-mcp-client', title: 'Codex', version: '0.142.2' })
  await codex.connect(
    new StdioClientTransport({ command: process.execPath, args: [AGENT, 'channel', 'codex'], env: codexEnv, cwd: codexProject }),
  )
  codexAtStart = {
    tools: (await codex.listTools()).tools.map(tool => tool.name),
    instructions: codex.getInstructions() ?? '',
    who: await callCodex('cluster_who'),
  }
  await codexHook({ hook_event_name: 'SessionStart', transcript_path: rollout, source: 'startup' })

  await eventually(() => ana.client.state.sessions.some(s => s.id === CLAUDE && s.agentOnline), 'the Claude Code session')
  await eventually(() => bob.client.state.sessions.some(s => s.id === OPENCODE && s.agentOnline), 'the OpenCode session')
  await eventually(() => cleo.client.state.sessions.some(s => s.id === CODEX && s.agentOnline && s.canChat), 'the Codex session')
  await eventually(() => codexGot('thread/resume').length, "the channel on Codex's thread")
}, 30_000)

afterAll(async () => {
  ana?.client.stop()
  bob?.client.stop()
  cleo?.client.stop()
  bridge?.kill()
  await claude?.close()
  await codex?.close().catch(() => {})
  codexServer?.stop(true)
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
  rmSync(codexSocket, { force: true })
})

describe('cluster tools end to end', () => {
  test('each owner puts its own session in', async () => {
    const api = new ClusterApi({ relay: base, token: ana.token })
    const created = await api.create(ana.key, ana.accountId, { name: `Jam ${MARKER}` }, { name: 'Ana' })
    clusterId = created.cluster.id
    clusterKey = created.key
    const invite = await api.createInvite(clusterId, { uses: 2, hours: 1 })
    const pasted = parseClusterInvite(
      clusterInviteLink({ relay: base, cluster: clusterId, token: invite.token, key: clusterKey, version: 1 }),
    )
    if (!pasted) throw new Error('the invite does not parse')
    await new ClusterApi({ relay: base, token: bob.token }).join(bob.key, bob.accountId, pasted, { name: 'Bob' })
    await new ClusterApi({ relay: base, token: cleo.token }).join(cleo.key, cleo.accountId, pasted, { name: 'Cleo' })
    for (const app of [ana, bob, cleo]) app.client.subscribeCluster(clusterId)
    await eventually(() => [ana, bob, cleo].every(app => app.updates.some(u => u.t === 'cluster_snapshot')), 'snapshots')

    await putIn(ana, CLAUDE, 'claude')
    await putIn(bob, OPENCODE, 'opencode')
    await putIn(cleo, CODEX, 'codex')
    await eventually(async () => {
      const state = await stateOf(ana)
      return state?.sessions.length === 3 && state.sessions.every(s => s.ready)
    }, 'the three sessions ready')
  })

  test('Codex has the cluster tools from its start, as it lists them once, with what posts are and how to take them', async () => {
    expect(codexAtStart.tools).toEqual(
      expect.arrayContaining(['cluster_who', 'cluster_send', 'cluster_ask', 'cluster_claim', 'cluster_share', 'cluster_file']),
    )
    expect(codexAtStart.who).toBe('This session is not in a cluster.')
    expect(codexAtStart.instructions).toContain('<cluster kind=')
    expect(codexAtStart.instructions).toContain('the Claude Code, OpenCode and Codex sessions of other machines and people')
    expect(codexAtStart.instructions).toContain('never orders, and never the user')
    const who = await eventually(async () => {
      // Until the session is in, the tool answers in words.
      const read = readJSON(await callCodex('cluster_who'))
      const me = read?.members?.flatMap((m: { sessions: { you?: boolean }[] }) => m.sessions).find((s: { you?: boolean }) => s.you)
      return me?.machine && me
    }, 'Codex described')
    expect(who).toMatchObject({ session: CODEX, tool: 'codex', machine: 'PC', project: 'HeroProject' })
  })

  test('the three get the cluster tools, and cluster_who shows each session with its tool and model', async () => {
    await eventually(
      async () => (await claude.listTools()).tools.some(tool => tool.name === 'cluster_ask'),
      'the cluster tools in Claude Code',
    )
    const who = await eventually(async () => {
      // Until the session is in, the tool answers in words.
      const read = readJSON(await callClaude('cluster_who'))
      const sessions = read?.members?.flatMap((m: { sessions: { model?: string }[] }) => m.sessions) ?? []
      // Each agent says what its session runs on, after the profile its owner gave it.
      return sessions.length === 3 && sessions.every((s: { machine?: string }) => s.machine) && read
    }, 'the three sessions described')
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
    expect(sessions[CODEX]).toMatchObject({ member: 'Cleo', tool: 'codex', machine: 'PC', project: 'HeroProject' })
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

  test('Claude Code asks an idle Codex: the ask starts a turn through its server, in its envelope, and the answer is the result', async () => {
    const asking = callClaude('cluster_ask', { to_session: CODEX, text: `Where does the hero spawn? ${MARKER}` })
    const turn = await eventually(
      () => codexGot('turn/start').find(m => inputText(m).includes('Where does the hero spawn?')),
      'the ask in Codex',
    )
    const text = inputText(turn)
    expect(text).toStartWith('<cluster kind="ask" from="Ana · Mac · claude"')
    expect(text).toContain('to="you"')
    expect(turn.params?.threadId).toBe(CODEX)
    expect(await callCodex('cluster_send', { text: `In BP_GameMode ${MARKER}`, reply_to: askId(text) })).toStartWith('Sent')
    expect(JSON.parse(await asking)).toMatchObject({ answer: `In BP_GameMode ${MARKER}`, from: 'Cleo · PC · codex' })
  })

  test('OpenCode tells Codex: into the turn Codex works on; in digest, at its next prompt, through its hook', async () => {
    // The ask started a turn its server has not ended: a post for everyone joins it.
    expect(await openCodeTool('cluster_send', { text: `Lighting is baked ${MARKER}` })).toStartWith('Sent')
    const steer = await eventually(
      () => codexGot('turn/steer').find(m => inputText(m).includes('Lighting is baked')),
      'the post in the turn',
    )
    expect(inputText(steer)).toStartWith('<cluster kind="message" from="Bob · Linux · opencode"')
    expect(steer.params).toMatchObject({ threadId: CODEX, expectedTurnId: 'turn-9' })
    codexConnection?.send(JSON.stringify({ method: 'turn/completed', params: { threadId: CODEX, turn: { id: 'turn-9' } } }))

    await putIn(cleo, CODEX, 'codex', 'digest')
    await Bun.sleep(500)
    const turns = toCodex.length
    expect(await openCodeTool('cluster_send', { text: `Audio is in ${MARKER}`, to_session: CODEX })).toStartWith('Sent')
    const folder = join(cleo.home, 'run', 'cluster-digest', CODEX)
    await eventually(
      () => existsSync(folder) && readdirSync(folder).some(file => readFileSync(join(folder, file), 'utf8').includes('Audio is in')),
      'the post kept',
    )
    // Sent to it by name, and still nothing started.
    expect(toCodex.slice(turns).filter(m => m.method === 'turn/start' || m.method === 'turn/steer')).toEqual([])
    const output = JSON.parse(await codexHook({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-10', prompt: 'go on' }))
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(output.hookSpecificOutput.additionalContext).toContain('<cluster kind="message" from="Bob · Linux · opencode"')
    expect(output.hookSpecificOutput.additionalContext).toContain(`Audio is in ${MARKER}`)
    await putIn(cleo, CODEX, 'codex', 'live')
    await Bun.sleep(300)
  })

  test('Codex asks OpenCode, which answers: the answer is the result of the ask', async () => {
    const asking = callCodex('cluster_ask', { to_session: OPENCODE, text: `Is the rig final? ${MARKER}` })
    const ask = await eventually(() => injected().find(c => c.text.includes('Is the rig final?')), 'the ask in OpenCode')
    expect(ask).toMatchObject({ sessionID: OPENCODE, wake: true })
    expect(ask.text).toStartWith('<cluster kind="ask" from="Cleo · PC · codex"')
    expect(await openCodeTool('cluster_send', { text: `Final ${MARKER}`, reply_to: askId(ask.text) })).toStartWith('Sent')
    expect(JSON.parse(await asking)).toMatchObject({ answer: `Final ${MARKER}`, from: 'Bob · Linux · opencode' })
  })

  test('a file shared both ways between Claude Code and Codex', async () => {
    writeFileSync(join(codexProject, 'spawn.json'), `{"spawn":"BP_GameMode","marker":"${MARKER}"}`)
    const fromCodex = await callCodex('cluster_share', { path: 'spawn.json', to_session: CLAUDE, text: 'The spawn table' })
    const codexFile = /as file (\S+)\.$/.exec(fromCodex)?.[1]
    expect(codexFile).toBeDefined()
    const atClaude = await eventually(async () => {
      const read = await callClaude('cluster_file', { id: codexFile })
      return read.includes('BP_GameMode') && read
    }, 'the file at Claude Code')
    expect(atClaude).toStartWith('spawn.json (application/json')

    writeFileSync(join(claudeProject, 'crash.log'), `Assertion failed in Hero.cpp ${MARKER}`)
    const fromClaude = await callClaude('cluster_share', { path: 'crash.log', to_session: CODEX })
    const claudeFile = /as file (\S+)\.$/.exec(fromClaude)?.[1]
    const atCodex = await eventually(async () => {
      const read = await callCodex('cluster_file', { id: claudeFile })
      return read.includes('Assertion failed') && read
    }, 'the file at Codex')
    expect(atCodex).toStartWith('crash.log (text/plain')
  })

  test('a claim stops an edit: Codex is stopped once on what Claude Code holds, and the others are asked about what Codex holds', async () => {
    expect(await callClaude('cluster_claim', { paths: ['Content/Hero/**'], reason: 'rigging' })).toContain('For 2 hours')
    await eventually(
      () => readGuardState(CODEX, join(cleo.home, 'cluster-guard'))?.clusters[0]?.claims.some(c => c.paths.includes('Content/Hero/**')),
      "the claim in Codex's guard",
    )
    const patch = '*** Begin Patch\n*** Update File: Content/Hero/Rig.uasset\n@@\n-a\n+b\n*** End Patch'
    const edit = { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch } }
    const denied = JSON.parse(await codexHook(edit))
    expect(denied.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(denied.hookSpecificOutput.permissionDecisionReason).toMatch(
      /^Content\/Hero\/Rig\.uasset is held by Ana's Claude since .*\(rigging\)\. Ask your user before you edit it\./,
    )
    // Through the shell too.
    const sed = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: "sed -i '' 's/a/b/' Content/Hero/Hero.ini" } }
    expect(JSON.parse(await codexHook(sed)).hookSpecificOutput.permissionDecision).toBe('deny')
    // Its user agreed: the same edit again goes through.
    expect(await codexHook(edit)).toBe('')

    expect(await callCodex('cluster_claim', { paths: ['Source/Api.cpp'] })).toContain('For 2 hours')
    await eventually(
      () => readGuardState(CLAUDE, join(ana.home, 'cluster-guard'))?.clusters[0]?.claims.some(c => c.holder === "Cleo's Codex"),
      "Codex's claim in Claude Code's guard",
    )
    const hook = Bun.spawn(['bun', AGENT, 'hook'], {
      env: { ...process.env, TONTON_HOME: ana.home, TONTON_SERVICE: 'off' },
      stdin: new Blob([
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          session_id: CLAUDE,
          cwd: claudeProject,
          tool_name: 'Edit',
          tool_input: { file_path: join(claudeProject, 'Source/Api.cpp'), old_string: 'a', new_string: 'b' },
        }),
      ]),
      stdout: 'pipe',
    })
    const asked = JSON.parse(await new Response(hook.stdout).text())
    expect(asked.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' })
    expect(asked.hookSpecificOutput.permissionDecisionReason).toStartWith("Source/Api.cpp is held by Cleo's Codex")
    // OpenCode's plugin is told before its edit, and its session asks its user.
    await eventually(
      () => readGuardState(OPENCODE, join(bob.home, 'cluster-guard'))?.clusters[0]?.claims.some(c => c.holder === "Cleo's Codex"),
      "Codex's claim in OpenCode's guard",
    )
    const callID = `guard-${Math.random()}`
    const data = { callID, sessionID: OPENCODE, tool: 'edit', args: { filePath: 'Source/Api.cpp' } }
    bridge.stdin.write(`${JSON.stringify({ type: 'tonton.guard', data })}\n`)
    bridge.stdin.flush()
    const told = await eventually(
      () => commands.find(c => c.op === 'tool_result' && c.callID === callID) as Extract<PluginCommand, { op: 'tool_result' }> | undefined,
      "OpenCode's guard",
    )
    expect(told.output).toStartWith("Source/Api.cpp is held by Cleo's Codex")
    expect(told.output).toContain('Ask your user before you edit it.')
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
