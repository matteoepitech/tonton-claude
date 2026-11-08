// Real relay, real `tonton channel codex`, and the test playing a Codex run by `tonton codex`: an app-server on a unix
// socket, recorded where `tonton codex` records it, that starts the channel as its MCP server. A client plays the app:
// its prompts, commands and approval answers reach the thread on the app-server, sealed all the way.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ServerWebSocket } from 'bun'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { open, seal } from '../shared/crypto'
import type { PermissionDetail, RelayToApp, SessionMeta, SessionSummary } from '../shared/protocol'
import { Vault } from '../shared/vault'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const FIXTURE = readFileSync(join(import.meta.dir, '../agent/test/fixtures/codex-0.142.2.jsonl'), 'utf8')
  .split('\n')
  .filter(line => line.startsWith('{'))
const SESSION = '01a2b3c4-5d6e-7f80-91a2-b3c4d5e6f708'
const dir = mkdtempSync(join(tmpdir(), 'tonton-codex-drive-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`
const rollout = join(dir, 'codex', 'sessions', `rollout-2026-11-04T10-00-00-${SESSION}.jsonl`)
const project = join(dir, 'HeroProject')
const home = join(dir, 'agent')
const socket = join(home, 'run', 'codex', `${process.pid}.sock`)

// The app-server: what it got, and the one connection it serves (the channel's).
type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }
const received: Message[] = []
let connection: ServerWebSocket<unknown> | null = null
const server = (() => {
  mkdirSync(join(home, 'run', 'codex'), { recursive: true, mode: 0o700 })
  return Bun.serve({
    unix: socket,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('', { status: 400 })),
    websocket: {
      open: ws => {
        connection = ws
      },
      message(ws, raw) {
        const m = JSON.parse(String(raw)) as Message
        received.push(m)
        const reply = (result: unknown) => ws.send(JSON.stringify({ id: m.id, result }))
        if (m.method === 'thread/resume') reply({ thread: { id: SESSION, turns: [] } })
        else if (m.method === 'turn/start') reply({ turn: { id: 'turn-9', status: 'inProgress' } })
        else if (m.id !== undefined && m.method) reply({})
      },
    },
  })
})()

let key: string
let codex: Client
let env: Record<string, string>
const messages: RelayToApp[] = []
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

const latest = (): SessionSummary | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.t === 'session' && message.session.id === SESSION) return message.session
    if (message.t === 'snapshot') return message.sessions.find(s => s.id === SESSION)
  }
}
const sent = (method: string) => received.filter(m => m.method === method)

beforeAll(async () => {
  const account = await (await api('/api/accounts', { method: 'POST' })).json()
  key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const { secret } = await (await api('/api/account/token', { method: 'POST', token: account.token, body: '{}' })).json()
  const joinRequest = { account: account.accountId, secret, name: await seal(key, { name: 'Mac-Codex' }) }
  const machine = await (await api('/api/machines/join', { method: 'POST', body: JSON.stringify(joinRequest) })).json()
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: base, ...machine, key, machine: 'Mac-Codex', version: '0.6.0' }))
  mkdirSync(project, { recursive: true })
  mkdirSync(join(dir, 'codex', 'sessions'), { recursive: true })
  writeFileSync(rollout, `${FIXTURE.slice(0, 3).join('\n')}\n`)
  // As `tonton codex` records its server: this process plays it, the channel's parent.
  writeFileSync(
    join(home, 'run', 'codex', `${process.pid}.json`),
    JSON.stringify({ socket, serverPid: process.pid, wrapperPid: process.pid, startedAt: new Date().toISOString(), threads: [] }),
  )

  app = new WebSocket(`${base.replace('http', 'ws')}/ws/app`, { headers: { authorization: `Bearer ${account.token}` } } as never)
  app.onmessage = event => messages.push(JSON.parse(String(event.data)))
  await new Promise(resolve => (app.onopen = resolve))

  env = { ...process.env, TONTON_HOME: home, TONTON_SERVICE: 'off', TMUX: '', TMUX_PANE: '' } as Record<string, string>
  delete env.CODEX_HOME
  codex = new Client({ name: 'codex-mcp-client', title: 'Codex', version: '0.142.2' })
  await codex.connect(new StdioClientTransport({ command: process.execPath, args: [AGENT, 'channel', 'codex'], env, cwd: project }))
  const input = { hook_event_name: 'SessionStart', session_id: SESSION, transcript_path: rollout, cwd: project, source: 'startup' }
  const hook = Bun.spawn(['/bin/sh', '-c', `exec '${process.execPath}' '${AGENT}' hook codex`], {
    env,
    stdin: new Blob([JSON.stringify(input)]),
  })
  expect(await hook.exited).toBe(0)
}, 30_000)

afterAll(async () => {
  app?.close()
  await codex?.close().catch(() => {})
  server.stop(true)
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('driving Codex from the app', () => {
  test('a Codex run by tonton codex can chat, takes compact and interrupt, and the channel joined its thread', async () => {
    const session = await eventually(() => latest()?.agentOnline && latest()?.canChat && latest(), 'a session that can chat')
    const meta = await eventually(async () => {
      const opened = session.meta ? await open<SessionMeta>(key, session.meta) : undefined
      return opened?.commands?.length ? opened : latest()?.meta && (await open<SessionMeta>(key, latest()?.meta ?? ''))
    }, 'the meta')
    expect(meta.commands).toEqual(['compact', 'interrupt'])
    await eventually(() => sent('thread/resume').length, 'the thread joined')
    expect(sent('thread/resume')[0]?.params).toEqual({ threadId: SESSION })
  })

  test('a message with an image starts a turn on the thread, then an interrupt stops it', async () => {
    const vault = new Vault(key)
    app.send(
      JSON.stringify({
        t: 'prompt',
        sessionId: SESSION,
        payload: await vault.sealPrompt('Fix the failing test', [{ name: 'shot.png', mediaType: 'image/png', data: 'iVBORw0K' }]),
      }),
    )
    const turn = await eventually(() => sent('turn/start')[0], 'the turn')
    const input = turn.params?.input as { type: string; text?: string; path?: string }[]
    expect(input[0]).toEqual({ type: 'text', text: 'Fix the failing test', text_elements: [] })
    expect(input[1]?.type).toBe('localImage')
    expect(readFileSync(input[1]?.path ?? '', 'utf8')).toBe(Buffer.from('iVBORw0K', 'base64').toString('utf8'))
    app.send(JSON.stringify({ t: 'prompt', sessionId: SESSION, payload: await vault.sealCommand('interrupt', SESSION) }))
    const interrupt = await eventually(() => sent('turn/interrupt')[0], 'the interrupt')
    expect(interrupt.params).toEqual({ threadId: SESSION, turnId: 'turn-9' })
  })

  test('an approval reaches the app sealed, its answer goes back to Codex, and one the TUI answered goes away', async () => {
    connection?.send(
      JSON.stringify({
        id: 41,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: SESSION, turnId: 'turn-9', itemId: 'i1', command: 'make deploy', startedAtMs: Date.now() },
      }),
    )
    // The relay keeps what the session asks with the session, sealed, for every app.
    const asked = await eventually(() => latest()?.pendingPermissions.find(p => p.requestId === '41'), 'the permission')
    expect(await open<PermissionDetail>(key, asked.blob)).toEqual({
      toolName: 'Bash',
      description: 'Run a command',
      inputPreview: '{"command":"make deploy"}',
    })
    app.send(JSON.stringify({ t: 'verdict', sessionId: SESSION, requestId: asked.requestId, behavior: 'allow' }))
    const answer = await eventually(() => received.find(m => m.id === 41 && 'result' in m), 'the answer')
    expect(answer.result).toEqual({ decision: 'accept' })

    connection?.send(
      JSON.stringify({ id: 42, method: 'item/fileChange/requestApproval', params: { threadId: SESSION, turnId: 'turn-9', itemId: 'f1' } }),
    )
    await eventually(() => latest()?.pendingPermissions.some(p => p.requestId === '42'), 'the second permission')
    connection?.send(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: SESSION, requestId: 42 } }))
    await eventually(() => latest() && !latest()?.pendingPermissions.some(p => p.requestId === '42'), 'the close')
  })
})
