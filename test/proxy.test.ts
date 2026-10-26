// The agent behind an HTTP proxy that wants a password, and is the only way to the relay: the relay's name resolves
// nowhere but in the proxy. Joining, the background service's WebSocket and the hooks all have to go through it.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { encodeAccountToken } from '../shared/account-token'
import type { MachineSummary, RelayToApp, SessionSummary } from '../shared/protocol'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const RELAY_HOST = 'relay.tonton.invalid'
const PASSWORD = Buffer.from('jane:s3cr@t').toString('base64')
const dir = mkdtempSync(join(tmpdir(), 'tonton-proxy-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const port = relay.server.port
const direct = `http://127.0.0.1:${port}`
const newKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')

/** What reached the proxy: the request line, and whether it carried the password. */
const requests: string[] = []
const proxy = createServer(client => {
  client.on('error', () => {})
  client.once('data', chunk => {
    const head = chunk.toString('latin1')
    const [method, target] = head.split(' ')
    const authorized = new RegExp(`\\r\\nproxy-authorization: *basic ${PASSWORD}\\r\\n`, 'i').test(head)
    requests.push(`${method} ${target}${authorized ? '' : ' without the password'}`)
    if (!authorized)
      return client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\nContent-Length: 0\r\n\r\n')
    const url = new URL(method === 'CONNECT' ? `http://${target}` : target)
    if (url.hostname !== RELAY_HOST) return client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
    tunnel(client, Number(url.port), method === 'CONNECT' ? chunk.subarray(head.indexOf('\r\n\r\n') + 4) : chunk, method === 'CONNECT')
  })
})

function tunnel(client: Socket, to: number, first: Buffer, connected: boolean) {
  const upstream = connect(to, '127.0.0.1', () => {
    if (connected) client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (first.length) upstream.write(first)
    client.pipe(upstream).pipe(client)
  })
  upstream.on('error', () => client.destroy())
}

const proxyUrl = () => `http://jane:s3cr%40t@127.0.0.1:${(proxy.address() as { port: number }).port}`
let machines: MachineSummary[] = []
let sessions: SessionSummary[] = []
let app: WebSocket
let accountId: string
let accountToken: string
let secret: string
const services: ReturnType<typeof Bun.spawn>[] = []

async function eventually<T>(read: () => T | undefined | null | false, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** An agent home of its own, run with these variables only, so the developer's proxy setup plays no part. */
function agentEnv(name: string, variables: Record<string, string>) {
  const home = join(dir, name)
  mkdirSync(home, { recursive: true })
  return { PATH: process.env.PATH ?? '', HOME: home, TONTON_HOME: home, TONTON_SERVICE: 'off', ...variables }
}

async function tonton(env: Record<string, string>, args: string[], stdin?: string) {
  const child = Bun.spawn(['bun', AGENT, ...args], { env, stdin: stdin ? new Blob([stdin]) : 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { exitCode, output: (stdout + stderr).trim() }
}

function startService(env: Record<string, string>) {
  services.push(Bun.spawn(['bun', AGENT, 'service'], { env, stdout: 'ignore', stderr: 'ignore' }))
}

/** The token the app shows in Machines, for the relay at this address. */
const joinToken = (relayUrl: string) => encodeAccountToken({ relay: relayUrl, account: accountId, secret, key: newKey() })

beforeAll(async () => {
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const account = await (await fetch(`${direct}/api/accounts`, { method: 'POST' })).json()
  accountId = account.accountId
  accountToken = account.token
  const headers = { authorization: `Bearer ${accountToken}`, 'content-type': 'application/json' }
  secret = (await (await fetch(`${direct}/api/account/token`, { method: 'POST', headers, body: '{}' })).json()).secret
  app = new WebSocket(`ws://127.0.0.1:${port}/ws/app`, { headers: { authorization: `Bearer ${accountToken}` } } as never)
  app.onmessage = event => {
    const message = JSON.parse(String(event.data)) as RelayToApp
    if (message.t === 'snapshot' || message.t === 'machines') machines = message.machines
    if (message.t === 'snapshot') sessions = message.sessions
    if (message.t === 'session') sessions = [...sessions.filter(s => s.id !== message.session.id), message.session]
  }
  await new Promise(resolve => (app.onopen = resolve))
})

afterAll(() => {
  for (const service of services) service.kill()
  app?.close()
  proxy.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

const behindProxy = () => agentEnv('behind-proxy', { HTTP_PROXY: proxyUrl() })

test('a machine joins, stays online and reports hooks through HTTP_PROXY, with its password', async () => {
  const env = behindProxy()
  const relayUrl = `http://${RELAY_HOST}:${port}`
  const joined = await tonton(env, ['token', joinToken(relayUrl)])
  expect(joined).toMatchObject({ exitCode: 0 })
  expect(requests).toContain(`POST ${relayUrl}/api/machines/join`)

  startService(env)
  await eventually(() => machines.some(machine => machine.online), 'the machine online')
  expect(requests).toContain(`CONNECT ${RELAY_HOST}:${port}`)

  const sessionId = `proxied-${Date.now()}`
  await tonton(env, ['hook'], JSON.stringify({ hook_event_name: 'SessionStart', session_id: sessionId, source: 'startup' }))
  await eventually(() => sessions.find(session => session.id === sessionId), 'the session from the hook')
  expect(requests).toContain(`POST ${relayUrl}/api/hook`)
  expect(requests.filter(request => request.endsWith('without the password'))).toEqual([])
})

test('tonton status names the proxy, never its password', async () => {
  const result = await tonton(behindProxy(), ['status'])
  expect(result.output).toContain(`proxy:   http://127.0.0.1:${(proxy.address() as { port: number }).port} (from HTTP_PROXY)`)
  expect(result.output).toContain('relay reachable, machine token accepted')
  expect(result.output).not.toContain('s3cr')
})

test('NO_PROXY sends the relay direct', async () => {
  const env = agentEnv('no-proxy', { HTTP_PROXY: proxyUrl(), NO_PROXY: 'localhost,127.0.0.1' })
  const online = machines.filter(machine => machine.online).length
  requests.length = 0
  expect((await tonton(env, ['token', joinToken(direct)])).exitCode).toBe(0)
  startService(env)
  await eventually(() => machines.filter(machine => machine.online).length > online, 'the second machine online')
  expect(requests).toEqual([])
})

test('a relay on https goes through HTTPS_PROXY, for the WebSocket as for fetch', async () => {
  const env = agentEnv('https-relay', { HTTPS_PROXY: proxyUrl(), HTTP_PROXY: 'http://127.0.0.1:1' })
  const config = { server: 'https://secure.tonton.invalid', machineId: 'machine00001', token: 'tm_x', key: newKey(), machine: 'Box' }
  writeFileSync(join(env.TONTON_HOME, 'config.json'), JSON.stringify(config))
  requests.length = 0
  startService(env)
  await eventually(() => requests.includes('CONNECT secure.tonton.invalid:443'), 'the WebSocket at the proxy')
  requests.length = 0
  await tonton(env, ['status'])
  expect(requests).toContain('CONNECT secure.tonton.invalid:443')
})
