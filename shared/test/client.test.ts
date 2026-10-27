import { describe, expect, test } from 'bun:test'
import { type ClientEvent, type ClientState, initialState, RelayClient, reduce, type SocketLike } from '../client'
import { newAccountKey, open, seal } from '../crypto'
import type {
  AgentLog,
  DiagnoseRequest,
  Diagnosis,
  Entry,
  LogRequest,
  PromptPayload,
  RelayToApp,
  SessionName,
  SessionSummary,
} from '../protocol'
import { Vault } from '../vault'

const key = newAccountKey()

async function eventually<T>(read: () => T | undefined | null | false, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Stands in for the relay end of the socket. */
class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  sent: Record<string, unknown>[] = []
  closed = false

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.closed = true
  }
  receive(message: RelayToApp | string) {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) })
  }
}

async function wireSession(id: string, fields: Partial<SessionSummary> = {}): Promise<SessionSummary> {
  return {
    id,
    machineId: 'm1',
    status: 'working',
    agentOnline: true,
    canChat: true,
    info: await seal(key, { machine: 'PC', cwd: `/code/${id}`, project: id }),
    meta: null,
    statusDetail: null,
    pendingPermissions: [],
    startedAt: '2026-10-25T10:00:00.000Z',
    lastActivity: '2026-10-25T10:00:00.000Z',
    ...fields,
  }
}

const sealedEntry = async (entry: Entry) => ({ id: entry.id, ts: entry.ts, blob: await seal(key, entry) })
const text = (id: string, body: string): Entry => ({ id, ts: '2026-10-25T10:00:00.000Z', kind: 'assistant', text: body })

function client(options: { retryMs?: number } = {}) {
  const sockets: FakeSocket[] = []
  const states: ClientState[] = []
  const events: ClientEvent[] = []
  let signedOut = 0
  const relay = new RelayClient({
    vault: new Vault(key),
    connect: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    onChange: state => states.push(state),
    onEvent: event => events.push(event),
    onSignedOut: () => signedOut++,
    ...options,
  })
  return { relay, sockets, states, events, signedOut: () => signedOut }
}

describe('client state', () => {
  test('never changes the state it is given', () => {
    const entries: Entry[] = Object.freeze([]) as unknown as Entry[]
    const frozen = Object.freeze({ ...initialState, selectedId: 's1', entries })
    const next = reduce(frozen, { t: 'entries', sessionId: 's1', entries: [text('a', 'hi')] })
    expect(next.entries).toHaveLength(1)
    expect(frozen.entries).toHaveLength(0)
    expect(reduce(frozen, { t: 'entries', sessionId: 'other', entries: [text('a', 'hi')] })).toBe(frozen)
  })
})

describe('latest entries first', () => {
  const selected = { ...initialState, selectedId: 's1' }

  test('the end of the conversation shows at once, the whole of it replaces it', () => {
    const recent = reduce(selected, { t: 'history', sessionId: 's1', entries: [text('a9', 'last')], partial: true })
    expect(recent.entries?.map(e => e.id)).toEqual(['a9'])
    expect(recent.loadingEarlier).toBe(true)
    // A live entry joins it meanwhile, and is in the whole history too.
    const live = reduce(recent, { t: 'entries', sessionId: 's1', entries: [text('a10', 'live')] })
    expect(live.entries?.map(e => e.id)).toEqual(['a9', 'a10'])
    const whole = reduce(live, { t: 'history', sessionId: 's1', entries: [text('a1', 'first'), text('a9', 'last'), text('a10', 'live')] })
    expect(whole.entries?.map(e => e.id)).toEqual(['a1', 'a9', 'a10'])
    expect(whole.loadingEarlier).toBe(false)
  })

  test('after a reconnection, the conversation already shown stays until the whole history replaces it', () => {
    const shown = reduce(selected, { t: 'history', sessionId: 's1', entries: [text('a1', 'first'), text('a2', 'second')] })
    const recent = reduce(shown, { t: 'history', sessionId: 's1', entries: [text('a2', 'second')], partial: true })
    expect(recent).toBe(shown)
  })
})

describe('relay client', () => {
  test('opens the snapshot, then follows the selected session', async () => {
    const { relay, sockets } = client()
    relay.start()
    const socket = sockets[0]
    expect(relay.state.connection).toBe('connecting')
    socket.receive({ t: 'snapshot', sessions: [await wireSession('api'), await wireSession('web', { status: 'ended' })], machines: [] })
    await eventually(() => relay.state.connection === 'connected', 'the snapshot')
    expect(relay.state.sessions.map(s => [s.project, s.machine])).toEqual([
      ['api', 'PC'],
      ['web', 'PC'],
    ])

    relay.select('api')
    expect(socket.sent).toEqual([{ t: 'subscribe', sessionId: 'api', latestFirst: true }])
    expect(relay.state.entries).toBeNull()
    // Entries sent before the history are part of it.
    socket.receive({ t: 'entries', sessionId: 'api', entries: [await sealedEntry(text('early', 'x'))], reset: false })
    socket.receive({ t: 'history', sessionId: 'api', entries: [await sealedEntry(text('a1', 'Déployé ✅'))] })
    socket.receive({ t: 'entries', sessionId: 'api', entries: [await sealedEntry(text('a2', 'Next'))], reset: false })
    socket.receive({ t: 'entries', sessionId: 'web', entries: [await sealedEntry(text('w1', 'Not mine'))], reset: false })
    await eventually(() => relay.state.entries?.length === 2, 'the conversation')
    expect(relay.state.entries?.map(e => e.id)).toEqual(['a1', 'a2'])

    socket.receive({ t: 'removed', sessionId: 'api' })
    await eventually(() => relay.state.sessions.length === 1, 'the removal')
    expect(relay.state.selectedId).toBeNull()
    expect(relay.state.entries).toBeNull()
  })

  test('applies messages in the order they came, though opening them takes time', async () => {
    const { relay, sockets } = client()
    relay.start()
    const socket = sockets[0]
    socket.receive({ t: 'snapshot', sessions: [], machines: [] })
    for (let i = 0; i < 20; i++) socket.receive({ t: 'session', session: await wireSession('api', { status: i % 2 ? 'idle' : 'working' }) })
    socket.receive({ t: 'session', session: await wireSession('api', { status: 'waiting' }) })
    await eventually(() => relay.state.sessions[0]?.status === 'waiting', 'the last update')
    expect(relay.state.sessions).toHaveLength(1)
  })

  test('seals what it sends, and sends nothing before it is connected', async () => {
    const { relay, sockets } = client()
    relay.start()
    const socket = sockets[0]
    expect(await relay.sendPrompt('api', 'too early')).toBe(false)
    socket.receive({ t: 'snapshot', sessions: [await wireSession('api')], machines: [] })
    await eventually(() => relay.state.connection === 'connected', 'the snapshot')

    expect(await relay.sendPrompt('api', 'Run the tests')).toBe(true)
    expect(relay.answer('api', 'req12', false)).toBe(true)
    const [prompt, verdict] = socket.sent as [{ t: string; payload: string }, unknown]
    expect(prompt.t).toBe('prompt')
    expect(prompt.payload).not.toContain('Run the tests')
    expect(await open<PromptPayload>(key, prompt.payload)).toEqual({ text: 'Run the tests', images: [] })
    expect(verdict).toEqual({ t: 'verdict', sessionId: 'api', requestId: 'req12', behavior: 'deny' })
  })

  test('asks a machine for its agent log, and only takes the one sealed for that request and machine', async () => {
    const { relay, sockets, events } = client()
    relay.start()
    const socket = sockets[0]
    expect(await relay.requestLog('m1')).toBeNull()
    socket.receive({ t: 'snapshot', sessions: [], machines: [] })
    await eventually(() => relay.state.connection === 'connected', 'the snapshot')

    const requestId = await relay.requestLog('m1')
    if (!requestId) throw new Error('not sent')
    expect(requestId).toMatch(/^[a-z0-9]{32}$/)
    const sent = socket.sent[0] as { t: string; machineId: string; requestId: string; request: string }
    expect(sent).toMatchObject({ t: 'agent_logs', machineId: 'm1', requestId })
    expect(await open<LogRequest>(key, sent.request)).toMatchObject({ requestId, machineId: 'm1' })

    const log = (fields: Partial<AgentLog>): Promise<string> =>
      seal(key, { requestId, machineId: 'm1', lines: ['service started'], truncated: false, size: 16, at: 'now', ...fields })
    socket.receive({ t: 'agent_logs', machineId: 'm1', requestId, logs: await log({ machineId: 'm2' }) })
    socket.receive({ t: 'agent_logs', machineId: 'm1', requestId, logs: await log({}) })
    socket.receive({ t: 'agent_logs', machineId: 'm1', requestId, reason: 'offline' })
    await eventually(() => events.filter(event => event.t === 'agent_logs').length === 3, 'the answers')
    const answers = events.filter(event => event.t === 'agent_logs')
    expect(answers.map(event => event.log?.lines ?? null)).toEqual([null, ['service started'], null])
    expect(answers[2]).toEqual({ t: 'agent_logs', machineId: 'm1', requestId, reason: 'offline', log: null })
  })

  test('asks a machine for a diagnosis, with a repair, and reads checks this client does not know', async () => {
    const { relay, sockets, events } = client()
    relay.start()
    const socket = sockets[0]
    socket.receive({ t: 'snapshot', sessions: [], machines: [] })
    await eventually(() => relay.state.connection === 'connected', 'the snapshot')

    const requestId = await relay.requestDiagnosis('m1', 'hooks')
    if (!requestId) throw new Error('not sent')
    const sent = socket.sent[0] as { t: string; machineId: string; requestId: string; request: string }
    expect(sent).toMatchObject({ t: 'diagnose', machineId: 'm1', requestId })
    expect(await open<DiagnoseRequest>(key, sent.request)).toMatchObject({ requestId, machineId: 'm1', fix: 'hooks' })

    const diagnosis = {
      requestId,
      machineId: 'm1',
      at: '2026-10-27T10:00:00.000Z',
      version: '0.9.1',
      checks: [
        { id: 'hooks', label: 'Claude Code hooks', ok: true, detail: 'All 7.' },
        { id: 'future', label: 'Something new', ok: false, detail: 'Later.', fix: 'future' },
      ],
      fixed: { fix: 'hooks', ok: true, text: 'Hooks added.' },
    }
    socket.receive({ t: 'diagnosis', machineId: 'm1', requestId, diagnosis: await seal(key, { ...diagnosis, machineId: 'm2' }) })
    socket.receive({ t: 'diagnosis', machineId: 'm1', requestId, diagnosis: await seal(key, diagnosis) })
    socket.receive({ t: 'diagnosis', machineId: 'm1', requestId, diagnosis: await seal(key, { ...diagnosis, checks: [{ id: 1 }] }) })
    await eventually(() => events.filter(event => event.t === 'diagnosis').length === 3, 'the answers')
    const answers = events.filter(event => event.t === 'diagnosis').map(event => (event.t === 'diagnosis' ? event.diagnosis : null))
    expect(answers).toEqual([null, diagnosis as Diagnosis, null])
  })

  test('names a session for every client, and ignores a name sealed for another session', async () => {
    const { relay, sockets } = client()
    relay.start()
    const socket = sockets[0]
    socket.receive({ t: 'snapshot', sessions: [await wireSession('api')], machines: [] })
    await eventually(() => relay.state.connection === 'connected', 'the snapshot')
    expect(relay.state.sessions[0].name).toBeNull()

    expect(await relay.rename('api', '  Billing rewrite ')).toBe(true)
    const sent = socket.sent[0] as { t: string; sessionId: string; name: string }
    expect(sent).toMatchObject({ t: 'rename', sessionId: 'api' })
    expect(await open<SessionName>(key, sent.name)).toMatchObject({ sessionId: 'api', name: 'Billing rewrite' })
    await relay.rename('api', 'é'.repeat(500))
    expect((await open<SessionName>(key, (socket.sent[1] as { name: string }).name)).name).toHaveLength(80)

    socket.receive({ t: 'session', session: await wireSession('api', { name: sent.name }) })
    await eventually(() => relay.state.sessions[0]?.name === 'Billing rewrite', 'the name')
    const moved = await seal(key, { sessionId: 'web', name: 'Not this one', issuedAt: new Date().toISOString() })
    socket.receive({ t: 'session', session: await wireSession('api', { name: moved, status: 'idle' }) })
    await eventually(() => relay.state.sessions[0]?.status === 'idle', 'the update')
    expect(relay.state.sessions[0].name).toBeNull()
  })

  test('reconnects with backoff, subscribes again, and stops for good when signed out', async () => {
    const { relay, sockets, signedOut } = client({ retryMs: 5 })
    relay.start()
    sockets[0].receive({ t: 'snapshot', sessions: [await wireSession('api')], machines: [] })
    await eventually(() => relay.state.connection === 'connected', 'the snapshot')
    relay.select('api')

    sockets[0].onclose?.({ code: 1006 })
    expect(relay.state.connection).toBe('offline')
    // What the client knew stays on screen until the next snapshot.
    expect(relay.state.sessions).toHaveLength(1)
    await eventually(() => sockets.length === 2, 'a new socket')
    sockets[1].receive({ t: 'snapshot', sessions: [await wireSession('api')], machines: [] })
    await eventually(() => relay.state.connection === 'connected', 'the new snapshot')
    expect(sockets[1].sent).toEqual([{ t: 'subscribe', sessionId: 'api', latestFirst: true }])

    sockets[1].onclose?.({ code: 4001 })
    expect(relay.state.connection).toBe('stopped')
    expect(signedOut()).toBe(1)
    await Bun.sleep(30)
    expect(sockets).toHaveLength(2)
  })

  test('stop closes the socket and ignores what it still receives', async () => {
    const { relay, sockets } = client()
    relay.start()
    relay.stop()
    expect(sockets[0].closed).toBe(true)
    sockets[0].receive({ t: 'snapshot', sessions: [await wireSession('api')], machines: [] })
    await Bun.sleep(20)
    expect(relay.state.sessions).toEqual([])
    expect(relay.state.connection).toBe('stopped')
  })
})
