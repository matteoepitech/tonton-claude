// What a pool hands a Codex run by `tonton codex`, through its channel's CodexNotch: posts go into the thread one after
// the other (a new turn, then into it), a pool's stop interrupts the turn, the channel says which model the thread runs
// on for a pool machine, and the pool rules and a pool machine's mode answer Codex's approvals as they do Claude Code's.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import type { PermissionDetail } from '../../shared/protocol'
import { CodexNotch } from '../src/codex/notch'
import { codexModelFile } from '../src/codex/wrapper'
import { setPoolMode, setPoolRules } from '../src/rules'

const dir = mkdtempSync(join(tmpdir(), 'tonton-codex-notch-'))
const root = realpathSync(dir)
const socket = join(dir, 'app.sock')
type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }
let received: Message[] = []
let client: ServerWebSocket<unknown> | null = null
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
      if (m.method === 'thread/resume') reply({ thread: { id: 'thread-1', turns: [] }, model: 'gpt-5.4' })
      // The turn's answer comes a moment later: a second post must not start another turn meanwhile.
      else if (m.method === 'turn/start') setTimeout(() => reply({ turn: { id: 'turn-1', status: 'inProgress' } }), 50)
      else if (m.method && m.id !== undefined) reply({})
    },
  },
})

afterAll(() => {
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  received = []
})

async function until<T>(read: () => T | undefined | false, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read()
    if (value !== undefined && value !== false) return value
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const asked: { requestId: string; detail: PermissionDetail }[] = []
const notices: string[] = []
const session = (sessionId: string) => ({
  link: { sessionId },
  addPermission: (requestId: string, detail: PermissionDetail) => asked.push({ requestId, detail }),
  resolvePermission: () => {},
  closePermission: () => {},
  notice: (text: string) => notices.push(text),
})
const sent = (method: string) => received.filter(m => m.method === method)

describe('a pool and a Codex run by tonton codex', () => {
  const notch = new CodexNotch(socket, 'unused', () => session('thread-1'))

  test('the channel says which model the thread runs on, as its server answered', async () => {
    notch.follow('thread-1')
    await until(() => sent('thread/resume').length, 'the thread joined')
    const said = await until(() => {
      try {
        return JSON.parse(readFileSync(codexModelFile('thread-1'), 'utf8'))
      } catch {
        return undefined
      }
    }, 'the model file')
    expect(said).toEqual({ model: 'gpt-5.4' })
  })

  test('posts go in one after the other: the first starts a turn, the next one joins it', async () => {
    const [first, second] = await Promise.all([
      notch.inject('<pool kind="task" from="Ana">A</pool>'),
      notch.inject('<pool kind="message" from="Ana">B</pool>'),
    ])
    expect([first, second]).toEqual([true, true])
    expect(sent('turn/start')).toHaveLength(1)
    expect(sent('turn/start')[0]?.params?.input).toEqual([
      { type: 'text', text: '<pool kind="task" from="Ana">A</pool>', text_elements: [] },
    ])
    expect(sent('turn/steer')[0]?.params).toMatchObject({ threadId: 'thread-1', expectedTurnId: 'turn-1' })
  })

  test("a pool's stop interrupts the running turn", async () => {
    expect(await notch.interrupt()).toBeNull()
    expect(sent('turn/interrupt')[0]?.params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' })
  })

  test("the pool rules its owner accepted and a pool machine's mode answer Codex's approvals; the rest asks", async () => {
    setPoolMode('thread-1', { mode: 'edits', root })
    setPoolRules('thread-1', [{ tool: 'Bash', pattern: 'git push *' }])
    const request = (id: number, method: string, params: Record<string, unknown>) =>
      client?.send(JSON.stringify({ id, method, params: { threadId: 'thread-1', turnId: 'turn-1', ...params } }))
    const answer = (id: number) => received.find(m => m.id === id && 'result' in m)?.result
    // A patch in the worktree passes with `edits`; one that also writes outside asks.
    request(1, 'item/fileChange/requestApproval', { itemId: 'p1', fileChanges: { [join(root, 'a.ts')]: {}, [join(root, 'b.ts')]: {} } })
    expect(await until(() => answer(1), 'the patch approved')).toEqual({ decision: 'accept' })
    request(2, 'item/fileChange/requestApproval', { itemId: 'p2', fileChanges: { [join(root, 'a.ts')]: {}, '/etc/hosts': {} } })
    await until(() => asked.some(a => a.requestId === '2'), 'the owner asked')
    // A command the pool rules allow passes; another one asks.
    request(3, 'item/commandExecution/requestApproval', { itemId: 'c1', command: 'git push -u origin pool/t1-cart' })
    expect(await until(() => answer(3), 'the push approved')).toEqual({ decision: 'accept' })
    request(4, 'item/commandExecution/requestApproval', { itemId: 'c2', command: 'rm -rf build' })
    await until(() => asked.some(a => a.requestId === '4'), 'the owner asked for the command')
    expect(answer(2)).toBeUndefined()
    expect(answer(4)).toBeUndefined()
    // `full` passes everything.
    setPoolMode('thread-1', { mode: 'full', root })
    request(5, 'item/commandExecution/requestApproval', { itemId: 'c3', command: 'rm -rf build' })
    expect(await until(() => answer(5), 'the command approved')).toEqual({ decision: 'accept' })
    setPoolMode('thread-1', null)
    setPoolRules('thread-1', [])
  })

  test('a server that is gone takes no post, and the notch says why it could not stop it', async () => {
    const gone = new CodexNotch(join(dir, 'none.sock'), 'unused', () => session('thread-9'))
    gone.follow('thread-9')
    expect(await gone.inject('<pool kind="task" from="Ana">A</pool>')).toBe(false)
    expect(await gone.interrupt()).toContain('cannot be reached')
    expect(JSON.parse(readFileSync(codexModelFile('thread-9'), 'utf8')).problem).toContain('could not join')
  })
})
