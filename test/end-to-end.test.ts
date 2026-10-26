// Real relay, real agent channel and hook, a stand-in for Claude Code, and a WebSocket client playing the Mac app.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { open, seal } from '../agent/src/crypto'
import { agentBinaryName, TRAY_HELPER_NAME } from '../agent/src/update'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import type { RelayToApp, SessionSummary } from '../shared/protocol'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const dir = mkdtempSync(join(tmpdir(), 'tonton-e2e-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
// Stands in for the GitHub releases the agent updates from.
const releaseFiles = new Map<string, string>()
const releases = Bun.serve({
  port: 0,
  fetch: req => {
    const file = releaseFiles.get(new URL(req.url).pathname)
    return file === undefined ? new Response('not found', { status: 404 }) : new Response(file)
  },
})
const NEW_VERSION = '9.9.9'
const base = `http://127.0.0.1:${relay.server.port}`
const sessionId = `session-${Date.now()}`
const transcript = join(dir, 'transcript.jsonl')

interface App {
  socket: WebSocket
  messages: RelayToApp[]
  raw: string[]
}

let accountToken: string
let otherAccountToken: string
let key: string
let machine: { machineId: string; token: string }
let claude: Client
const notifications: { method: string; params?: Record<string, unknown> }[] = []
let app: App
let stranger: App

const api = (path: string, init: RequestInit & { token?: string } = {}) =>
  fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
  })

const line = (fields: object) => `${JSON.stringify({ sessionId, timestamp: new Date().toISOString(), ...fields })}\n`

async function eventually<T>(read: () => T | undefined | false, label: string): Promise<T> {
  for (let i = 0; i < 80; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function connectApp(token: string): Promise<App> {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/app`, { headers: { authorization: `Bearer ${token}` } } as never)
  const client: App = { socket, messages: [], raw: [] }
  socket.onmessage = event => {
    client.raw.push(String(event.data))
    client.messages.push(JSON.parse(String(event.data)))
  }
  return new Promise(resolve => (socket.onopen = () => resolve(client)))
}

const latestSession = (client: App): SessionSummary | undefined => {
  for (let i = client.messages.length - 1; i >= 0; i--) {
    const message = client.messages[i]
    if (message.t === 'session' && message.session.id === sessionId) return message.session
    if (message.t === 'snapshot') return message.sessions.find(s => s.id === sessionId)
  }
}

beforeAll(async () => {
  const account = await (await api('/api/accounts', { method: 'POST' })).json()
  accountToken = account.token
  otherAccountToken = (await (await api('/api/accounts', { method: 'POST' })).json()).token
  key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')

  const { secret } = await (await api('/api/account/token', { method: 'POST', token: accountToken, body: '{}' })).json()
  const name = await seal(key, { name: 'PC-Test' })
  const joinRequest = { account: account.accountId, secret, name }
  machine = await (await api('/api/machines/join', { method: 'POST', body: JSON.stringify(joinRequest) })).json()

  const home = join(dir, 'agent')
  mkdirSync(join(home, 'run'), { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: base, ...machine, key, machine: 'PC-Test', version: '0.3.0' }))
  writeFileSync(
    transcript,
    line({ type: 'user', uuid: 'u1', message: { content: 'SECRET prompt' } }) + line({ type: 'ai-title', aiTitle: 'SECRET title' }),
  )
  writeFileSync(
    join(home, 'run', `${process.pid}.json`),
    JSON.stringify({ sessionId, transcriptPath: transcript, cwd: '/home/x/SecretProject' }),
  )

  const env = {
    ...process.env,
    TONTON_HOME: home,
    TONTON_CHANNEL: '1',
    TONTON_SERVICE: 'off',
    TONTON_RELEASES_URL: `http://127.0.0.1:${releases.port}`,
  } as Record<string, string>
  claude = new Client({ name: 'claude-code', version: 'test' })
  claude.fallbackNotificationHandler = async notification => {
    notifications.push(notification)
  }
  await claude.connect(new StdioClientTransport({ command: 'bun', args: [AGENT, 'channel'], env }))
  const hook = {
    hook_event_name: 'Notification',
    session_id: sessionId,
    transcript_path: transcript,
    message: 'Claude needs your permission to use Bash',
    notification_type: 'permission_prompt',
  }
  await Bun.spawn(['bun', AGENT, 'hook'], { env, stdin: new Blob([JSON.stringify(hook)]) }).exited

  app = await connectApp(accountToken)
  stranger = await connectApp(otherAccountToken)
  await eventually(() => latestSession(app)?.agentOnline, 'the agent to come online')
}, 20_000)

afterAll(async () => {
  app?.socket.close()
  stranger?.socket.close()
  await claude?.close()
  relay.stop()
  releases.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

describe('end to end', () => {
  test('the app decrypts the conversation, the relay only ever sees ciphertext', async () => {
    app.socket.send(JSON.stringify({ t: 'subscribe', sessionId }))
    const history = await eventually(() => app.messages.find(m => m.t === 'history' && m.entries.length > 0), 'history')
    if (history.t !== 'history') throw new Error('unexpected message')
    expect(await open<{ text: string }>(key, history.entries[0].blob)).toMatchObject({ text: 'SECRET prompt' })

    const traffic = app.raw.join('')
    for (const secret of ['SECRET', 'PC-Test', 'SecretProject', 'Bash']) expect(traffic).not.toContain(secret)
  })

  test('hook status reaches the app with a sealed detail', async () => {
    const session = await eventually(() => latestSession(app)?.statusDetail && latestSession(app), 'status')
    expect(session.status).toBe('permission')
    expect(await open<{ text: string }>(key, session.statusDetail as string)).toEqual({ text: 'Claude needs your permission to use Bash' })
  })

  test('another account sees nothing and cannot drive the session', async () => {
    stranger.socket.send(JSON.stringify({ t: 'subscribe', sessionId }))
    stranger.socket.send(JSON.stringify({ t: 'prompt', sessionId, payload: await seal(key, { text: 'evil', images: [] }) }))
    await Bun.sleep(300)
    expect(stranger.messages.some(m => (m.t === 'history' && m.entries.length > 0) || m.t === 'session')).toBe(false)
    expect(notifications.some(n => n.method === 'notifications/claude/channel')).toBe(false)
  })

  test('a prompt from the app reaches Claude, one sealed with another key is dropped', async () => {
    const foreignKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    app.socket.send(JSON.stringify({ t: 'prompt', sessionId, payload: await seal(foreignKey, { text: 'forged', images: [] }) }))
    app.socket.send(JSON.stringify({ t: 'prompt', sessionId, payload: await seal(key, { text: 'Ship it', images: [] }) }))
    const delivered = await eventually(() => notifications.find(n => n.method === 'notifications/claude/channel'), 'the prompt')
    expect(delivered.params?.content).toBe('Ship it')
    expect(notifications.filter(n => n.method === 'notifications/claude/channel')).toHaveLength(1)
  })

  test('permission prompts round-trip', async () => {
    const params = { request_id: 'abcde', tool_name: 'Bash', description: 'Deploy', input_preview: '{"command":"deploy"}' }
    await claude.notification({ method: 'notifications/claude/channel/permission_request', params })
    const session = await eventually(() => latestSession(app)?.pendingPermissions.length && latestSession(app), 'the request')
    expect(await open<{ toolName: string }>(key, session.pendingPermissions[0].blob)).toMatchObject({ toolName: 'Bash' })

    app.socket.send(JSON.stringify({ t: 'verdict', sessionId, requestId: 'abcde', behavior: 'allow' }))
    const verdict = await eventually(() => notifications.find(n => n.method === 'notifications/claude/channel/permission'), 'the verdict')
    expect(verdict.params).toEqual({ request_id: 'abcde', behavior: 'allow' })
  })

  test('new transcript lines stream live', async () => {
    appendFileSync(transcript, line({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'text', text: 'done' }] } }))
    const live = await eventually(() => app.messages.find(m => m.t === 'entries'), 'live entries')
    if (live.t !== 'entries') throw new Error('unexpected message')
    expect(await open<{ text: string }>(key, live.entries[0].blob)).toMatchObject({ text: 'done' })
  })

  test('a message sent from the notch while Claude is working reaches the app from the queue', async () => {
    const before = app.messages.length
    const prompt = '<channel source="tonton" sender="notch">\nAlso run the linter\n</channel>'
    const attachment = { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'channel', server: 'tonton' }, prompt }
    appendFileSync(transcript, line({ type: 'attachment', uuid: 'q1', attachment }))
    const live = await eventually(() => app.messages.slice(before).find(m => m.t === 'entries'), 'the queued message')
    if (live.t !== 'entries') throw new Error('unexpected message')
    expect(await open(key, live.entries[0].blob)).toMatchObject({ kind: 'user', text: 'Also run the linter', viaNotch: true })
  })

  test('the cost Claude Code saved for the session reaches the app', async () => {
    appendFileSync(transcript, line({ type: 'cost-state', totalCostUSD: 1.25 }))
    const withCost = async () => {
      const meta = latestSession(app)?.meta
      return meta ? (await open<{ costUSD?: number }>(key, meta)).costUSD === 1.25 : false
    }
    for (let i = 0; i < 100 && !(await withCost()); i++) await Bun.sleep(50)
    expect(await withCost()).toBe(true)
  })

  test('the app sees the version installed on the machine', async () => {
    const snapshot = app.messages.find(m => m.t === 'snapshot')
    if (snapshot?.t !== 'snapshot') throw new Error('no snapshot')
    expect(snapshot.machines[0].agentVersion).toBe('0.3.0')
  })

  test('an update order sealed with another key is refused by the agent', async () => {
    const foreignKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    const order = await seal(foreignKey, { version: NEW_VERSION, issuedAt: new Date().toISOString() })
    stranger.socket.send(JSON.stringify({ t: 'update_agent', machineId: machine.machineId, order }))
    app.socket.send(JSON.stringify({ t: 'update_agent', machineId: machine.machineId, order }))
    const result = await eventually(() => app.messages.find(m => m.t === 'agent_update'), 'the refusal')
    if (result.t !== 'agent_update') throw new Error('unexpected message')
    expect(result.ok).toBe(false)
    expect(await open<{ text: string }>(key, result.detail as string)).toEqual({
      text: 'the update order is not sealed with the account key',
    })
    expect(stranger.messages.some(m => m.t === 'agent_update')).toBe(false)
  })

  test.skipIf(process.platform === 'win32')('a build that does not match the release checksums is refused', async () => {
    releaseFiles.set(`/download/v${NEW_VERSION}/SHA256SUMS`, `${'0'.repeat(64)}  ${agentBinaryName()}\n`)
    releaseFiles.set(`/download/v${NEW_VERSION}/${agentBinaryName()}`, 'tampered')
    const order = await seal(key, { version: NEW_VERSION, issuedAt: new Date().toISOString() })
    app.messages.length = 0
    app.socket.send(JSON.stringify({ t: 'update_agent', machineId: machine.machineId, order }))
    const result = await eventually(() => app.messages.find(m => m.t === 'agent_update'), 'the refusal')
    if (result.t !== 'agent_update') throw new Error('unexpected message')
    expect(await open<{ text: string }>(key, result.detail as string)).toEqual({ text: `${agentBinaryName()} does not match its checksum` })
  })

  test.skipIf(process.platform === 'win32')(
    'one click updates the agent from the releases: download, check, swap and reinstall',
    async () => {
      // Reports the new version, and its install step records the version like the real one.
      const home = join(dir, 'agent')
      const build = `#!/bin/sh
case "$1" in
  version) echo ${NEW_VERSION} ;;
  install) sed -i.bak 's/"0.3.0"/"${NEW_VERSION}"/' "$TONTON_HOME/config.json" && echo "$@" > "$TONTON_HOME/installed" ;;
esac
`
      const tray = 'menu bar icon'
      const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')
      releaseFiles.set(`/download/v${NEW_VERSION}/${agentBinaryName()}`, build)
      releaseFiles.set(`/download/v${NEW_VERSION}/${TRAY_HELPER_NAME}`, tray)
      releaseFiles.set(
        `/download/v${NEW_VERSION}/SHA256SUMS`,
        `${sha256(build)}  ${agentBinaryName()}\n${sha256(tray)}  ${TRAY_HELPER_NAME}\n`,
      )
      mkdirSync(join(home, 'bin'), { recursive: true })
      writeFileSync(join(home, 'bin', 'tonton'), 'old build')

      const order = await seal(key, { version: NEW_VERSION, issuedAt: new Date().toISOString() })
      app.messages.length = 0
      app.socket.send(JSON.stringify({ t: 'update_agent', machineId: machine.machineId, order }))
      const result = await eventually(() => app.messages.find(m => m.t === 'agent_update'), 'the update')
      expect(result).toMatchObject({ ok: true })
      const machines = await eventually(() => app.messages.find(m => m.t === 'machines'), 'the new version')
      if (machines.t !== 'machines') throw new Error('unexpected message')
      expect(machines.machines[0].agentVersion).toBe(NEW_VERSION)
      expect(readFileSync(join(home, 'bin', 'tonton'), 'utf8')).toBe(build)
      expect(readFileSync(join(home, 'installed'), 'utf8').trim()).toBe('install --no-restart')
      expect(existsSync(join(home, 'bin', 'tonton-update'))).toBe(false)
      if (process.platform === 'darwin') expect(readFileSync(join(home, 'bin', 'tonton-tray'), 'utf8')).toBe(tray)
    },
  )

  test('revoking the machine signs it out and removes its sessions', async () => {
    expect((await api(`/api/machines/${machine.machineId}`, { method: 'DELETE', token: otherAccountToken })).status).toBe(404)
    expect((await api(`/api/machines/${machine.machineId}`, { method: 'DELETE', token: accountToken })).ok).toBe(true)
    await eventually(() => app.messages.some(m => m.t === 'removed' && m.sessionId === sessionId), 'the removal')
    expect((await api('/api/agent/ping', { token: machine.token })).status).toBe(401)
  })
})
