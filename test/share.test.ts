// A read-only share of one session, end to end: a real relay, a real agent channel, a socket playing the Mac app and one
// playing the teammate's browser. The teammate reads the conversation with the share key only, and can do nothing else.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import type { SocketLike } from '../shared/client'
import { newAccountKey, open, seal } from '../shared/crypto'
import type { RelayToApp, RelayToViewer, SealedEntry, SharedInfo, ShareOrder, ShareSummary } from '../shared/protocol'
import { shareSocket } from '../shared/share-link'
import { type SharedView, ShareViewer } from '../shared/share-viewer'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const dir = mkdtempSync(join(tmpdir(), 'tonton-share-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`
const sessionId = `session-${Date.now()}`
const transcript = join(dir, 'transcript.jsonl')

interface Peer {
  socket: WebSocket
  messages: unknown[]
  raw: string[]
  closed: boolean
}

let accountToken: string
let otherAccountToken: string
let key: string
let claude: Client
const notifications: { method: string }[] = []
let app: Peer

const api = (path: string, init: RequestInit & { token?: string } = {}) =>
  fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
  })

const line = (fields: object) => `${JSON.stringify({ sessionId, timestamp: new Date().toISOString(), ...fields })}\n`

async function eventually<T>(read: () => T | undefined | false | Promise<T | undefined | false>, label: string): Promise<T> {
  for (let i = 0; i < 80; i++) {
    const value = await read()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** The app opens with a header, a browser with subprotocols. */
function connect(path: string, init: { headers?: Record<string, string>; protocols?: string[] }): Promise<Peer> {
  const url = `${base.replace('http', 'ws')}${path}`
  const socket = init.protocols ? new WebSocket(url, init.protocols) : new WebSocket(url, { headers: init.headers } as never)
  const peer: Peer = { socket, messages: [], raw: [], closed: false }
  socket.onmessage = event => {
    peer.raw.push(String(event.data))
    peer.messages.push(JSON.parse(String(event.data)))
  }
  socket.onerror = () => {}
  return new Promise(resolve => {
    socket.onopen = () => resolve(peer)
    socket.onclose = () => {
      peer.closed = true
      resolve(peer)
    }
  })
}

const viewer = (token: string) => connect('/ws/share', { protocols: ['tonton', `bearer.${token}`] })

/** Creates a share and sends its order as the app does: returns its token and key. */
async function share(): Promise<{ id: string; token: string; key: string }> {
  const created = await (
    await api('/api/shares', { method: 'POST', token: accountToken, body: JSON.stringify({ sessionId, hours: 1 }) })
  ).json()
  const shareKey = newAccountKey()
  const order: ShareOrder = { shareId: created.id, sessionId, key: shareKey, expiresAt: created.expiresAt }
  app.socket.send(JSON.stringify({ t: 'share', sessionId, shareId: created.id, order: await seal(key, order) }))
  return { id: created.id, token: created.token, key: shareKey }
}

/** Every entry the viewer was sent, opened with the share key. */
async function readEntries(peer: Peer, shareKey: string): Promise<string[]> {
  const sealed = peer.messages.flatMap(message => {
    const m = message as RelayToViewer
    return m.t === 'shared' || m.t === 'shared_entries' ? m.entries : ([] as SealedEntry[])
  })
  return Promise.all(sealed.map(async entry => (await open<{ text?: string }>(shareKey, entry.blob)).text ?? ''))
}

beforeAll(async () => {
  const account = await (await api('/api/accounts', { method: 'POST' })).json()
  accountToken = account.token
  otherAccountToken = (await (await api('/api/accounts', { method: 'POST' })).json()).token
  key = newAccountKey()
  const { secret } = await (await api('/api/account/token', { method: 'POST', token: accountToken, body: '{}' })).json()
  const joinRequest = { account: account.accountId, secret, name: await seal(key, { name: 'PC-Test' }) }
  const machine = await (await api('/api/machines/join', { method: 'POST', body: JSON.stringify(joinRequest) })).json()

  const home = join(dir, 'agent')
  mkdirSync(join(home, 'run'), { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: base, ...machine, key, machine: 'PC-Test', version: '0.3.0' }))
  writeFileSync(
    transcript,
    line({ type: 'user', uuid: 'u1', message: { content: 'SECRET prompt' } }) + line({ type: 'ai-title', aiTitle: 'SECRET title' }),
  )
  writeFileSync(
    join(home, 'run', `${process.pid}.json`),
    JSON.stringify({ sessionId, transcriptPath: transcript, cwd: '/home/x/SecretProject' }),
  )
  const env = { ...process.env, TONTON_HOME: home, TONTON_CHANNEL: '1', TONTON_SERVICE: 'off' } as Record<string, string>
  claude = new Client({ name: 'claude-code', version: 'test' })
  claude.fallbackNotificationHandler = async notification => {
    notifications.push(notification)
  }
  await claude.connect(new StdioClientTransport({ command: 'bun', args: [AGENT, 'channel'], env }))

  app = await connect('/ws/app', { headers: { authorization: `Bearer ${accountToken}` } })
  await eventually(
    () =>
      app.messages.some(message => {
        const m = message as RelayToApp
        return m.t === 'session' && m.session.id === sessionId && m.session.agentOnline
      }),
    'the agent to come online',
  )
}, 20_000)

afterAll(async () => {
  app?.socket.close()
  await claude?.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('read-only share', () => {
  test('the teammate reads the conversation with the share key, and the relay sees ciphertext only', async () => {
    const shared = await share()
    const teammate = await viewer(shared.token)
    expect(teammate.socket.protocol).toBe('tonton')
    const entries = await eventually(async () => {
      const texts = await readEntries(teammate, shared.key)
      return texts.includes('SECRET prompt') && texts
    }, 'the shared conversation')
    expect(entries).toContain('SECRET prompt')

    const infoMessage = await eventually(
      () => teammate.messages.find(m => (m as RelayToViewer).t === 'shared_info') as Extract<RelayToViewer, { t: 'shared_info' }>,
      'the shared info',
    )
    // The project and the title, not the machine nor the folder.
    expect(await open<SharedInfo>(shared.key, infoMessage.info)).toEqual({ project: 'SecretProject', title: 'SECRET title' })
    // Not sealed with the account key: a share key opens its share only.
    await expect(open(key, infoMessage.info)).rejects.toThrow()

    appendFileSync(transcript, line({ type: 'user', uuid: 'u2', message: { content: 'SECRET follow-up' } }))
    await eventually(async () => (await readEntries(teammate, shared.key)).includes('SECRET follow-up'), 'a new entry')

    for (const secret of ['SECRET', 'PC-Test', '/home/x']) expect(teammate.raw.join('')).not.toContain(secret)
    teammate.socket.close()
  })

  test('a teammate can only read: a prompt or a verdict from the share goes nowhere', async () => {
    const shared = await share()
    const teammate = await viewer(shared.token)
    teammate.socket.send(JSON.stringify({ t: 'prompt', sessionId, payload: await seal(shared.key, { text: 'evil', images: [] }) }))
    teammate.socket.send(JSON.stringify({ t: 'verdict', sessionId, requestId: 'r1', behavior: 'allow' }))
    teammate.socket.send(JSON.stringify({ t: 'subscribe', sessionId }))
    await Bun.sleep(300)
    expect(notifications.some(n => n.method === 'notifications/claude/channel')).toBe(false)
    expect(teammate.messages.some(m => (m as { t: string }).t === 'history')).toBe(false)
    // Its token opens nothing but the share.
    expect((await connect('/ws/app', { protocols: ['tonton', `bearer.${shared.token}`] })).closed).toBe(true)
    expect((await api('/api/shares', { token: shared.token })).status).toBe(401)
    // And the account token is not a share token.
    expect((await viewer(accountToken)).closed).toBe(true)
    teammate.socket.close()
  })

  test('an order the account did not seal is dropped by the agent', async () => {
    const created = await (
      await api('/api/shares', { method: 'POST', token: accountToken, body: JSON.stringify({ sessionId, hours: 1 }) })
    ).json()
    const forged: ShareOrder = { shareId: created.id, sessionId, key: newAccountKey(), expiresAt: created.expiresAt }
    app.socket.send(JSON.stringify({ t: 'share', sessionId, shareId: created.id, order: await seal(newAccountKey(), forged) }))
    const teammate = await viewer(created.token)
    await Bun.sleep(500)
    expect(await readEntries(teammate, forged.key)).toEqual([])
    teammate.socket.close()
  })

  test('the account lists its shares, another account sees none and cannot revoke them', async () => {
    const shared = await share()
    const teammate = await viewer(shared.token)
    const list = await eventually(async () => {
      const shares = (await (await api('/api/shares', { token: accountToken })).json()) as ShareSummary[]
      return shares.find(s => s.id === shared.id)?.viewers === 1 && shares
    }, 'the share with one viewer')
    expect(list.find(s => s.id === shared.id)).toMatchObject({ sessionId, viewers: 1 })
    expect(JSON.stringify(list)).not.toContain(shared.token)
    expect(await (await api('/api/shares', { token: otherAccountToken })).json()).toEqual([])
    expect((await api(`/api/shares/${shared.id}`, { method: 'DELETE', token: otherAccountToken })).status).toBe(404)
    expect(teammate.closed).toBe(false)
    teammate.socket.close()
  })

  test('revoking a share closes its viewers and its token stops working', async () => {
    const shared = await share()
    const teammate = await viewer(shared.token)
    await eventually(async () => (await readEntries(teammate, shared.key)).length > 0, 'the shared conversation')
    expect((await api(`/api/shares/${shared.id}`, { method: 'DELETE', token: accountToken })).status).toBe(200)
    await eventually(() => teammate.closed, 'the viewer to close')
    expect(teammate.messages.some(m => (m as RelayToViewer).t === 'share_ended')).toBe(true)
    expect((await viewer(shared.token)).closed).toBe(true)
  })

  test("the client core's viewer shows the shared conversation, and that the share ended once revoked", async () => {
    const shared = await share()
    const views: SharedView[] = []
    const relayUrl = base
    const viewer = new ShareViewer({
      key: shared.key,
      connect: () =>
        shareSocket(
          { relay: relayUrl, token: shared.token, key: shared.key },
          (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike,
        ),
      onChange: view => views.push(view),
    })
    viewer.start()
    const shown = await eventually(
      () => viewer.view.entries?.some(e => e.kind === 'user' && e.text === 'SECRET prompt') && viewer.view,
      'the conversation',
    )
    expect(shown).toMatchObject({ connection: 'connected', project: 'SecretProject', title: 'SECRET title' })
    expect(shown.status).not.toBeNull()
    // Each entry once, however many times the agent sent it.
    const ids = shown.entries?.map(e => e.id) ?? []
    expect(new Set(ids).size).toBe(ids.length)
    await api(`/api/shares/${shared.id}`, { method: 'DELETE', token: accountToken })
    await eventually(() => viewer.view.connection === 'ended', 'the end of the share')
    viewer.stop()
  })

  test('a share is only made for a session of the account, for a sensible time', async () => {
    const make = (token: string, body: object) => api('/api/shares', { method: 'POST', token, body: JSON.stringify(body) })
    expect((await make(otherAccountToken, { sessionId, hours: 1 })).status).toBe(404)
    expect((await make(accountToken, { sessionId: 'nope', hours: 1 })).status).toBe(404)
    for (const hours of [0, 1.5, 24 * 31, '1']) expect((await make(accountToken, { sessionId, hours })).status).toBe(400)
  })
})
