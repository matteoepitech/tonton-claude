import { describe, expect, test } from 'bun:test'
import { base64ToBytes, base64UrlToBytes, bytesToBase64, bytesToBase64Url } from '../base64'
import { modelFamily, modelName } from '../model'
import { decodeEntry, decodeMachineHealth, decodeSessionInfo, decodeSessionMeta } from '../payloads'
import type { SessionSummary } from '../protocol'
import {
  contextWindow,
  displayStatusText,
  mostUrgent,
  parseDate,
  preferredSession,
  type Session,
  sortSessions,
  usageLevel,
} from '../session'
import { parseRelayMessage } from '../wire'

const session = (fields: Partial<Session>): Session => ({
  id: 's',
  machineId: 'm',
  machine: 'PC',
  platform: null,
  cwd: '/x',
  project: 'x',
  title: null,
  status: 'idle',
  statusText: null,
  agentOnline: true,
  canChat: true,
  pendingPermissions: [],
  costUSD: null,
  tokens: null,
  context: null,
  startedAt: 0,
  lastActivity: 0,
  lastMessage: null,
  fiveHourLimit: null,
  sevenDayLimit: null,
  terminal: false,
  commands: ['compact', 'clear'],
  model: null,
  tool: null,
  branch: null,
  ...fields,
})

describe('base64', () => {
  test('matches Node for every length and both alphabets', () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33, 70_000]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length))
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
      expect(bytesToBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'))
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
      expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes)
    }
  })

  test('throws on what is not base64', () => {
    expect(() => base64ToBytes('not base64!')).toThrow()
    expect(() => base64UrlToBytes('a')).toThrow()
  })
})

describe('sealed payloads', () => {
  test('a field of the wrong type drops the payload, unknown fields are ignored', () => {
    expect(decodeSessionInfo({ machine: 'PC', cwd: '/x', project: 'x', extra: 1 })).toEqual({ machine: 'PC', cwd: '/x', project: 'x' })
    expect(decodeSessionInfo({ machine: 'PC', cwd: '/x' })).toBeNull()
    expect(decodeSessionMeta({ title: 'ok', costUSD: '1' })).toBeNull()
    expect(decodeSessionMeta({ title: null, tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })).toEqual({
      tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    })
    expect(decodeSessionMeta({ tokens: { input: 1.5, output: 2, cacheRead: 0, cacheWrite: 0 } })).toBeNull()
    expect(decodeSessionMeta('meta')).toBeNull()
    expect(decodeSessionMeta({ branch: 'feat/login' })).toEqual({ branch: 'feat/login' })
    expect(decodeSessionMeta({ branch: 3 })).toBeNull()
    expect(decodeMachineHealth({ cpu: 0.1, memoryUsed: 1, memoryTotal: 2, at: 'now' })).toEqual({
      cpu: 0.1,
      memoryUsed: 1,
      memoryTotal: 2,
      battery: null,
      at: 'now',
    })
  })

  test('entries of unknown kinds are dropped, missing fields get empty values', () => {
    expect(decodeEntry({ id: '1', ts: 't', kind: 'future' })).toBeNull()
    expect(decodeEntry({ id: '1', ts: 't', kind: 'tool' })).toEqual({
      id: '1',
      ts: 't',
      kind: 'tool',
      toolUseId: '',
      name: '',
      summary: '',
    })
    expect(decodeEntry({ id: '1', ts: 't', kind: 'user', text: 'hi', images: [{ mediaType: 'image/png' }] })).toBeNull()
    expect(decodeEntry({ id: '1', ts: 't', kind: 'assistant', text: 'hi', isError: 'no' })).toBeNull()
  })
})

describe('relay messages', () => {
  const wire: SessionSummary = {
    id: 's1',
    machineId: 'm1',
    status: 'working',
    agentOnline: true,
    canChat: false,
    info: null,
    meta: 'blob',
    statusDetail: null,
    pendingPermissions: [],
    startedAt: '2026-10-25T10:00:00.000Z',
    lastActivity: '2026-10-25T10:00:00.000Z',
  }

  test('sessions and machines that do not have the expected shape are left out', () => {
    const message = parseRelayMessage(
      JSON.stringify({
        t: 'snapshot',
        sessions: [wire, { ...wire, id: 2 }, { ...wire, status: 'dancing' }, null],
        machines: [{ id: 'm1' }],
      }),
    )
    expect(message).toEqual({ t: 'snapshot', sessions: [wire], machines: [] })
  })

  test('unknown or malformed messages are ignored', () => {
    expect(parseRelayMessage('{"t":"brand_new","x":1}')).toBeNull()
    expect(parseRelayMessage('{"t":"session"}')).toBeNull()
    expect(parseRelayMessage('{"t":"history","sessionId":"s1","entries":"no"}')).toBeNull()
    expect(parseRelayMessage('not json')).toBeNull()
    expect(parseRelayMessage('[1]')).toBeNull()
    expect(parseRelayMessage('{"t":"agent_update","machineId":"m","ok":false,"reason":"weird"}')).toEqual({
      t: 'agent_update',
      machineId: 'm',
      ok: false,
      detail: null,
    })
  })
})

describe('sessions', () => {
  test("Claude Code's notification texts are shortened like in the notch", () => {
    expect(displayStatusText(session({ statusText: 'Claude needs your permission to use Bash' }))).toBe('Wants to use Bash')
    expect(displayStatusText(session({ statusText: 'Claude is waiting for your input' }))).toBe('Waiting for you')
    expect(displayStatusText(session({ statusText: 'rate_limit' }))).toBe('Usage limit reached')
    expect(displayStatusText(session({ status: 'permission' }))).toBe('Needs approval')
  })

  test('live sessions come first, then the most recent, and the one that needs the user is shown first', () => {
    const list = [
      session({ id: 'old', status: 'ended', lastActivity: 50 }),
      session({ id: 'idle', status: 'idle', lastActivity: 10 }),
      session({ id: 'busy', status: 'working', lastActivity: 20 }),
      session({ id: 'unknown', status: 'idle', lastActivity: null }),
    ]
    expect(sortSessions(list).map(s => s.id)).toEqual(['busy', 'idle', 'unknown', 'old'])
    expect(list[0].id).toBe('old')
    expect(preferredSession([...list, session({ id: 'asks', status: 'permission' })])?.id).toBe('asks')
    expect(preferredSession([])).toBeNull()
    expect(mostUrgent(['idle', 'working', 'error'])).toBe('error')
    expect(mostUrgent(['ended'])).toBeNull()
  })

  test('usage windows and context fill', () => {
    const now = Date.parse('2026-10-25T10:00:00Z')
    expect(usageLevel({ usedPercent: 79.9, resetsAt: now + 1 }, now)).toBe('normal')
    expect(usageLevel({ usedPercent: 80, resetsAt: now + 1 }, now)).toBe('high')
    expect(usageLevel({ usedPercent: 100, resetsAt: now + 1 }, now)).toBe('reached')
    expect(usageLevel({ usedPercent: 100, resetsAt: now }, now)).toBeNull()
    expect(contextWindow(150_000)).toEqual({ usedTokens: 150_000, windowTokens: 200_000 })
    expect(contextWindow(250_000)).toEqual({ usedTokens: 250_000, windowTokens: 1_000_000 })
    // A 1M session whose model name gave 200K: what it already uses says otherwise.
    expect(contextWindow(814_732, 200_000)).toEqual({ usedTokens: 814_732, windowTokens: 1_000_000 })
    expect(contextWindow(150_000, 200_000)).toEqual({ usedTokens: 150_000, windowTokens: 200_000 })
    expect(contextWindow(10, 500)).toEqual({ usedTokens: 10, windowTokens: 500 })
  })

  test('dates are ISO 8601 with a zone, or nothing', () => {
    expect(parseDate('2026-10-25T10:00:00.123Z')).toBe(Date.UTC(2026, 9, 25, 10, 0, 0, 123))
    expect(parseDate('2026-10-25T12:00:00+02:00')).toBe(Date.UTC(2026, 9, 25, 10))
    expect(parseDate('2026-10-25')).toBeNull()
    expect(parseDate('yesterday')).toBeNull()
    expect(parseDate(null)).toBeNull()
  })
})

describe('models', () => {
  test("are named like Claude Code's menu does, as in the app", () => {
    const names: Record<string, string> = {
      'claude-opus-4-5-20251101': 'Opus 4.5',
      'claude-sonnet-5-5[1m]': 'Sonnet 5.5',
      'claude-haiku-5-5': 'Haiku 5.5',
      'claude-opus-4-20250514': 'Opus 4',
      'claude-3-5-sonnet-20241022': 'Sonnet 3.5',
      'claude-3-opus-20240229': 'Opus 3',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0': 'Haiku 4.5',
      'claude-haiku-4-5@20251001': 'Haiku 4.5',
      'claude-fable-5-1': 'Fable 5.1',
      'claude-3-5-haiku-latest': 'Haiku 3.5',
      sonnet: 'Sonnet',
      'gpt-5': 'gpt-5',
      'claude-instant': 'claude-instant',
    }
    for (const [id, name] of Object.entries(names)) expect(modelName(id)).toBe(name)
    expect(modelFamily('us.anthropic.claude-opus-4-1-20250805-v1:0')).toBe('opus')
    expect(modelFamily('claude-3-5-haiku-20241022')).toBe('haiku')
    expect(modelFamily('claude-fable-5-1')).toBeNull()
    expect(modelFamily('gpt-5')).toBeNull()
  })
})
