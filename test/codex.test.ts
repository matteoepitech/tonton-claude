// Real relay, real `tonton channel codex` and `tonton hook codex`, with the test playing Codex: it starts the channel as
// its MCP server, runs the hooks through a shell with `exec` as Codex does on macOS and Linux, and writes the session's
// rollout. A client plays the app. The rollout is the hand-made fixture of Codex 0.142.2 in agent/test/fixtures.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { open, seal } from '../shared/crypto'
import type { Entry, RelayToApp, SessionInfo, SessionMeta, SessionSummary } from '../shared/protocol'
import { RPGClient } from '../shared/rpg-client'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const FIXTURE = readFileSync(join(import.meta.dir, '../agent/test/fixtures/codex-0.142.2.jsonl'), 'utf8')
  .split('\n')
  .filter(line => line.startsWith('{'))
const SESSION = '01a2b3c4-5d6e-7f80-91a2-b3c4d5e6f708'
const dir = mkdtempSync(join(tmpdir(), 'tonton-codex-e2e-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`
const codexHome = join(dir, 'codex')
const day = join(codexHome, 'sessions', '2026', '11', '04')
const rollout = join(day, `rollout-2026-11-04T10-00-00-${SESSION}.jsonl`)
/** The session's folder, a git repository on its branch. */
const project = join(dir, 'HeroProject')
/** Up to the end of the first turn, which the test writes itself. */
const FIRST_TURN_END = FIXTURE.findIndex(line => line.includes('"task_complete"'))

let key: string
let accountToken: string
let home: string
let env: Record<string, string>
let codex: Client
const notifications: { method: string }[] = []
const messages: RelayToApp[] = []
const raw: string[] = []
let app: WebSocket

const api = (path: string, init: RequestInit & { token?: string } = {}) =>
  fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
  })

async function eventually<T>(read: () => T | undefined | false | Promise<T | undefined | false>, label: string, tries = 100): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = await read()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const latest = (sessionId = SESSION): SessionSummary | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.t === 'session' && message.session.id === sessionId) return message.session
    if (message.t === 'snapshot') return message.sessions.find(s => s.id === sessionId)
  }
}

/** A hook as Codex runs it: `$SHELL -c "exec <agent> hook codex"`, a child of the process that runs the channel. */
async function hook(hook_event_name: string, fields: object = {}) {
  const input = { hook_event_name, session_id: SESSION, transcript_path: rollout, cwd: project, model: 'gpt-5.5', ...fields }
  const child = Bun.spawn(['/bin/sh', '-c', `exec '${process.execPath}' '${AGENT}' hook codex`], {
    env,
    stdin: new Blob([JSON.stringify(input)]),
  })
  expect(await child.exited).toBe(0)
}

beforeAll(async () => {
  const account = await (await api('/api/accounts', { method: 'POST' })).json()
  accountToken = account.token
  key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const { secret } = await (await api('/api/account/token', { method: 'POST', token: account.token, body: '{}' })).json()
  const joinRequest = { account: account.accountId, secret, name: await seal(key, { name: 'Mac-Codex' }) }
  const machine = await (await api('/api/machines/join', { method: 'POST', body: JSON.stringify(joinRequest) })).json()
  home = join(dir, 'agent')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: base, ...machine, key, machine: 'Mac-Codex', version: '0.6.0' }))
  mkdirSync(join(project, '.git'), { recursive: true })
  writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/hero-branch\n')
  mkdirSync(day, { recursive: true })
  writeFileSync(rollout, `${FIXTURE.slice(0, FIRST_TURN_END).join('\n')}\n`)

  app = new WebSocket(`${base.replace('http', 'ws')}/ws/app`, { headers: { authorization: `Bearer ${account.token}` } } as never)
  app.onmessage = event => {
    raw.push(String(event.data))
    messages.push(JSON.parse(String(event.data)))
  }
  await new Promise(resolve => (app.onopen = resolve))

  // Codex starts its MCP servers with a cleared environment: no CODEX_HOME, the hooks tell the channel where to read.
  env = { ...process.env, TONTON_HOME: home, TONTON_SERVICE: 'off', TMUX: '', TMUX_PANE: '' } as Record<string, string>
  delete env.CODEX_HOME
  codex = new Client({ name: 'codex-mcp-client', title: 'Codex', version: '0.142.2' })
  codex.fallbackNotificationHandler = async notification => {
    notifications.push(notification)
  }
  await codex.connect(new StdioClientTransport({ command: process.execPath, args: [AGENT, 'channel', 'codex'], env, cwd: project }))
  await hook('SessionStart', { source: 'startup', permission_mode: 'default' })
  await hook('UserPromptSubmit', { turn_id: 'turn-1', prompt: 'Fix the failing test', permission_mode: 'default' })
}, 30_000)

afterAll(async () => {
  app?.close()
  await codex?.close().catch(() => {})
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('Codex through the relay', () => {
  test('the session shows as Codex, which the notch cannot write to yet', async () => {
    const session = await eventually(() => latest()?.agentOnline && latest(), 'the session')
    expect(session.canChat).toBe(false)
    expect(await open<SessionInfo>(key, session.info as string)).toMatchObject({
      machine: 'Mac-Codex',
      cwd: project,
      project: 'HeroProject',
      tool: 'codex',
    })
    // Codex is told about the tools only: no channel to receive messages or permission prompts. It lists them once, so
    // every pool tool is there from the start, and says outside a pool that the session is not in one.
    expect(codex.getServerCapabilities()?.experimental).toBeUndefined()
    const names = (await codex.listTools()).tools.map(tool => tool.name)
    expect(names).toContain('task_claim')
    expect(names).toContain('plan_create')
    expect(await codex.callTool({ name: 'pool_status', arguments: {} })).toMatchObject({
      content: [{ type: 'text', text: 'This session is not in a pool.' }],
    })
  })

  test('the app decrypts the conversation of the rollout, the relay only sees ciphertext', async () => {
    app.send(JSON.stringify({ t: 'subscribe', sessionId: SESSION }))
    const history = await eventually(() => {
      const found = messages.findLast(m => m.t === 'history' && m.sessionId === SESSION)
      return found?.t === 'history' && found.entries.length > 10 && found
    }, 'the history')
    if (history.t !== 'history') throw new Error('unexpected message')
    const entries = await Promise.all(history.entries.map(entry => open<Entry>(key, entry.blob)))
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'Fix the failing test [Image #1]', images: [{ mediaType: 'image/png' }] })
    expect(entries.filter(entry => entry.kind === 'tool').map(entry => entry.kind === 'tool' && entry.name)).toEqual([
      'Bash',
      'TodoWrite',
      'Edit',
      'Write',
      'Bash',
      'Bash',
      'Bash',
      'Bash',
      'TodoWrite',
    ])
    const traffic = raw.join('')
    for (const secret of ['failing test', 'HeroProject', 'hero-branch', 'Mac-Codex', 'gpt-5.5', 'Bash', 'math.ts'])
      expect(traffic).not.toContain(secret)
  })

  test('the meta: title, model, tokens, context, branch, task list, and no command to type', async () => {
    const meta = await eventually(async () => {
      const sealed = latest()?.meta
      const opened = sealed ? await open<SessionMeta>(key, sealed) : undefined
      return opened?.tokens && opened
    }, 'the meta')
    expect(meta).toMatchObject({
      title: 'Fix the failing test [Image #1]',
      model: 'gpt-5.5',
      tokens: { input: 5100, output: 700, cacheRead: 19000, cacheWrite: 0 },
      context: { usedTokens: 12100, windowTokens: 258400 },
      branch: 'hero-branch',
      terminal: false,
      commands: [],
      // Its ChatGPT plan's windows, apart from Claude's.
      codexFiveHourLimit: { usedPercent: 12, resetsAt: new Date(1_793_800_000_000).toISOString() },
      codexSevenDayLimit: { usedPercent: 3, resetsAt: new Date(1_794_300_000_000).toISOString() },
    })
    expect(meta.fiveHourLimit).toBeUndefined()
    expect(meta.costUSD).toBeUndefined()
  })

  test('a permission request waits for the user, its answer lets the turn go on', async () => {
    await eventually(() => latest()?.status === 'working', 'the prompt')
    await hook('PermissionRequest', { turn_id: 'turn-1', tool_name: 'Bash', tool_input: { command: 'git push' } })
    const asking = await eventually(() => latest()?.status === 'permission' && latest(), 'the request')
    expect(await open(key, asking.statusDetail as string)).toEqual({ text: 'Codex needs your permission to use Bash' })
    await hook('PostToolUse', { turn_id: 'turn-1', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_response: '' })
    await eventually(() => latest()?.status === 'working', 'the turn to go on')
  })

  test('the end of a turn in the rollout makes it idle, though no Stop hook ran', async () => {
    const before = messages.length
    appendFileSync(rollout, `${FIXTURE[FIRST_TURN_END]}\n`)
    await eventually(() => latest()?.status === 'idle', 'the turn to end')
    // The next turn streams live.
    appendFileSync(rollout, `${FIXTURE.slice(FIRST_TURN_END + 1).join('\n')}\n`)
    const live = await eventually(async () => {
      const fresh = messages.slice(before).flatMap(m => (m.t === 'entries' && m.sessionId === SESSION ? m.entries : []))
      const opened = await Promise.all(fresh.map(entry => open<Entry>(key, entry.blob)))
      return opened.some(entry => entry.kind === 'assistant' && entry.text === 'Hello!') && opened
    }, 'the live entries')
    expect(live.map(entry => entry.kind === 'tool' && entry.name).filter(Boolean)).toContain('mcp__tonton__cluster_status')
    await eventually(() => latest()?.status === 'idle', 'the last turn to end')
  })

  test('a Codex turn earns XP, as a Claude Code one does', async () => {
    const now = Date.now()
    const stamp = (seconds: number) => new Date(now - 120_000 + seconds * 1000).toISOString()
    const turn = [
      { timestamp: stamp(0), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-xp' } },
      { timestamp: stamp(1), type: 'event_msg', payload: { type: 'user_message', message: 'Earn it', images: [], local_images: [] } },
      { timestamp: stamp(90), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-xp', duration_ms: 90_000 } },
    ]
    appendFileSync(rollout, turn.map(line => `${JSON.stringify(line)}\n`).join(''))
    const rpg = new RPGClient(`${base}/api/rpg`, accountToken, key)
    // Work time is a gain of the day, not a receipt.
    const earned = async () => (await rpg.read()).state.gains?.some(gain => gain.kind === 'turn' && gain.seconds === 90)
    await eventually(earned, 'Codex turn XP', 300)
  }, 30_000)

  test('a message from the app has no way into Codex, and comes back to nobody', async () => {
    app.send(JSON.stringify({ t: 'prompt', sessionId: SESSION, payload: await seal(key, { text: 'Ship it', images: [] }) }))
    await Bun.sleep(300)
    expect(notifications).toEqual([])
  })

  test('Codex exits: the session ended', async () => {
    await codex.close()
    await eventually(() => latest()?.status === 'ended', 'the end')
  })
})

describe('Codex before its user trusted the hooks', () => {
  test("the channel finds the session's rollout in its folder, and the rollout gives its status", async () => {
    const folder = join(dir, 'Untrusted')
    mkdirSync(folder, { recursive: true })
    const sessionId = '01a2b3c4-0000-7000-8000-0000000000ff'
    const today = new Date()
    const days = join(codexHome, 'sessions', String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'))
    const file = join(days, String(today.getDate()).padStart(2, '0'), `rollout-2026-11-04T11-00-00-${sessionId}.jsonl`)
    const client = new Client({ name: 'codex-mcp-client', version: '0.142.2' })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [AGENT, 'channel', 'codex'],
        env: { ...env, CODEX_HOME: codexHome },
        cwd: folder,
      }),
    )
    try {
      // The first prompt: Codex writes the rollout, and no hook runs.
      mkdirSync(join(file, '..'), { recursive: true })
      const meta = {
        timestamp: new Date().toISOString(),
        type: 'session_meta',
        payload: { id: sessionId, session_id: sessionId, cwd: folder },
      }
      const started = { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }
      writeFileSync(file, `${JSON.stringify(meta)}\n`)
      await eventually(() => latest(sessionId)?.agentOnline, 'the guessed session', 200)
      appendFileSync(file, `${JSON.stringify(started)}\n`)
      await eventually(() => latest(sessionId)?.status === 'working', 'the status from the rollout')
    } finally {
      await client.close()
    }
  }, 20_000)
})
