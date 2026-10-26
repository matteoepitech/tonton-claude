// The metrics page: off by default, behind its own token, and only ever counts.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VERSION } from '../../shared/version'
import { loadConfig } from '../src/config'
import { startRelay } from '../src/main'

const TOKEN = 'metrics-token-for-the-tests'
const dir = mkdtempSync(join(tmpdir(), 'tonton-metrics-'))
const relays: { stop(): void }[] = []
const sockets: WebSocket[] = []

afterAll(() => {
  for (const socket of sockets) socket.close()
  for (const relay of relays) relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

function start(env: Record<string, string>) {
  const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, String(relays.length)), ...env }))
  relays.push(relay)
  return `http://127.0.0.1:${relay.server.port}`
}

const scrape = (base: string, token?: string) => fetch(`${base}/metrics`, { headers: token ? { authorization: `Bearer ${token}` } : {} })

async function post(base: string, path: string, body: object, token?: string) {
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
  return (await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })).json()
}

async function connect(base: string, path: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(`${base.replace('http', 'ws')}${path}`, { headers: { authorization: `Bearer ${token}` } } as never)
  sockets.push(socket)
  await new Promise(resolve => (socket.onopen = resolve))
  return socket
}

/** The value of one sample, `name{labels}` exactly as written on its line. */
const sample = (page: string, series: string) => {
  const line = page.split('\n').find(l => l.startsWith(`${series} `))
  return line === undefined ? undefined : Number(line.slice(series.length + 1))
}

async function eventually<T>(read: () => Promise<T | undefined | false>, label: string): Promise<T> {
  for (let i = 0; i < 80; i++) {
    const value = await read()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('the token is optional and must be long', () => {
  expect(loadConfig({}).metricsToken).toBeNull()
  expect(loadConfig({ TONTON_METRICS_TOKEN: '' }).metricsToken).toBeNull()
  expect(() => loadConfig({ TONTON_METRICS_TOKEN: 'short' })).toThrow('24+ characters')
  expect(loadConfig({ TONTON_METRICS_TOKEN: TOKEN }).metricsToken).toBe(TOKEN)
})

test('without a token there is no metrics page, and /health still answers', async () => {
  const base = start({})
  expect((await scrape(base)).status).toBe(404)
  expect((await scrape(base, TOKEN)).status).toBe(404)
  const health = await fetch(`${base}/health`)
  expect(health.status).toBe(200)
  expect(await health.text()).toBe('ok')
})

test('the page needs its token', async () => {
  const base = start({ TONTON_METRICS_TOKEN: TOKEN })
  expect((await scrape(base)).status).toBe(401)
  expect((await scrape(base, `${TOKEN}x`)).status).toBe(401)
  const account = await post(base, '/api/accounts', {})
  // Neither does an account token open it.
  expect((await scrape(base, account.token)).status).toBe(401)
  const page = await scrape(base, TOKEN)
  expect(page.status).toBe(200)
  expect(page.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8')
})

test('counts sockets, sessions and bytes, and nothing that names or carries content', async () => {
  const base = start({ TONTON_METRICS_TOKEN: TOKEN })
  const account = await post(base, '/api/accounts', {})
  const { secret } = await post(base, '/api/account/token', {}, account.token)
  const machine = await post(base, '/api/machines/join', { account: account.accountId, secret, name: 'sealed-machine-name' })
  const app = await connect(base, '/ws/app', account.token)
  const agent = await connect(base, '/ws/agent', machine.token)
  agent.send(JSON.stringify({ t: 'hello', sessionId: 'session-id-1', info: 'sealed-info', channel: true }))
  const entries = [
    { id: 'entry-id-1', ts: '2026-01-01T00:00:00.000Z', blob: 'sealed-blob-1' },
    { id: 'entry-id-2', ts: '2026-01-01T00:00:01.000Z', blob: 'sealed-blob-2' },
  ]
  agent.send(JSON.stringify({ t: 'entries', sessionId: 'session-id-1', entries, reset: true }))

  const page = await eventually(async () => {
    const text = await (await scrape(base, TOKEN)).text()
    return sample(text, 'tonton_history_entries') === 2 && text
  }, 'the entries in the metrics')
  expect(sample(page, 'tonton_accounts')).toBe(1)
  expect(sample(page, 'tonton_machines')).toBe(1)
  expect(sample(page, 'tonton_machines_online')).toBe(1)
  expect(sample(page, 'tonton_sockets{role="app"}')).toBe(1)
  expect(sample(page, 'tonton_sockets{role="agent"}')).toBe(1)
  expect(sample(page, 'tonton_sessions{status="working"}')).toBe(0)
  expect(sample(page, 'tonton_sessions{status="idle"}')).toBe(1)
  expect(sample(page, 'tonton_history_bytes')).toBe('sealed-blob-1'.length + 'sealed-blob-2'.length)
  expect(sample(page, 'tonton_ws_messages_received_total{role="agent"}')).toBe(2)
  expect(sample(page, 'tonton_ws_received_bytes_total{role="agent"}')).toBeGreaterThan(100)
  // The snapshot, then the session's updates.
  expect(sample(page, 'tonton_ws_messages_sent_total{role="app"}')).toBeGreaterThanOrEqual(2)
  expect(sample(page, 'tonton_ws_sent_bytes_total{role="app"}')).toBeGreaterThan(100)
  expect(sample(page, `tonton_relay_info{version="${VERSION}"}`)).toBe(1)

  for (const secretText of ['sealed-', account.accountId, machine.machineId, 'session-id-1', 'entry-id']) {
    expect(page).not.toContain(secretText)
  }
  // Valid exposition format: help and type lines, then `name{labels} value`.
  for (const line of page.trimEnd().split('\n')) {
    expect(line).toMatch(/^(# (HELP|TYPE) tonton_[a-z_]+ .+|tonton_[a-z_]+(\{[a-z]+="[^"]*"\})? \d+)$/)
  }
  app.close()
  await eventually(async () => sample(await (await scrape(base, TOKEN)).text(), 'tonton_sockets{role="app"}') === 0, 'the app gone')
})
