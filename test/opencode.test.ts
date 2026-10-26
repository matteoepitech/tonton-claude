// Real relay and real `tonton opencode` bridge, fed the events of a real OpenCode 2 run, with a client playing the app.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open, seal } from '../agent/src/crypto'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import type { Entry, RelayToApp, SessionInfo, SessionMeta, SessionSummary } from '../shared/protocol'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const FIXTURE = join(import.meta.dir, '../agent/test/fixtures/opencode-2.0.32.jsonl')
const SESSION = 'ses_e872d9012ffeqUp0ZMJp9G4Gx2'
const dir = mkdtempSync(join(tmpdir(), 'tonton-opencode-e2e-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`

let key: string
let bridge: ReturnType<typeof Bun.spawn>
const messages: RelayToApp[] = []
const raw: string[] = []
let app: WebSocket

const api = (path: string, init: RequestInit & { token?: string } = {}) =>
  fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
  })

async function eventually<T>(read: () => T | undefined | false, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read()
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

beforeAll(async () => {
  const account = await (await api('/api/accounts', { method: 'POST' })).json()
  key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const { secret } = await (await api('/api/account/token', { method: 'POST', token: account.token, body: '{}' })).json()
  const joinRequest = { account: account.accountId, secret, name: await seal(key, { name: 'Linux-Box' }) }
  const machine = await (await api('/api/machines/join', { method: 'POST', body: JSON.stringify(joinRequest) })).json()

  const home = join(dir, 'agent')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: base, ...machine, key, machine: 'Linux-Box', version: '0.6.0' }))

  app = new WebSocket(`${base.replace('http', 'ws')}/ws/app`, { headers: { authorization: `Bearer ${account.token}` } } as never)
  app.onmessage = event => {
    raw.push(String(event.data))
    messages.push(JSON.parse(String(event.data)))
  }
  await new Promise(resolve => (app.onopen = resolve))

  bridge = Bun.spawn(['bun', AGENT, 'opencode'], {
    env: { ...process.env, TONTON_HOME: home, TONTON_SERVICE: 'off' },
    stdin: 'pipe',
  })
  bridge.stdin.write(readFileSync(FIXTURE, 'utf8'))
  bridge.stdin.flush()
}, 20_000)

afterAll(() => {
  bridge?.kill()
  app?.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('OpenCode through the relay', () => {
  test('the session shows up as OpenCode, done, read only', async () => {
    const session = await eventually(() => latest()?.agentOnline && latest()?.status === 'idle' && latest(), 'the session to finish')
    expect(session.canChat).toBe(false)
    const info = await open<SessionInfo>(key, session.info as string)
    expect(info).toMatchObject({ machine: 'Linux-Box', cwd: '/Users/me/code/shop', project: 'shop', tool: 'opencode' })
    const meta = await eventually(() => latest()?.meta, 'the meta')
    expect(await open<SessionMeta>(key, meta)).toMatchObject({ title: 'Probe title', tokens: { input: 240, output: 60 } })
  })

  test('the app decrypts the conversation, the relay only sees ciphertext', async () => {
    app.send(JSON.stringify({ t: 'subscribe', sessionId: SESSION }))
    const history = await eventually(() => {
      const found = messages.findLast(m => m.t === 'history' && m.sessionId === SESSION)
      return found?.t === 'history' && found.entries.length >= 5 && found
    }, 'the history')
    if (history.t !== 'history') throw new Error('unexpected message')
    const entries = await Promise.all(history.entries.map(entry => open<Entry>(key, entry.blob)))
    expect(entries.map(entry => entry.kind)).toEqual(['user', 'tool', 'assistant', 'tool_result', 'assistant'])
    for (const secret of ['Say hi', 'hi-from-probe', 'Probe title', 'shop', 'Linux-Box']) expect(raw.join('')).not.toContain(secret)
  })

  test('its sessions end with OpenCode', async () => {
    bridge.stdin.end()
    await eventually(() => latest()?.status === 'ended', 'the session to end')
  })
})
