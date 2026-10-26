// The client core against a real relay: an agent socket seals a session, the RelayClient the new apps build on opens it,
// follows its conversation and drives it.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { type ClientState, RelayClient, type SocketLike } from '../shared/client'
import { newAccountKey, open, seal } from '../shared/crypto'
import type { Entry, PromptPayload, RelayToAgent } from '../shared/protocol'
import { Vault } from '../shared/vault'

const dir = mkdtempSync(join(tmpdir(), 'tonton-client-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`
const key = newAccountKey()
const sessionId = `client-${Date.now()}`

let agent: WebSocket
const toAgent: RelayToAgent[] = []
let client: RelayClient
let state: ClientState

async function eventually<T>(read: () => T | undefined | null | false, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(30)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const post = (path: string, body: object, token?: string) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then(response => response.json())

const entry = (id: string, text: string): Entry => ({ id, ts: new Date().toISOString(), kind: 'assistant', text })
const sealedEntry = async (e: Entry) => ({ id: e.id, ts: e.ts, blob: await seal(key, e) })

beforeAll(async () => {
  const account = await post('/api/accounts', {})
  const { secret } = await post('/api/account/token', {}, account.token)
  const machine = await post('/api/machines/join', { account: account.accountId, secret, name: await seal(key, { name: 'PC-Client' }) })

  agent = new WebSocket(`${base.replace('http', 'ws')}/ws/agent`, { headers: { authorization: `Bearer ${machine.token}` } } as never)
  agent.onmessage = event => toAgent.push(JSON.parse(String(event.data)))
  await new Promise(resolve => (agent.onopen = resolve))
  const info = await seal(key, { machine: 'PC-Client', platform: 'linux', cwd: '/home/x/api', project: 'api' })
  agent.send(JSON.stringify({ t: 'hello', sessionId, info, channel: true }))
  agent.send(JSON.stringify({ t: 'entries', sessionId, entries: [await sealedEntry(entry('e1', 'Déployé ✅'))], reset: true }))

  client = new RelayClient({
    vault: new Vault(key),
    // Bun's WebSocket takes headers, like the Mac app's.
    connect: () =>
      new WebSocket(`${base.replace('http', 'ws')}/ws/app`, {
        headers: { authorization: `Bearer ${account.token}` },
      } as never) as SocketLike,
    onChange: next => (state = next),
  })
  client.start()
})

afterAll(() => {
  client?.stop()
  agent?.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('the client opens the sessions and machines the relay holds', async () => {
  const session = await eventually(() => state?.sessions.find(s => s.id === sessionId), 'the session')
  expect(session).toMatchObject({ machine: 'PC-Client', platform: 'linux', project: 'api', canChat: true, agentOnline: true })
  expect(state.connection).toBe('connected')
  expect(state.machines.map(m => [m.name, m.online])).toEqual([['PC-Client', true]])
})

test('it follows the selected conversation, history first and then live', async () => {
  client.select(sessionId)
  await eventually(() => state.entries?.length === 1, 'the history')
  agent.send(JSON.stringify({ t: 'entries', sessionId, entries: [await sealedEntry(entry('e2', 'Next step'))], reset: false }))
  await eventually(() => state.entries?.length === 2, 'the new entry')
  expect(state.entries?.map(e => (e.kind === 'assistant' ? e.text : ''))).toEqual(['Déployé ✅', 'Next step'])
})

test('its messages reach the agent sealed, and its verdicts close the request', async () => {
  expect(await client.sendPrompt(sessionId, 'Run the tests')).toBe(true)
  const prompt = await eventually(() => toAgent.find(m => m.t === 'prompt'), 'the prompt')
  if (prompt.t !== 'prompt') throw new Error('unexpected message')
  expect(await open<PromptPayload>(key, prompt.payload)).toEqual({ text: 'Run the tests', images: [] })

  const detail = await seal(key, { toolName: 'Bash', description: 'Deploy', inputPreview: '{}' })
  agent.send(JSON.stringify({ t: 'permission', sessionId, request: { requestId: 'req01', ts: new Date().toISOString(), blob: detail } }))
  const asking = await eventually(() => state.sessions.find(s => s.id === sessionId && s.pendingPermissions.length), 'the request')
  expect(asking.pendingPermissions[0]).toMatchObject({ requestId: 'req01', toolName: 'Bash', description: 'Deploy' })

  client.answer(sessionId, 'req01', true)
  await eventually(() => toAgent.find(m => m.t === 'verdict'), 'the verdict')
  await eventually(() => state.sessions.find(s => s.id === sessionId && !s.pendingPermissions.length), 'the closed request')
})
