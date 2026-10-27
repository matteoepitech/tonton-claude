import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open, seal } from '../../shared/crypto'
import type { AgentLog, AgentMessage } from '../../shared/protocol'
import type { AgentConfig } from '../src/config'
import { handleLogRequest, readLogTail, redact } from '../src/logs'

const dir = mkdtempSync(join(tmpdir(), 'tonton-logs-'))
const newKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
const key = newKey()
const token = `tm_${'a'.repeat(12)}_${'b'.repeat(43)}`
const config = { server: 'http://x', machineId: 'machine00001', token, key, machine: 'PC' } as AgentConfig
const now = Date.parse('2026-10-26T12:00:00Z')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function logFile(name: string, lines: string[]): string {
  const file = join(dir, name)
  writeFileSync(file, lines.map(line => `${line}\n`).join(''))
  return file
}

describe('the end of the log', () => {
  test('a short log comes whole', () => {
    const file = logFile('short.log', ['one', 'two', 'three'])
    expect(readLogTail(file)).toEqual({ lines: ['one', 'two', 'three'], truncated: false, size: 14 })
  })

  test('a long one is read from its end, without the line the read cuts', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i} ${'é'.repeat(20)}`)
    const file = logFile('long.log', lines)
    const tail = readLogTail(file, 300, 4096)
    expect(tail.truncated).toBe(true)
    expect(tail.lines.at(-1)).toBe(lines.at(-1))
    expect(lines.slice(-tail.lines.length)).toEqual(tail.lines)
    expect(readLogTail(file, 10).lines).toEqual(lines.slice(-10))
  })

  test('no log yet is an empty one', () => {
    expect(readLogTail(join(dir, 'missing.log'))).toEqual({ lines: [], truncated: false, size: 0 })
  })
})

test('secrets are taken out, whoever logged them', () => {
  const account = `tonton_${Buffer.from(JSON.stringify({ relay: 'https://r', key })).toString('base64url')}`
  const line = `failed ${account} with ${token} key=${key} authorization: Bearer ta_xyz proxy http://jane:s3cr%40t@proxy:3128`
  const clean = redact(line, [key, token])
  for (const secret of [key, 'bbbbbbbbbbbbbbbbbbbb', account.slice(7), 'ta_xyz', 's3cr']) expect(clean).not.toContain(secret)
  expect(clean).toContain('http://jane:[redacted]@proxy:3128')
  expect(redact('service: connecting {"relay":"https://relay.example.com"}', [key])).toBe(
    'service: connecting {"relay":"https://relay.example.com"}',
  )
})

describe('a request from the app', () => {
  const file = logFile('agent.log', ['2026-10-26T11:59:00.000Z [42] service started', `oops ${token}`])

  async function ask(fields: { requestId?: string; machineId?: string; issuedAt?: string }, sealWith = key, requestId = 'request0001') {
    const messages: AgentMessage[] = []
    const relay = { post: (build: () => Promise<AgentMessage | null>) => void build().then(m => m && messages.push(m)) }
    const request = { requestId, machineId: config.machineId, issuedAt: new Date(now).toISOString(), ...fields }
    await handleLogRequest(config, requestId, await seal(sealWith, request), relay, { file, now })
    await Bun.sleep(20)
    const answer = messages[0]
    if (!answer) return null
    if (answer.t !== 'agent_logs') throw new Error('unexpected message')
    expect(answer.requestId).toBe(requestId)
    return open<AgentLog>(key, answer.logs)
  }

  test('gets the end of the log, sealed, for that request and machine', async () => {
    const logs = await ask({})
    expect(logs).toMatchObject({ requestId: 'request0001', machineId: config.machineId, truncated: false, at: new Date(now).toISOString() })
    expect(logs?.lines[0]).toBe('2026-10-26T11:59:00.000Z [42] service started')
    expect(logs?.lines.join('\n')).not.toContain(token)
  })

  test('sealed with another key, for another machine or relabelled: no answer', async () => {
    expect(await ask({}, newKey())).toBeNull()
    expect(await ask({ machineId: 'machine00002' })).toBeNull()
    expect(await ask({ requestId: 'request0002' })).toBeNull()
  })

  test('an old request gets a reason, not the log', async () => {
    const logs = await ask({ issuedAt: new Date(now - 11 * 60_000).toISOString() })
    expect(logs).toMatchObject({ lines: [], error: 'The request expired. Check the clock of this machine.' })
  })
})
