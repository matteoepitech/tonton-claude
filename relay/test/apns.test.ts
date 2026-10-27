// The APNs client against a local HTTP/2 server standing in for Apple.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import http2 from 'node:http2'
import { ApnsClient } from '../src/apns'

interface Received {
  headers: http2.IncomingHttpHeaders
  body: string
}

const received: Received[] = []
let reply: (headers: http2.IncomingHttpHeaders) => { status: number; body?: string } = () => ({ status: 200 })
const server = http2.createServer()
server.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
  let body = ''
  stream.on('data', chunk => (body += chunk))
  stream.on('end', () => {
    received.push({ headers, body })
    const { status, body: answer } = reply(headers)
    stream.respond({ ':status': status })
    stream.end(answer ?? '')
  })
})

let keys: CryptoKeyPair
let pem: string
let origin: string

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')
  pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----\n`
})

afterAll(() => server.close())

const client = (now = () => 1_800_000_000_000) =>
  new ApnsClient(
    { key: pem, keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'tech.d3l.tontonclaude.ios' },
    { sandbox: origin, production: origin },
    now,
  )

async function verify(jwt: string) {
  const [header, claims, signature] = jwt.split('.')
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    keys.publicKey,
    Buffer.from(signature, 'base64url'),
    new TextEncoder().encode(`${header}.${claims}`),
  )
  return {
    ok,
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString()),
  }
}

test('a push carries what Apple asks for, signed with the team key', async () => {
  received.length = 0
  const apns = client()
  const result = await apns.send({
    token: 'ab'.repeat(32),
    environment: 'sandbox',
    type: 'alert',
    priority: 10,
    payload: '{"aps":{}}',
    expiration: 1_800_000_600,
    collapseId: 'r1',
  })
  await apns.send({ token: 'cd'.repeat(40), environment: 'production', type: 'liveactivity', priority: 5, payload: '{}' })
  apns.close()

  expect(result).toEqual({ status: 200, reason: null })
  const [alert, activity] = received
  expect(alert.headers[':path']).toBe(`/3/device/${'ab'.repeat(32)}`)
  expect(alert.headers).toMatchObject({
    'apns-topic': 'tech.d3l.tontonclaude.ios',
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-expiration': '1800000600',
    'apns-collapse-id': 'r1',
  })
  expect(alert.body).toBe('{"aps":{}}')
  expect(activity.headers).toMatchObject({
    'apns-topic': 'tech.d3l.tontonclaude.ios.push-type.liveactivity',
    'apns-push-type': 'liveactivity',
  })
  expect(activity.headers['apns-collapse-id']).toBeUndefined()

  const jwt = await verify(String(alert.headers.authorization).replace('bearer ', ''))
  expect(jwt).toEqual({ ok: true, header: { alg: 'ES256', kid: 'KEY1234567' }, claims: { iss: 'TEAM123456', iat: 1_800_000_000 } })
  // The same token is reused, as Apple wants.
  expect(activity.headers.authorization).toBe(alert.headers.authorization)
})

test("Apple's reason comes back, and an expired token is renewed", async () => {
  received.length = 0
  let time = 1_800_000_000_000
  const apns = client(() => time)
  reply = () => ({ status: 403, body: '{"reason":"ExpiredProviderToken"}' })
  const push = { token: 'ab'.repeat(32), environment: 'sandbox', type: 'alert', priority: 10, payload: '{}' } as const
  expect(await apns.send(push)).toEqual({ status: 403, reason: 'ExpiredProviderToken' })
  time += 1000
  reply = () => ({ status: 410, body: '{"reason":"Unregistered","timestamp":1}' })
  expect(await apns.send(push)).toEqual({ status: 410, reason: 'Unregistered' })
  apns.close()
  const [first, second] = await Promise.all(received.map(r => verify(String(r.headers.authorization).replace('bearer ', ''))))
  expect(second.claims.iat).toBe(first.claims.iat + 1)
  reply = () => ({ status: 200 })
})

test('an unreachable Apple or an unusable key never throws', async () => {
  const down = new ApnsClient(
    { key: pem, keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 't' },
    { sandbox: 'http://127.0.0.1:1', production: 'http://127.0.0.1:1' },
  )
  const push = { token: 'ab'.repeat(32), environment: 'sandbox', type: 'alert', priority: 10, payload: '{}' } as const
  expect((await down.send(push)).status).toBe(0)
  down.close()
  const broken = new ApnsClient({
    key: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----',
    keyId: 'K',
    teamId: 'T',
    topic: 't',
  })
  expect(await broken.send(push)).toEqual({ status: 0, reason: 'InvalidKey' })
})
