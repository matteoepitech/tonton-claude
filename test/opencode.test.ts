// Real relay and real `tonton opencode` bridge, fed the events of a real OpenCode 2 run, with a client playing the app
// and the test playing Tonton's plugin: it reads what the bridge asks OpenCode to do on its stdout.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginCommand } from '../agent/src/opencode/bridge'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { newAccountKey, open, seal } from '../shared/crypto'
import { PoolVault, sealPoolSessionOrder } from '../shared/pool'
import { PoolApi } from '../shared/pool-api'
import type { PoolUpdate } from '../shared/pool-protocol'
import type { Entry, RelayToApp, RelayToViewer, SessionInfo, SessionMeta, SessionSummary, SharedInfo } from '../shared/protocol'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const FIXTURE = join(import.meta.dir, '../agent/test/fixtures/opencode-2.0.32.jsonl')
const SESSION = 'ses_e872d9012ffeqUp0ZMJp9G4Gx2'
const dir = mkdtempSync(join(tmpdir(), 'tonton-opencode-e2e-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`

let key: string
let accountToken: string
let machineId: string
let home: string
let bridge: ReturnType<typeof Bun.spawn>
const messages: RelayToApp[] = []
const raw: string[] = []
const commands: PluginCommand[] = []
let app: WebSocket
let events = 0

const api = (path: string, init: RequestInit & { token?: string } = {}) =>
  fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
  })

async function eventually<T>(read: () => T | undefined | false | Promise<T | undefined | false>, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read()
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

/** An OpenCode 2 event, as the plugin forwards it. */
function emit(type: string, data: object) {
  bridge.stdin.write(
    `${JSON.stringify({ id: `evt_test_${++events}`, created: Date.now(), type, data: { sessionID: SESSION, ...data } })}\n`,
  )
  bridge.stdin.flush()
}

const sealedCommand = (name: string) =>
  seal(key, {
    text: '',
    images: [],
    command: { name, sessionId: SESSION, id: `command-${crypto.randomUUID()}`, issuedAt: new Date().toISOString() },
  })

beforeAll(async () => {
  const account = await (await api('/api/accounts', { method: 'POST' })).json()
  accountToken = account.token
  key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const { secret } = await (await api('/api/account/token', { method: 'POST', token: account.token, body: '{}' })).json()
  const joinRequest = { account: account.accountId, secret, name: await seal(key, { name: 'Linux-Box' }) }
  const machine = await (await api('/api/machines/join', { method: 'POST', body: JSON.stringify(joinRequest) })).json()
  machineId = machine.machineId

  home = join(dir, 'agent')
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
    stdout: 'pipe',
  })
  void (async () => {
    let buffer = ''
    for await (const chunk of bridge.stdout as ReadableStream<Uint8Array>) {
      buffer += new TextDecoder().decode(chunk)
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        commands.push(JSON.parse(buffer.slice(0, newline)))
        buffer = buffer.slice(newline + 1)
      }
    }
  })()
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
  test('the session shows up as OpenCode, done, and the notch can write to it', async () => {
    const session = await eventually(() => latest()?.agentOnline && latest()?.status === 'idle' && latest(), 'the session to finish')
    expect(session.canChat).toBe(true)
    const info = await open<SessionInfo>(key, session.info as string)
    expect(info).toMatchObject({ machine: 'Linux-Box', cwd: '/Users/me/code/shop', project: 'shop', tool: 'opencode' })
    const meta = await eventually(() => latest()?.meta, 'the meta')
    expect(await open<SessionMeta>(key, meta)).toMatchObject({ title: 'Probe title', commands: ['compact', 'interrupt', 'model'] })
    // The bridge asks OpenCode for the window of its models, and for the history of a session it meets halfway.
    expect(commands).toContainEqual({ op: 'models' })
    expect(commands).toContainEqual({ op: 'history', sessionID: SESSION, directory: '/Users/me/code/shop' })
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

  test('a message from the notch reaches OpenCode, and comes back marked as sent from the notch', async () => {
    app.send(JSON.stringify({ t: 'prompt', sessionId: SESSION, payload: await seal(key, { text: 'Ship it', images: [] }) }))
    await eventually(() => commands.some(c => c.op === 'prompt' && c.text === 'Ship it'), 'the prompt')
    const before = messages.length
    emit('session.inbox.enqueued', { inboxID: 'msg_ship', item: { type: 'user', payload: { text: 'Ship it' } } })
    const live = await eventually(() => messages.slice(before).find(m => m.t === 'entries'), 'the entry')
    if (live.t !== 'entries') throw new Error('unexpected message')
    expect(await open<Entry>(key, live.entries[0].blob)).toMatchObject({ kind: 'user', text: 'Ship it', viaNotch: true })
  })

  test('a permission shows in the notch, and the answer from the app goes back to OpenCode', async () => {
    emit('permission.asked', { id: 'per_deploy', action: 'shell', resources: ['./deploy.sh'], source: { type: 'tool', id: 'call_2' } })
    const session = await eventually(() => latest()?.pendingPermissions.length && latest(), 'the request')
    expect(await open(key, session.pendingPermissions[0].blob)).toEqual({
      toolName: 'Bash',
      description: './deploy.sh',
      inputPreview: '{"command":"./deploy.sh"}',
    })
    app.send(JSON.stringify({ t: 'verdict', sessionId: SESSION, requestId: 'per_deploy', behavior: 'deny' }))
    await eventually(() => commands.find(c => c.op === 'reply' && c.requestID === 'per_deploy'), 'the reply')
    expect(commands.find(c => c.op === 'reply')).toMatchObject({ decision: 'reject' })
    await eventually(() => latest()?.pendingPermissions.length === 0, 'the request to close')
  })

  test('an auto-approve rule from the app answers OpenCode without asking', async () => {
    const rules = await seal(key, { rules: [{ tool: 'Bash', pattern: 'npm test' }], issuedAt: new Date().toISOString() })
    app.send(JSON.stringify({ t: 'rules', machineId, rules }))
    await Bun.sleep(300)
    emit('permission.asked', { id: 'per_tests', action: 'shell', resources: ['npm test'], source: { type: 'tool', id: 'call_3' } })
    await eventually(() => commands.find(c => c.op === 'reply' && c.requestID === 'per_tests'), 'the automatic reply')
    expect(commands.find(c => c.op === 'reply' && c.requestID === 'per_tests')).toMatchObject({ decision: 'once' })
    expect(latest()?.pendingPermissions.some(p => p.requestId === 'per_tests')).toBe(false)
  })

  test('"allow for this session" answers the next calls like it without asking, as for Claude Code', async () => {
    const ask = (id: string, command: string, call: string) =>
      emit('permission.asked', { id, action: 'shell', resources: [command], source: { type: 'tool', id: call } })
    const reply = (id: string) => eventually(() => commands.find(c => c.op === 'reply' && c.requestID === id), `the reply to ${id}`)
    ask('per_make1', 'make deploy --prod', 'call_m1')
    await eventually(() => latest()?.pendingPermissions.some(p => p.requestId === 'per_make1'), 'the request')
    const rules = [
      { tool: 'Bash', pattern: 'make deploy' },
      { tool: 'Bash', pattern: 'make deploy *' },
    ]
    const rule = await seal(key, { sessionId: SESSION, requestId: 'per_make1', rules })
    app.send(JSON.stringify({ t: 'verdict', sessionId: SESSION, requestId: 'per_make1', behavior: 'allow', rule }))
    expect(await reply('per_make1')).toMatchObject({ decision: 'once' })
    await Bun.sleep(200)
    ask('per_make2', 'make deploy --staging', 'call_m2')
    expect(await reply('per_make2')).toMatchObject({ decision: 'once' })
    // Anything else is still asked.
    ask('per_make3', 'make clean', 'call_m3')
    await eventually(() => latest()?.pendingPermissions.some(p => p.requestId === 'per_make3'), 'the other request')
    expect(commands.some(c => c.op === 'reply' && c.requestID === 'per_make3')).toBe(false)
  })

  test("OpenCode's task list arrives sealed with its items, and its progress in the meta, as for Claude Code", async () => {
    const before = messages.length
    const todos = [
      { id: '1', content: 'Write the fix', status: 'completed', priority: 'high' },
      { id: '2', content: 'Run the tests', status: 'pending', priority: 'low' },
    ]
    emit('session.tool.called', { callID: 'call_todo', tool: 'todowrite', input: { todos }, timestamp: Date.now() })
    const live = await eventually(() => messages.slice(before).find(m => m.t === 'entries' && m.sessionId === SESSION), 'the task list')
    if (live.t !== 'entries') throw new Error('unexpected message')
    const opened = await Promise.all(live.entries.map(entry => open<Entry>(key, entry.blob)))
    expect(opened.find(entry => entry.kind === 'tool')).toMatchObject({
      name: 'TodoWrite',
      todos: [
        { content: 'Write the fix', status: 'completed' },
        { content: 'Run the tests', status: 'pending' },
      ],
    })
    let tasks: SessionMeta['tasks']
    await eventually(async () => {
      const sealed = latest()?.meta
      tasks = sealed ? (await open<SessionMeta>(key, sealed)).tasks : undefined
      return tasks !== undefined
    }, 'the progress')
    expect(tasks).toEqual({ done: 1, total: 2 })
  })

  test('compact and interrupt run through OpenCode, clear says why it cannot', async () => {
    app.send(JSON.stringify({ t: 'prompt', sessionId: SESSION, payload: await sealedCommand('compact') }))
    app.send(JSON.stringify({ t: 'prompt', sessionId: SESSION, payload: await sealedCommand('interrupt') }))
    await eventually(() => commands.some(c => c.op === 'compact') && commands.some(c => c.op === 'interrupt'), 'the commands')
    expect(commands.find(c => c.op === 'compact')).toMatchObject({ providerID: 'mock', modelID: 'mock-model' })
    const before = messages.length
    app.send(JSON.stringify({ t: 'prompt', sessionId: SESSION, payload: await sealedCommand('clear') }))
    const note = await eventually(() => messages.slice(before).find(m => m.t === 'entries'), 'the note')
    if (note.t !== 'entries') throw new Error('unexpected message')
    expect(await open<Entry>(key, note.entries[0].blob)).toMatchObject({
      kind: 'system',
      text: '/clear was not run: OpenCode has no such command.',
    })
  })

  test('the model menu switches OpenCode to the latest model of the family, or says it has none', async () => {
    emit('tonton.models', {
      models: [
        { providerID: 'anthropic', modelID: 'claude-sonnet-4-5', released: 1_750_000_000_000 },
        { providerID: 'anthropic', modelID: 'claude-sonnet-5-5', released: 1_790_000_000_000 },
      ],
    })
    const switchTo = async (model: string) =>
      seal(key, {
        text: '',
        images: [],
        command: { name: 'model', model, sessionId: SESSION, id: `command-${crypto.randomUUID()}`, issuedAt: new Date().toISOString() },
      })
    app.send(JSON.stringify({ t: 'prompt', sessionId: SESSION, payload: await switchTo('sonnet') }))
    await eventually(() => commands.find(c => c.op === 'model'), 'the switch')
    expect(commands.find(c => c.op === 'model')).toMatchObject({ providerID: 'anthropic', modelID: 'claude-sonnet-5-5' })
    let shown: string | undefined
    for (let i = 0; i < 60 && shown !== 'claude-sonnet-5-5'; i++) {
      const meta = latest()?.meta
      shown = meta ? (await open<SessionMeta>(key, meta)).model : undefined
      await Bun.sleep(50)
    }
    expect(shown).toBe('claude-sonnet-5-5')
    const before = messages.length
    app.send(JSON.stringify({ t: 'prompt', sessionId: SESSION, payload: await switchTo('opus') }))
    const note = await eventually(() => messages.slice(before).find(m => m.t === 'entries'), 'the note')
    if (note.t !== 'entries') throw new Error('unexpected message')
    expect(await open<Entry>(key, note.entries[0].blob)).toMatchObject({
      kind: 'system',
      text: '/model opus was not run: OpenCode has no opus model.',
    })
  })

  test('a session started from the notch shows up before anyone writes to it', async () => {
    const started = 'ses_startedfromnotch01'
    mkdirSync(join(home, 'run', 'opencode'), { recursive: true })
    writeFileSync(join(home, 'run', 'opencode', `${started}.json`), JSON.stringify({ sessionId: started, cwd: '/Users/me/code/new' }))
    const session = await eventually(() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.t === 'session' && message.session.id === started && message.session.agentOnline) return message.session
      }
    }, 'the started session')
    expect(await open<SessionInfo>(key, session.info as string)).toMatchObject({
      cwd: '/Users/me/code/new',
      project: 'new',
      tool: 'opencode',
    })
    expect(commands).toContainEqual({ op: 'history', sessionID: started, directory: '/Users/me/code/new' })
  })

  test('the meta says the git branch of the session folder, as for Claude Code', async () => {
    const started = 'ses_startedingit01'
    const folder = join(dir, 'repo')
    mkdirSync(join(folder, '.git'), { recursive: true })
    writeFileSync(join(folder, '.git', 'HEAD'), 'ref: refs/heads/feat/opencode-branch\n')
    writeFileSync(join(home, 'run', 'opencode', `${started}.json`), JSON.stringify({ sessionId: started, cwd: folder }))
    const meta = await eventually(() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.t === 'session' && message.session.id === started && message.session.meta) return message.session.meta
      }
    }, 'the started session meta')
    expect(await open<SessionMeta>(key, meta)).toMatchObject({ branch: 'feat/opencode-branch' })
  })

  test('a read-only share gets the conversation sealed with its own key, as for Claude Code', async () => {
    const body = JSON.stringify({ sessionId: SESSION, hours: 1 })
    const created = await (await api('/api/shares', { method: 'POST', token: accountToken, body })).json()
    const shareKey = newAccountKey()
    const order = await seal(key, { shareId: created.id, sessionId: SESSION, key: shareKey, expiresAt: created.expiresAt })
    app.send(JSON.stringify({ t: 'share', sessionId: SESSION, shareId: created.id, order }))
    const viewer = new WebSocket(`${base.replace('http', 'ws')}/ws/share`, ['tonton', `bearer.${created.token}`])
    const seen: RelayToViewer[] = []
    viewer.onmessage = event => seen.push(JSON.parse(String(event.data)))
    const shared = await eventually(() => seen.findLast(m => m.t === 'shared_entries' && m.entries.length >= 5), 'the shared copy')
    if (shared.t !== 'shared_entries') throw new Error('unexpected message')
    const entries = await Promise.all(shared.entries.map(entry => open<Entry>(shareKey, entry.blob)))
    expect(entries.map(entry => entry.kind)).toContain('tool_result')
    const info = await eventually(() => seen.find(m => m.t === 'shared_info'), 'the shared info')
    if (info.t !== 'shared_info') throw new Error('unexpected message')
    expect(await open<SharedInfo>(shareKey, info.info)).toEqual({ project: 'shop', title: 'Probe title', tool: 'opencode' })
    viewer.close()
  })

  test('the session joins a pool: the bridge checks the order and takes the pool key, as for Claude Code', async () => {
    const created = await new PoolApi({ relay: base, token: accountToken }).create(key, { name: 'Pool' })
    const poolId = created.pool.id
    app.send(JSON.stringify({ t: 'pool_subscribe', poolId }))
    const profile = await new PoolVault(created.key).seal({ area: 'front', tool: 'opencode' })
    const order = await sealPoolSessionOrder(key, { poolId, sessionId: SESSION, key: created.key, version: 1 })
    app.send(JSON.stringify({ t: 'pool_join_session', poolId, sessionId: SESSION, order, profile }))
    await eventually(
      () =>
        (messages as unknown as PoolUpdate[]).some(
          m => m.t === 'pool_session' && m.poolId === poolId && m.session.session === SESSION && m.session.ready,
        ),
      'the OpenCode session ready in the pool',
    )
  })

  test('its sessions end with OpenCode', async () => {
    bridge.stdin.end()
    await eventually(() => latest()?.status === 'ended', 'the session to end')
  })
})
