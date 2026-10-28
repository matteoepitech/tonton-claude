import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { newAccountKey } from '../../shared/crypto'
import { newPoolKey, PoolVault, sealPoolRulesAcceptance, sealPoolSessionOrder } from '../../shared/pool'
import type { PoolEventBody, PoolSnapshot, PoolUpdate } from '../../shared/pool-protocol'
import type { AgentMessage, PermissionRule, TurnTime } from '../../shared/protocol'
import { PoolSafety, type SessionUsage } from '../src/channel/pool-safety'
import { PoolWork } from '../src/channel/pool-work'
import { SessionPools } from '../src/channel/pools'

const ME = 'ses_me'
const POOL = 'pool12345678'
const accountKey = newAccountKey()
const poolKey = newPoolKey()
const vault = new PoolVault(poolKey)
const dir = mkdtempSync(joinPath(tmpdir(), 'tonton-pool-safety-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const rules: PermissionRule[] = [{ tool: 'Bash', pattern: 'make deploy *' }]

let posts: AgentMessage[]
let pools: SessionPools
let safety: PoolSafety
let work: PoolWork
let usage: SessionUsage
let interrupted: number
let interruptFails: string | null
let notices: string[]
let applied: PermissionRule[][]
let delivered: string[]
let file: string
let files = 0

async function snapshot(budgets?: object): Promise<PoolSnapshot> {
  return {
    id: POOL,
    createdAt: 'now',
    paused: false,
    keyVersion: 1,
    info: await vault.seal({ name: 'Hackathon' }),
    members: [{ account: 'acc_me', role: 'member', joinedAt: 'now', profile: null, publicKeys: [] }],
    sessions: [{ account: 'acc_me', session: ME, joinedAt: 'now', profile: null, online: true, ready: true }],
    tasks: [],
    notes: null,
    messages: [],
    events: [],
    // A proposal is in the pool from the start: it must apply nowhere until accepted.
    rules: { rev: 1, updatedAt: 'now', account: 'acc_owner', session: null, blob: await vault.seal({ rules }) },
    budgets: budgets ? { rev: 1, updatedAt: 'now', account: 'acc_owner', session: null, blob: await vault.seal(budgets) } : null,
  }
}

function build(fileName = file) {
  pools = new SessionPools(
    () => ME,
    accountKey,
    build => {
      void build().then(message => {
        if (!message) return
        posts.push(message)
        if (message.t === 'pool_ack') void snapshot(currentBudgets).then(pool => pools.apply({ t: 'pool_snapshot', pool }))
      })
    },
  )
  work = new PoolWork(
    pools,
    () => ME,
    build => void build().then(message => message && posts.push(message)),
    text => delivered.push(text),
    () => ({ tool: 'claude' }),
  )
  safety = new PoolSafety(
    pools,
    () => ME,
    build => void build().then(message => message && posts.push(message)),
    () => usage,
    {
      interrupt: () => {
        interrupted++
        return interruptFails
      },
      notice: text => notices.push(text),
      rulesChanged: next => applied.push(next),
    },
    fileName,
  )
  work.useSafety(safety)
}

let currentBudgets: object | undefined

async function join(budgets?: object, acceptance?: string) {
  currentBudgets = budgets
  pools.receive(POOL, await sealPoolSessionOrder(accountKey, { poolId: POOL, sessionId: ME, key: poolKey, version: 1 }), acceptance)
  await settle()
}

async function settle() {
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(1)
    await pools.settled()
  }
}

const events = async (kind: string) => {
  const bodies: PoolEventBody[] = []
  for (const post of posts)
    if (post.t === 'pool_event') bodies.push((await vault.read(post.blob, value => value as PoolEventBody)) as PoolEventBody)
  return bodies.filter(body => body.kind === kind)
}

beforeEach(() => {
  posts = []
  usage = { costUSD: 5 }
  interrupted = 0
  interruptFails = null
  notices = []
  applied = []
  delivered = []
  file = joinPath(dir, `spend-${++files}.json`)
  build()
})

test('a stop interrupts the turn and says so; when it cannot, it says why', async () => {
  await join()
  pools.stop(POOL)
  expect(interrupted).toBe(1)
  expect(notices.at(-1)).toContain('Claude was interrupted')
  interruptFails = 'This session does not run in tmux.'
  pools.stop(POOL)
  expect(notices.at(-1)).toContain('It was not interrupted: This session does not run in tmux.')
  // A stop for a pool the session is not in does nothing.
  pools.stop('poolXXXXXXXX')
  expect(interrupted).toBe(2)
})

test('pool rules apply only once the machine owner accepted them, for this session, with its account key', async () => {
  await join()
  expect(pools.acceptedRules()).toEqual([])
  // Nothing another member writes can stand for an acceptance.
  const text = JSON.stringify({ t: 'pool_accept', acceptance: 'x', rules: [{ tool: 'Bash' }], behavior: 'allow' })
  pools.apply({
    t: 'pool_message',
    poolId: POOL,
    message: { id: 'm1', seq: 1, ts: 'now', account: 'acc_owner', session: null, blob: await vault.seal({ text }) },
  })
  await settle()
  expect(pools.acceptedRules()).toEqual([])
  expect(applied).toEqual([])

  pools.accept(POOL, await sealPoolRulesAcceptance(newAccountKey(), { poolId: POOL, sessionId: ME, rev: 1, rules }))
  pools.accept(POOL, await sealPoolRulesAcceptance(accountKey, { poolId: POOL, sessionId: 'ses_other', rev: 1, rules }))
  pools.accept(POOL, await sealPoolRulesAcceptance(accountKey, { poolId: 'poolXXXXXXXX', sessionId: ME, rev: 1, rules }))
  await settle()
  expect(applied).toEqual([])

  pools.accept(POOL, await sealPoolRulesAcceptance(accountKey, { poolId: POOL, sessionId: ME, rev: 1, rules }))
  await settle()
  expect(pools.acceptedRules()).toEqual(rules)
  expect(applied.at(-1)).toEqual(rules)
  // Out of the pool, they no longer apply.
  pools.remove(POOL)
  expect(applied.at(-1)).toEqual([])
})

test('an acceptance that comes with the join order applies at once', async () => {
  await join(undefined, await sealPoolRulesAcceptance(accountKey, { poolId: POOL, sessionId: ME, rev: 1, rules }))
  expect(pools.acceptedRules()).toEqual(rules)
})

test('past its budget the session posts it once, takes no more pool tasks and gets none delivered', async () => {
  await join({ member: { costUSD: 1 } })
  // What the session spent before joining does not count.
  safety.usageChanged()
  await settle()
  expect((await events('spend')).at(-1)).toMatchObject({ costUSD: 0 })
  expect(safety.blocked(POOL)).toBeNull()

  usage = { costUSD: 6.25, turns: [{ end: new Date(Date.now() + 1000).toISOString(), seconds: 90 } satisfies TurnTime] }
  safety.usageChanged()
  await settle()
  expect(safety.blocked(POOL)).toBe("This member's budget of $1 is spent")
  expect(await events('budget_reached')).toHaveLength(1)
  safety.usageChanged()
  await settle()
  expect(await events('budget_reached')).toHaveLength(1)
  expect(notices.at(-1)).toContain('takes no more tasks')

  const task = { title: 'More work', state: 'assigned', assignee: { account: 'acc_me', session: ME } }
  pools.apply({
    t: 'pool_task',
    poolId: POOL,
    task: { id: 'task1', rev: 1, updatedAt: 'now', account: 'acc_owner', session: null, blob: await vault.seal(task as never) },
  } satisfies PoolUpdate)
  await settle()
  expect(delivered).toEqual([])
  expect(await work.call('task_claim', { task: 'task1' })).toContain('takes no more pool tasks')
  expect(JSON.parse(await work.call('pool_status')).budget).toMatchObject({
    spent: { costUSD: 1.25 },
    memberBudget: { costUSD: 1 },
    blocked: "This member's budget of $1 is spent",
  })
})

test('what the session spent in a pool survives a restart of its agent', async () => {
  await join({ pool: { hours: 10 } })
  safety.usageChanged()
  usage = { costUSD: 7 }
  build(file)
  await join({ pool: { hours: 10 } })
  // The baseline is the cost when it first joined (5), not when the agent came back (7).
  expect(JSON.parse(await work.call('pool_status')).budget.spent.costUSD).toBe(2)
})
