import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { type CodexApproval, CodexDriver, decisionFor, readApproval } from '../src/codex/driver'

// A Codex app-server with one thread, `t1`, whose answers each test sets.
const dir = mkdtempSync(join(tmpdir(), 'tonton-codex-'))
const socket = join(dir, 'app.sock')
type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }
let received: Message[] = []
let client: ServerWebSocket<unknown> | null = null
let turns: { id: string; status: string }[] = []
let steerFails = false
const server = Bun.serve({
  unix: socket,
  fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('', { status: 400 })),
  websocket: {
    open: ws => {
      client = ws
    },
    message(ws, raw) {
      const m = JSON.parse(String(raw)) as Message
      received.push(m)
      const reply = (result: unknown) => ws.send(JSON.stringify({ id: m.id, result }))
      if (m.method === 'initialize') reply({})
      else if (m.method === 'thread/resume') reply({ thread: { id: 't1', turns }, model: 'gpt-5-codex' })
      else if (m.method === 'turn/start') reply({ turn: { id: 'turn-new', status: 'inProgress' } })
      else if (m.method === 'turn/steer')
        ws.send(
          JSON.stringify(steerFails ? { id: m.id, error: { message: 'no active turn' } } : { id: m.id, result: { turnId: 'turn-1' } }),
        )
      else if (m.method === 'turn/interrupt' || m.method === 'thread/compact/start') reply({})
    },
  },
})
const push = (message: unknown) => client?.send(JSON.stringify(message))

afterAll(() => {
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  received = []
  turns = []
  steerFails = false
})

async function until<T>(read: () => T | undefined | false, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read()
    if (value !== undefined && value !== false) return value
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const events = () => ({ asked: [] as CodexApproval[], resolved: [] as string[] })

const attach = async (log = events()) => ({
  log,
  driver: await CodexDriver.attach(socket, 't1', '0.10.0', {
    approval: a => log.asked.push(a),
    resolved: id => log.resolved.push(id),
    closed: () => {},
  }),
})
const sent = (method: string) => received.filter(m => m.method === method)

describe('driving a Codex thread', () => {
  test('a prompt starts a turn, with its images by path, and joins the turn that runs', async () => {
    const { driver } = await attach()
    expect(sent('thread/resume')[0]?.params).toEqual({ threadId: 't1' })
    // The model the thread runs on, as the server said it: what a pool machine checks it started the task's session on.
    expect(driver.model).toBe('gpt-5-codex')
    expect(driver.working).toBe(false)
    await driver.prompt('Fix the build', ['/inbox/a.png'])
    expect(sent('turn/start')[0]?.params).toEqual({
      threadId: 't1',
      input: [
        { type: 'text', text: 'Fix the build', text_elements: [] },
        { type: 'localImage', path: '/inbox/a.png' },
      ],
    })
    expect(driver.working).toBe(true)
    await driver.prompt('and the tests too')
    expect(sent('turn/steer')[0]?.params).toMatchObject({ threadId: 't1', expectedTurnId: 'turn-new' })
    push({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn-new' } } })
    await until(() => !driver.working, 'the end of the turn')
    expect(await driver.interrupt()).toBe(false)
    driver.close()
  })

  test('it finds the turn that runs when it joins, and interrupts it; a turn that ended meanwhile gets a new one', async () => {
    turns = [
      { id: 'turn-0', status: 'completed' },
      { id: 'turn-1', status: 'inProgress' },
    ]
    const { driver } = await attach()
    expect(driver.working).toBe(true)
    expect(await driver.interrupt()).toBe(true)
    expect(sent('turn/interrupt')[0]?.params).toEqual({ threadId: 't1', turnId: 'turn-1' })
    steerFails = true
    await driver.prompt('next')
    expect(sent('turn/steer')).toHaveLength(1)
    expect(sent('turn/start')).toHaveLength(1)
    await driver.compact()
    expect(sent('thread/compact/start')[0]?.params).toEqual({ threadId: 't1' })
    driver.close()
  })

  test("its approvals reach the notch, get the answer in the request's words, and close when the TUI answers", async () => {
    const { driver, log } = await attach()
    push({
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't1', turnId: 'x', itemId: 'i1', command: 'make deploy' },
    })
    push({ id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 'other', command: 'rm -rf /' } })
    push({ id: 'p1', method: 'execCommandApproval', params: { conversationId: 't1', command: ['npm', 'test'], reason: 'needs network' } })
    await until(() => log.asked.length === 2, 'two approvals')
    expect(log.asked.map(a => [a.requestId, a.detail.toolName, a.detail.description, a.input.command])).toEqual([
      ['7', 'Bash', 'Run a command', 'make deploy'],
      ['p1', 'Bash', 'needs network', 'npm test'],
    ])
    expect(driver.answer('7', 'acceptForSession')).toBe(true)
    expect(driver.answer('7', 'accept')).toBe(false)
    await until(() => received.some(m => m.id === 7), 'the answer')
    expect(received.find(m => m.id === 7)?.result).toEqual({ decision: 'acceptForSession' })
    push({ method: 'serverRequest/resolved', params: { threadId: 't1', requestId: 'p1' } })
    await until(() => log.resolved.length === 2, 'the TUI answered')
    expect(log.resolved).toEqual(['7', 'p1'])
    expect(driver.answer('p1', 'decline')).toBe(false)
    driver.close()
  })

  test('a patch approval names the files its item said it changes, and the end of the turn closes what is left', async () => {
    const { driver, log } = await attach()
    push({
      method: 'item/started',
      params: {
        threadId: 't1',
        turnId: 'x',
        item: { type: 'fileChange', id: 'f1', changes: [{ path: '/srv/app.ts', kind: 'update', diff: '' }] },
      },
    })
    push({ id: 9, method: 'item/fileChange/requestApproval', params: { threadId: 't1', turnId: 'x', itemId: 'f1' } })
    await until(() => log.asked.length === 1, 'the approval')
    expect(log.asked[0]?.detail).toEqual({ toolName: 'Edit', description: 'Edit a file', inputPreview: '{"file_path":"/srv/app.ts"}' })
    push({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'x' } } })
    await until(() => log.resolved.length === 1, 'the close')
    expect(driver.answer('9', 'accept')).toBe(false)
    driver.close()
  })

  test('what an approval asks and how it is answered', () => {
    expect(readApproval('applyPatchApproval', { fileChanges: { '/a.ts': {}, '/b.ts': {} } })?.detail.description).toBe('Edit 2 files')
    expect(readApproval('item/permissions/requestApproval', { permissions: {} })).toBeNull()
    expect(readApproval('item/commandExecution/requestApproval', { command: '  ' })).toBeNull()
    expect(decisionFor('applyPatchApproval', 'decline')).toBe('denied')
    expect(decisionFor('item/fileChange/requestApproval', 'decline')).toBe('decline')
  })
})
