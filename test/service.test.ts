// The background service against two real relays: it keeps the machine online, and `tonton relay` moves it.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seal } from '../agent/src/crypto'
import type { ServiceStatus } from '../agent/src/service/status'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import type { MachineSummary, RelayToApp } from '../shared/protocol'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const dir = mkdtempSync(join(tmpdir(), 'tonton-service-'))
const home = join(dir, 'agent')
const env = { ...process.env, TONTON_HOME: home, TONTON_SERVICE: 'off' } as Record<string, string>
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')

interface Relay {
  stop(): void
  url: string
  token: string
  machines: MachineSummary[]
}

const relays: Relay[] = []
let service: ReturnType<typeof Bun.spawn>

async function relayWithApp(name: string): Promise<Relay> {
  const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, name) }))
  const url = `http://127.0.0.1:${relay.server.port}`
  const { token } = await (await fetch(`${url}/api/accounts`, { method: 'POST' })).json()
  const result: Relay = { stop: relay.stop, url, token, machines: [] }
  const socket = new WebSocket(`${url.replace('http', 'ws')}/ws/app`, { headers: { authorization: `Bearer ${token}` } } as never)
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data)) as RelayToApp
    if (message.t === 'snapshot' || message.t === 'machines') result.machines = message.machines
  }
  await new Promise(resolve => (socket.onopen = resolve))
  relays.push(result)
  return result
}

async function connectionCode(relay: Relay, server = relay.url): Promise<string> {
  const response = await fetch(`${relay.url}/api/enrollments`, { method: 'POST', headers: { authorization: `Bearer ${relay.token}` } })
  const { code } = await response.json()
  return `${code}.${key}@${server}`
}

async function tonton(...args: string[]) {
  const child = Bun.spawn(['bun', AGENT, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { exitCode, output: (stdout + stderr).trim() }
}

const status = () => {
  try {
    return JSON.parse(readFileSync(join(home, 'status.json'), 'utf8')) as ServiceStatus
  } catch {
    return null
  }
}

async function eventually<T>(read: () => T | undefined | null | false, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

let first: Relay
let second: Relay

beforeAll(async () => {
  first = await relayWithApp('first')
  second = await relayWithApp('second')
  // Enrolled on the first relay, as the install script would leave it.
  const { code } = await (
    await fetch(`${first.url}/api/enrollments`, { method: 'POST', headers: { authorization: `Bearer ${first.token}` } })
  ).json()
  const name = await seal(key, { name: 'PC-Service' })
  const machine = await (await fetch(`${first.url}/api/machines/claim`, { method: 'POST', body: JSON.stringify({ code, name }) })).json()
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: first.url, ...machine, key, machine: 'PC-Service' }))
  service = Bun.spawn(['bun', AGENT, 'service'], { env, stdout: 'ignore', stderr: 'ignore' })
})

afterAll(() => {
  service?.kill()
  for (const relay of relays) relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('the service keeps the machine online without any session', async () => {
  await eventually(() => first.machines[0]?.online, 'the machine online')
  expect(first.machines[0].agentVersion).toMatch(/^\d+\.\d+\.\d+$/)
  expect(await eventually(() => status()?.state === 'connected' && status(), 'the status')).toMatchObject({ relay: first.url })
})

test('only one service runs per machine', async () => {
  const other = Bun.spawn(['bun', AGENT, 'service'], { env, stdout: 'ignore', stderr: 'ignore' })
  expect(await other.exited).toBe(0)
  expect(service.exitCode).toBeNull()
})

test('an address the relay does not know this machine at is refused', async () => {
  const result = await tonton('relay', second.url)
  expect(result.exitCode).toBe(1)
  expect(result.output).toContain('does not know this machine')
})

test('another address of the same relay keeps the enrollment', async () => {
  const alias = first.url.replace('127.0.0.1', 'localhost')
  const result = await tonton('relay', `${alias}/`)
  expect(result).toEqual({ exitCode: 0, output: `Now using ${new URL(alias).host}.` })
  await eventually(() => status()?.relay === alias && status()?.state === 'connected', 'the service on the new address')
})

test('a connection code moves the machine to another relay and account, the service follows', async () => {
  const result = await tonton('relay', await connectionCode(second))
  expect(result).toEqual({ exitCode: 0, output: `Connected to ${new URL(second.url).host} as "PC-Service".` })
  await eventually(() => second.machines[0]?.online, 'the machine on the second relay')
  await eventually(() => first.machines[0] && !first.machines[0].online, 'the machine gone from the first relay')
  expect(status()).toMatchObject({ state: 'connected', relay: second.url })
})

test('garbage is refused with a hint', async () => {
  const result = await tonton('relay', 'not a relay')
  expect(result.exitCode).toBe(1)
  expect(result.output).toContain('Enter a relay address')
})
