// A pool machine's mode (docs/pool-autopilot.md): what its sessions may do without asking. It comes only from the order
// sealed with the account key by the machine's own service, for that session on that machine: neither the pool's
// profile of the machine, nor the relay, nor an order for another machine sets it or widens it. `edits` passes file edits
// and read-only tools in the session's folder only, `full` everything, `ask` nothing.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newAccountKey } from '../../shared/crypto'
import { sealPoolSessionOrder } from '../../shared/pool'
import { sealPoolMachineOrder } from '../../shared/pool-machines'
import type { AgentMessage } from '../../shared/protocol'
import { SessionPools } from '../src/channel/pools'
import { clearSessionRules, modeAllows, poolMode, setPoolMode } from '../src/rules'
import { MachinePools } from '../src/service/pool-machines'

const AGENT = join(import.meta.dir, '../src/main.ts')
const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-mode-'))
const root = join(dir, 'tasks', 'task0001abc')
mkdirSync(root, { recursive: true })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const accountKey = newAccountKey()
const poolKey = newAccountKey()
const poolId = 'pool00000001'

describe('what a mode lets pass', () => {
  test('full: everything; ask, or no mode: nothing', () => {
    expect(modeAllows({ mode: 'full', root }, 'Bash', { command: 'rm -rf /' })).toBe(true)
    expect(modeAllows({ mode: 'ask', root }, 'Read', { file_path: join(root, 'a') })).toBe(false)
    expect(modeAllows(null, 'Edit', { file_path: join(root, 'a') })).toBe(false)
  })

  test('edits: file edits and read-only tools, in the session’s folder only', () => {
    const edits = { mode: 'edits' as const, root }
    for (const [tool, input] of [
      ['Edit', { file_path: join(root, 'src', 'a.ts') }],
      ['Write', { file_path: 'notes.md' }],
      ['MultiEdit', { file_path: join(root, 'b.ts') }],
      ['Read', { file_path: join(root, 'README.md') }],
      ['Grep', { pattern: 'x' }],
      ['Glob', { pattern: '**/*.ts', path: root }],
      ['TodoWrite', { todos: [] }],
    ] as const) {
      expect(modeAllows(edits, tool, input)).toBe(true)
    }
    for (const [tool, input] of [
      ['Bash', { command: 'ls' }],
      ['WebFetch', { url: 'https://example.com' }],
      ['Edit', { file_path: join(dir, 'outside.ts') }],
      ['Write', { file_path: '../other/a.ts' }],
      ['Read', { file_path: '/etc/passwd' }],
      ['Grep', { pattern: 'key', path: join(dir) }],
      ['Edit', { file_path: 5 }],
    ] as const) {
      expect(modeAllows(edits, tool, input)).toBe(false)
    }
  })

  test('a link in the folder that points out of it takes no edit out with it', () => {
    mkdirSync(join(dir, 'secrets'))
    symlinkSync(join(dir, 'secrets'), join(root, 'docs'))
    expect(modeAllows({ mode: 'edits', root }, 'Write', { file_path: join(root, 'docs', 'key.pem') })).toBe(false)
    expect(modeAllows({ mode: 'edits', root }, 'Write', { file_path: join(root, 'new', 'file.ts') })).toBe(true)
  })

  test("it is kept in the session's file for the hook, and goes with the session", () => {
    const folder = join(dir, 'session-rules')
    setPoolMode('ses_1', { mode: 'edits', root }, folder)
    expect(poolMode('ses_1', folder)).toEqual({ mode: 'edits', root })
    // Ask is no mode at all: nothing passes without asking.
    setPoolMode('ses_1', { mode: 'ask', root }, folder)
    expect(poolMode('ses_1', folder)).toBeNull()
    setPoolMode('ses_1', { mode: 'full', root }, folder)
    clearSessionRules('ses_1', folder)
    expect(poolMode('ses_1', folder)).toBeNull()
  })
})

describe('the PermissionRequest hook', () => {
  const home = join(dir, 'hook-home')
  const ask = async (tool: string, input: object) => {
    const event = { hook_event_name: 'PermissionRequest', session_id: 'ses_worker', tool_name: tool, tool_input: input }
    const env = { ...process.env, TONTON_HOME: home, TONTON_SERVICE: 'off' } as Record<string, string>
    const hook = Bun.spawn(['bun', AGENT, 'hook'], { env, stdin: new Blob([JSON.stringify(event)]), stdout: 'pipe' })
    return new Response(hook.stdout).text()
  }

  test("approves what the session's mode lets pass, and asks for the rest", async () => {
    setPoolMode('ses_worker', { mode: 'edits', root }, join(home, 'session-rules'))
    expect(JSON.parse(await ask('Edit', { file_path: join(root, 'a.ts') }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
    expect(await ask('Bash', { command: 'git push' })).toBe('')
    expect(await ask('Edit', { file_path: join(dir, 'a.ts') })).toBe('')
  }, 20_000)
})

describe('only the account-key order of this machine sets it', () => {
  const machineId = 'machine00001'
  type Post = (build: () => Promise<AgentMessage | null>) => void
  const posting = () => {
    const sent: AgentMessage[] = []
    const post: Post = build => void build().then(message => message && sent.push(message))
    return { sent, post }
  }

  async function joined(order: string, sessionId = 'ses_worker') {
    const { sent, post } = posting()
    const pools = new SessionPools(() => sessionId, accountKey, post)
    pools.receive(poolId, order)
    for (let i = 0; i < 50 && !sent.length; i++) await Bun.sleep(10)
    return { pools, acked: sent.some(m => m.t === 'pool_ack') }
  }

  const order = (fields: Partial<Parameters<typeof sealPoolSessionOrder>[1]>, key = accountKey) =>
    sealPoolSessionOrder(key, { poolId, sessionId: 'ses_worker', key: poolKey, version: 1, ...fields })

  test("a worker order from this machine's service: its mode, for this machine only", async () => {
    const { pools, acked } = await joined(await order({ autoStart: true, machine: machineId, mode: 'edits' }))
    expect(acked).toBe(true)
    expect(pools.workerMode(machineId)).toBe('edits')
    // The relay moved it to a session on another machine of the account: it names its machine, which is not this one.
    expect(pools.workerMode('machine00002')).toBeNull()
  })

  test('a session put in the pool by hand has no mode; a forged order is not taken at all', async () => {
    expect((await joined(await order({ autoStart: true }))).pools.workerMode(machineId)).toBeNull()
    const forged = await joined(await order({ machine: machineId, mode: 'full' }, newAccountKey()))
    expect(forged.acked).toBe(false)
    expect(forged.pools.workerMode(machineId)).toBeNull()
    // Nor one for another session, as the relay could hand it.
    const moved = await joined(await order({ machine: machineId, mode: 'full' }), 'ses_other')
    expect(moved.acked).toBe(false)
  })

  test('in several pools the narrowest mode wins, and leaving takes the mode away', async () => {
    const { pools } = await joined(await order({ machine: machineId, mode: 'full' }))
    const second = await sealPoolSessionOrder(accountKey, {
      poolId: 'pool00000002',
      sessionId: 'ses_worker',
      key: poolKey,
      version: 1,
      machine: machineId,
      mode: 'edits',
    })
    pools.receive('pool00000002', second)
    for (let i = 0; i < 50 && pools.workerMode(machineId) !== 'edits'; i++) await Bun.sleep(10)
    expect(pools.workerMode(machineId)).toBe('edits')
    pools.remove('pool00000002')
    pools.remove(poolId)
    expect(pools.workerMode(machineId)).toBeNull()
  })

  test('the machine takes no machine order older than the one it has, nor the same one after it was taken out', async () => {
    const { post } = posting()
    const file = join(dir, 'machine-orders.json')
    const pools = new MachinePools(accountKey, machineId, post, () => {}, file)
    const profile = { tool: 'claude' as const, capacity: 1, workdir: '~/pool', mode: 'ask' as const }
    const seal = (mode: 'ask' | 'full', at: string) =>
      sealPoolMachineOrder(accountKey, { poolId, machineId, key: poolKey, version: 1, profile: { ...profile, mode } }, new Date(at))
    const older = await seal('full', '2026-10-28T10:00:00Z')
    const newer = await seal('ask', '2026-10-28T11:00:00Z')
    pools.receive(poolId, newer)
    for (let i = 0; i < 50 && !pools.order(poolId); i++) await Bun.sleep(10)
    // The relay brings the older order back, with a wider mode: refused, the owner's newer choice stays.
    pools.receive(poolId, older)
    await Bun.sleep(100)
    expect(pools.order(poolId)?.profile.mode).toBe('ask')
    // Taken out, then the same order again: refused. A restarted service remembers it.
    pools.remove(poolId)
    const restarted = new MachinePools(accountKey, machineId, post, () => {}, file)
    restarted.receive(poolId, newer)
    await Bun.sleep(100)
    expect(restarted.order(poolId)).toBeNull()
    // Only a new order from the owner puts it back.
    restarted.receive(poolId, await seal('ask', '2026-10-28T12:00:00Z'))
    for (let i = 0; i < 50 && !restarted.order(poolId); i++) await Bun.sleep(10)
    expect(restarted.order(poolId)?.profile.mode).toBe('ask')
  })
})
