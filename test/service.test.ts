// The background service against two real relays: it keeps the machine online, follows `tonton token`, and is signed
// out when the account token is regenerated.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open } from '../agent/src/crypto'
import type { ServiceStatus } from '../agent/src/service/status'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { encodeAccountToken, parseAccountToken } from '../shared/account-token'
import type { MachineHealth, MachineSummary, RelayToApp } from '../shared/protocol'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const dir = mkdtempSync(join(tmpdir(), 'tonton-service-'))
const home = join(dir, 'agent')
const env = { ...process.env, TONTON_HOME: home, TONTON_SERVICE: 'off' } as Record<string, string>
const newKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')

/** A relay with an account and the app's socket on it. */
interface Relay {
  stop(): void
  url: string
  accountId: string
  token: string
  machines: MachineSummary[]
}

const relays: Relay[] = []
let service: ReturnType<typeof Bun.spawn>

async function relayWithApp(name: string): Promise<Relay> {
  const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, name) }))
  const url = `http://127.0.0.1:${relay.server.port}`
  const { accountId, token } = await (await fetch(`${url}/api/accounts`, { method: 'POST' })).json()
  const result: Relay = { stop: relay.stop, url, accountId, token, machines: [] }
  const socket = new WebSocket(`${url.replace('http', 'ws')}/ws/app`, { headers: { authorization: `Bearer ${token}` } } as never)
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data)) as RelayToApp
    if (message.t === 'snapshot' || message.t === 'machines') result.machines = message.machines
  }
  await new Promise(resolve => (socket.onopen = resolve))
  relays.push(result)
  return result
}

/** What the app shows in Machines: a new secret, and with `regenerate` a new key too. */
async function machineToken(relay: Relay, regenerate = false): Promise<string> {
  const response = await fetch(`${relay.url}/api/account/token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ regenerate }),
  })
  const { secret } = await response.json()
  return encodeAccountToken({ relay: relay.url, account: relay.accountId, secret, key: newKey() })
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
let firstToken: string
let secondToken: string

beforeAll(async () => {
  first = await relayWithApp('first')
  second = await relayWithApp('second')
  mkdirSync(home, { recursive: true })
  firstToken = await machineToken(first)
  expect((await tonton('token', firstToken)).exitCode).toBe(0)
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

test('the service reports the machine health, sealed with the account key', async () => {
  const blob = await eventually(() => first.machines[0]?.health, 'the health report')
  expect(blob).not.toContain('memoryTotal')
  const key = parseAccountToken(firstToken)?.key ?? ''
  const health = await open<MachineHealth>(key, blob)
  expect(health.memoryTotal).toBeGreaterThan(0)
  expect(health.cpu).toBeGreaterThanOrEqual(0)
  expect(health.cpu).toBeLessThanOrEqual(1)
})

test('only one service runs per machine', async () => {
  const other = Bun.spawn(['bun', AGENT, 'service'], { env, stdout: 'ignore', stderr: 'ignore' })
  expect(await other.exited).toBe(0)
  expect(service.exitCode).toBeNull()
})

test('the same token again changes nothing', async () => {
  expect(await tonton('token', firstToken)).toEqual({ exitCode: 0, output: `Already connected to ${new URL(first.url).host}.` })
  expect(first.machines).toHaveLength(1)
})

test('anything but a token is refused with a hint', async () => {
  const result = await tonton('token', first.url)
  expect(result.exitCode).toBe(1)
  expect(result.output).toContain('This is not a Tonton Claude token')
})

test('the token of another relay moves the machine there, the service follows', async () => {
  secondToken = await machineToken(second)
  const result = await tonton('token', secondToken)
  expect(result.exitCode).toBe(0)
  expect(result.output).toStartWith(`Connected to ${new URL(second.url).host} as `)
  await eventually(() => second.machines[0]?.online, 'the machine on the second relay')
  await eventually(() => first.machines[0] && !first.machines[0].online, 'the machine gone from the first relay')
  expect(await eventually(() => status()?.state === 'connected' && status(), 'the status')).toMatchObject({ relay: second.url })
})

test('regenerating the token signs the machine out; only the new token brings it back', async () => {
  const next = await machineToken(second, true)
  await eventually(() => status()?.state === 'revoked', 'the service signed out')
  await eventually(() => second.machines.length === 0, 'the machine gone from the app')

  const refused = await tonton('token', secondToken)
  expect(refused).toEqual({ exitCode: 1, output: 'This token is no longer valid. Copy the current one from Tonton Claude › Machines.' })

  expect((await tonton('token', next)).exitCode).toBe(0)
  await eventually(() => status()?.state === 'connected', 'the service back with the new token')
  await eventually(() => second.machines.filter(machine => machine.online).length === 1, 'the machine back in the app')
})
