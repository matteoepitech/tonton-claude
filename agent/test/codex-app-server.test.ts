import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { AppServerError, CodexAppServer, type RequestId } from '../src/codex/app-server'

// A stand-in for `codex app-server --listen unix://…`: WebSocket over a unix socket, JSON-RPC inside.
const dir = mkdtempSync(join(tmpdir(), 'tonton-codex-'))
const socket = join(dir, 'app.sock')
const received: { method?: string; id?: RequestId; params?: unknown; result?: unknown }[] = []
let client: ServerWebSocket<unknown> | null = null
let pongs = 0
const server = Bun.serve({
  unix: socket,
  fetch(request, server) {
    return server.upgrade(request) ? undefined : new Response('WebSocket only', { status: 400 })
  },
  websocket: {
    open(ws) {
      client = ws
    },
    pong() {
      pongs++
    },
    message(ws, raw) {
      const message = JSON.parse(String(raw))
      received.push(message)
      if (message.method === 'initialize') ws.send(JSON.stringify({ id: message.id, result: { userAgent: 'codex/0.142.2' } }))
      if (message.method === 'thread/loaded/list') ws.send(JSON.stringify({ id: message.id, result: { data: ['t1'] } }))
      if (message.method === 'turn/start') ws.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'no such thread' } }))
      if (message.method === 'echo') ws.send(JSON.stringify({ id: message.id, result: message.params }))
    },
  },
})

afterAll(() => {
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

async function until<T>(read: () => T | undefined | false, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read()
    if (value !== undefined && value !== false) return value
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('the app-server client', () => {
  test('it introduces itself, then asks and gets answers, or errors', async () => {
    const codex = await CodexAppServer.connect(socket, '0.10.0')
    await until(() => received.length >= 2, 'the introduction')
    expect(received.slice(0, 2).map(m => m.method)).toEqual(['initialize', 'initialized'])
    expect(received[0]?.params).toMatchObject({ clientInfo: { name: 'tonton', version: '0.10.0' } })
    expect(await codex.request('thread/loaded/list', {})).toEqual({ data: ['t1'] })
    const refused = await codex.request('turn/start', { threadId: 'x', input: [] }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(AppServerError)
    expect(refused instanceof AppServerError && [refused.message, refused.code]).toEqual(['no such thread', -32600])
    codex.close()
  })

  test('notifications and server requests reach their handlers, and an answer goes back on the same id', async () => {
    const notes: [string, unknown][] = []
    const asks: [RequestId, string, unknown][] = []
    const codex = await CodexAppServer.connect(socket, '0.10.0', {
      notification: (method, params) => notes.push([method, params]),
      request: (id, method, params) => asks.push([id, method, params]),
    })
    client?.send(JSON.stringify({ method: 'thread/started', params: { thread: { id: 't2' } } }))
    client?.send('not json')
    client?.send(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { command: 'make' } }))
    await until(() => asks.length === 1, 'the approval')
    expect(notes).toEqual([['thread/started', { thread: { id: 't2' } }]])
    expect(asks).toEqual([['approval-1', 'item/commandExecution/requestApproval', { command: 'make' }]])
    codex.respond('approval-1', { decision: 'accept' })
    await until(() => received.some(m => m.id === 'approval-1'), 'the answer')
    expect(received.find(m => m.id === 'approval-1')).toEqual({ id: 'approval-1', result: { decision: 'accept' } })
    codex.close()
  })

  test('large messages cross both ways, and pings get their pong', async () => {
    const codex = await CodexAppServer.connect(socket, '0.10.0')
    const text = 'é'.repeat(200_000)
    expect(await codex.request('echo', { text })).toEqual({ text })
    client?.ping()
    await until(() => pongs > 0, 'a pong')
    codex.close()
  })

  test('when the server goes away, waiting requests fail and the close is told once', async () => {
    const closes: string[] = []
    const codex = await CodexAppServer.connect(socket, '0.10.0', { close: why => closes.push(why) })
    const waiting = codex.request('never/answered', {})
    client?.close()
    const error = await waiting.catch(e => e)
    expect(error).toBeInstanceOf(AppServerError)
    await until(() => closes.length === 1, 'the close')
    expect(codex.closed).toBe(true)
    expect(await codex.request('echo', {}).catch(e => e.message)).toBe('Codex is not connected')
    expect(closes).toHaveLength(1)
  })

  test('a socket nobody serves fails to connect', async () => {
    expect(await CodexAppServer.connect(join(dir, 'missing.sock'), '0.10.0').catch(() => 'failed')).toBe('failed')
  })
})
