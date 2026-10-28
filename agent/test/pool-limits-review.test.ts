// Account limits (#231) and review (#232) in a pool: the rules, and a session's agent against a relay that answers like
// the real one.
import { beforeEach, describe, expect, test } from 'bun:test'
import { newAccountKey } from '../../shared/crypto'
import { newPoolKey, type PoolSession, type PoolState, PoolVault, sealPoolSessionOrder } from '../../shared/pool'
import type {
  PoolEventBody,
  PoolLimits,
  PoolPostWire,
  PoolSessionRef,
  PoolSnapshot,
  PoolTask,
  PoolTaskWire,
  PoolUpdate,
} from '../../shared/pool-protocol'
import type { AgentMessage, UsageLimit } from '../../shared/protocol'
import { LimitsReporter, limitsMark, nearLimit, shortOfTime, shouldPost } from '../src/channel/pool-limits'
import { candidates, refusal } from '../src/channel/pool-orchestrator'
import { reviewers } from '../src/channel/pool-review'
import { PoolWork, type SessionDescription } from '../src/channel/pool-work'
import { SessionPools } from '../src/channel/pools'

const NOW = Date.parse('2026-10-27T10:00:00Z')
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()
const window = (usedPercent: number, resetsInMinutes = 200) => ({ usedPercent, resetsAt: at(resetsInMinutes) })

describe('the rules', () => {
  test('a plan leaves no time when a window is used up, or runs out before the task would be done', () => {
    expect(shortOfTime(undefined, 3, NOW)).toBeNull()
    expect(shortOfTime({ fiveHour: window(100, 90) }, 1, NOW)).toContain('used up')
    expect(shortOfTime({ sevenDay: window(100, 600) }, 1, NOW)).toContain('weekly')
    const soon = { fiveHour: window(80), runsOutAt: at(40) }
    expect(shortOfTime(soon, 3, NOW)).toContain('runs out in about 40 min')
    expect(shortOfTime(soon, 0.5, NOW)).toBeNull()
    // A forecast in the past says nothing any more.
    expect(shortOfTime({ fiveHour: window(80), runsOutAt: at(-5) }, 3, NOW)).toBeNull()
  })

  test('a session holding a task hands it over when its window runs out soon or is nearly used up', () => {
    expect(nearLimit({ fiveHour: window(70), runsOutAt: at(15) }, NOW)).toContain('15 min')
    expect(nearLimit({ fiveHour: window(97) }, NOW)).toContain('97 %')
    expect(nearLimit({ fiveHour: window(60), runsOutAt: at(90) }, NOW)).toBeNull()
    // A window that already reset is a new one.
    expect(nearLimit({ fiveHour: window(99, -1) }, NOW)).toBeNull()
  })

  test('the agent forecasts from its own readings, and posts again only when the figures move or are old', () => {
    const reporter = new LimitsReporter()
    const usage = (percent: number): { fiveHour: UsageLimit } => ({ fiveHour: { usedPercent: percent, resetsAt: at(200) } })
    expect(reporter.current(undefined, NOW)).toBeNull()
    expect(reporter.current(usage(40), NOW)?.runsOutAt).toBeUndefined()
    reporter.current(usage(45), NOW + 10 * 60_000)
    const limits = reporter.current(usage(50), NOW + 20 * 60_000)
    // 10 points in 20 minutes: 50 left at 0.5 a minute.
    expect(limits).toEqual({ fiveHour: { usedPercent: 50, resetsAt: at(200) }, runsOutAt: at(120) })
    const mark = limitsMark(limits as PoolLimits)
    expect(shouldPost(undefined, mark, NOW)).toBe(true)
    expect(shouldPost({ mark, at: NOW }, mark, NOW + 5 * 60_000)).toBe(false)
    expect(shouldPost({ mark, at: NOW }, mark, NOW + 11 * 60_000)).toBe(true)
    expect(shouldPost({ mark: 'other', at: NOW }, mark, NOW + 30_000)).toBe(false)
    expect(shouldPost({ mark: 'other', at: NOW }, mark, NOW + 61_000)).toBe(true)
  })

  const session = (id: string, tool: 'claude' | 'opencode', area?: string): PoolSession => ({
    account: `acc_${id}`,
    session: id,
    joinedAt: `t-${id}`,
    profile: { tool, ...(area ? { area } : {}) },
    online: true,
    ready: true,
    status: null,
    accepted: 0,
  })
  const state = (sessions: PoolSession[], tasks: PoolState['tasks'] = []): PoolState => ({
    id: 'p',
    createdAt: 'then',
    paused: false,
    rules: null,
    budgets: null,
    audit: [],
    keyVersion: 1,
    info: null,
    members: [],
    sessions,
    tasks,
    notes: null,
    messages: [],
    events: [],
    own: { secret: null, wraps: [] },
    orchestrator: null,
  })

  test('the orchestrator skips a Claude Code session short of time, never an OpenCode one, and no review session', () => {
    const s = state([
      session('cc_low', 'claude'),
      session('cc_ok', 'claude'),
      session('oc', 'opencode'),
      session('rev', 'claude', 'review'),
    ])
    const descriptions = new Map<string, SessionDescription>([
      ['acc_cc_low/cc_low', { tool: 'claude', limits: { fiveHour: window(90), runsOutAt: at(30) } }],
      ['acc_cc_ok/cc_ok', { tool: 'claude', limits: { fiveHour: window(20) } }],
      ['acc_oc/oc', { tool: 'opencode' }],
    ])
    const ids = (task: Pick<PoolTask, 'size' | 'hours'>) => candidates(s, task, descriptions, [], NOW).map(c => c.session.session)
    expect(ids({ size: 'large' })).toEqual(['cc_ok'])
    // A short task still fits before the window runs out; simple tasks go to OpenCode first, as always.
    expect(ids({ size: 'large', hours: 0.25 })).toEqual(['cc_low', 'cc_ok'])
    expect(ids({ size: 'simple' })).toEqual(['oc', 'cc_ok'])
    const low = s.sessions[0]
    expect(refusal(s, { title: 'x', state: 'todo' }, low, descriptions, NOW)).toContain('plan leaves no time')
  })

  test('the reviewer is of the review area, never the author, the last reviewer first', () => {
    const s = state([session('author', 'claude'), session('rev1', 'claude', 'review'), session('rev2', 'opencode', 'review')])
    const author = { account: 'acc_author', session: 'author' }
    expect(reviewers(s, { assignee: author }).map(r => r.session)).toEqual(['rev1', 'rev2'])
    expect(reviewers(s, { assignee: author, reviewer: { account: 'acc_rev2', session: 'rev2' } })[0].session).toBe('rev2')
    expect(reviewers(s, { assignee: { account: 'acc_rev1', session: 'rev1' } }).map(r => r.session)).toEqual(['rev2'])
  })
})

// MARK: The agent

const POOL = 'pool12345678'
const accountKey = newAccountKey()
const poolKey = newPoolKey()
const vault = new PoolVault(poolKey)

interface Peer {
  account: string
  session: string
  area?: string
  tool: 'claude' | 'opencode'
  limits?: PoolLimits
}

/** A relay that answers like the real one: revisions, conflicts, and every post sent back to the members. */
class FakeRelay {
  tasks = new Map<string, PoolTaskWire>()
  seq = 10
  posts: AgentMessage[] = []
  pools!: SessionPools
  snapshot!: PoolSnapshot

  constructor(private readonly me: string) {}

  handle = async (message: AgentMessage) => {
    this.posts.push(message)
    const update = this.answer(message)
    if (update) this.pools.apply(update)
  }

  private answer(message: AgentMessage): PoolUpdate | null {
    const author = { account: `acc_${this.me}`, session: 'sessionId' in message ? message.sessionId : null }
    switch (message.t) {
      case 'pool_ack':
        return { t: 'pool_snapshot', pool: { ...this.snapshot, tasks: [...this.tasks.values()] } }
      case 'pool_task': {
        const current = this.tasks.get(message.id)
        if ((current?.rev ?? 0) !== message.rev)
          return { t: 'pool_conflict', poolId: POOL, kind: 'task', id: message.id, current: current ?? null }
        const task: PoolTaskWire = {
          id: message.id,
          rev: message.rev + 1,
          updatedAt: new Date().toISOString(),
          blob: message.blob,
          ...author,
        }
        this.tasks.set(message.id, task)
        return { t: 'pool_task', poolId: POOL, task }
      }
      case 'pool_message':
      case 'pool_event': {
        const post: PoolPostWire = { id: message.id, seq: ++this.seq, ts: 'now', blob: message.blob, ...author }
        return message.t === 'pool_message'
          ? { t: 'pool_message', poolId: POOL, message: post }
          : { t: 'pool_event', poolId: POOL, event: post }
      }
      default:
        return null
    }
  }

  /** Another member's session changes a task. */
  async otherTask(id: string, task: PoolTask, by: PoolSessionRef) {
    const wire: PoolTaskWire = {
      id,
      rev: (this.tasks.get(id)?.rev ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      blob: await vault.seal(task),
      ...by,
    }
    this.tasks.set(id, wire)
    this.pools.apply({ t: 'pool_task', poolId: POOL, task: wire })
    await settle()
  }

  read = async (id: string) => vault.read(this.tasks.get(id)?.blob, value => value as PoolTask)

  /** The sealed events this agent posted. */
  async events(kind: string): Promise<PoolEventBody[]> {
    const events = this.posts.filter((p): p is Extract<AgentMessage, { t: 'pool_event' }> => p.t === 'pool_event')
    const bodies = await Promise.all(events.map(e => vault.read(e.blob, value => value as PoolEventBody)))
    return bodies.filter((b): b is PoolEventBody => b?.kind === kind)
  }
}

let relay: FakeRelay
let pools: SessionPools
let work: PoolWork
let delivered: string[]
let plan: SessionDescription['plan']

async function start(me: string, tool: 'claude' | 'opencode', peers: Peer[], orchestrator: PoolSessionRef | null) {
  relay = new FakeRelay(me)
  let outbox = Promise.resolve()
  const post = (build: () => Promise<AgentMessage | null>) => {
    outbox = outbox.then(async () => {
      const message = await build()
      if (message) await relay.handle(message)
    })
  }
  pools = new SessionPools(() => me, accountKey, post)
  relay.pools = pools
  delivered = []
  work = new PoolWork(
    pools,
    () => me,
    post,
    text => delivered.push(text),
    () => ({ tool, model: tool === 'claude' ? 'claude-opus-5-5' : 'gpt-5', plan }),
    () => {},
    60_000,
  )
  const everyone: Peer[] = [{ account: `acc_${me}`, session: me, tool }, ...peers]
  relay.snapshot = {
    id: POOL,
    createdAt: 'then',
    paused: false,
    keyVersion: 1,
    info: await vault.seal({ name: 'Hackathon', goal: 'Ship the app' }),
    members: await Promise.all(
      everyone.map(async p => ({
        account: p.account,
        role: p.session === me ? ('owner' as const) : ('member' as const),
        joinedAt: 'then',
        profile: await vault.seal({ name: p.session }),
        publicKeys: [],
      })),
    ),
    sessions: await Promise.all(
      everyone.map(async (p, i) => ({
        account: p.account,
        session: p.session,
        joinedAt: `2026-10-27T09:0${i}:00Z`,
        profile: await vault.seal({ tool: p.tool, ...(p.area ? { area: p.area } : {}) }),
        online: true,
        ready: true,
      })),
    ),
    tasks: [],
    notes: null,
    messages: [],
    events: await Promise.all(
      peers
        .flatMap(p => [
          { p, body: { kind: 'session', tool: p.tool } },
          ...(p.limits ? [{ p, body: { kind: 'limits', limits: p.limits } }] : []),
        ])
        .map(async ({ p, body }, i) => ({
          id: `e${i}`,
          seq: i + 1,
          ts: 'then',
          blob: await vault.seal(body),
          account: p.account,
          session: p.session,
        })),
    ),
    orchestrator,
  }
  pools.receive(POOL, await sealPoolSessionOrder(accountKey, { poolId: POOL, sessionId: me, key: poolKey, version: 1, autoStart: true }))
  await settle()
}

async function settle() {
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(1)
    await pools.settled()
  }
}

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = work.call(name, args)
  await settle()
  return result
}

const big = (title: string, more: Partial<PoolTask> = {}) => ({
  title,
  goal: `${title}: the whole feature, from the data to the screen, with its tests`,
  criteria: ['it works end to end', 'its tests pass'],
  ...more,
})

const soon = new Date(Date.now() + 30 * 60_000).toISOString()
const later = new Date(Date.now() + 4 * 3_600_000).toISOString()

beforeEach(() => {
  plan = undefined
})

describe('limits in the pool', () => {
  test('a Claude Code session shares its plan as a sealed limits event, an OpenCode one shares nothing', async () => {
    plan = { fiveHour: { usedPercent: 42, resetsAt: later }, sevenDay: { usedPercent: 10, resetsAt: later } }
    await start('cc', 'claude', [], null)
    work.reportLimits()
    await settle()
    const shared = await relay.events('limits')
    expect(shared).toHaveLength(1)
    expect(shared[0].limits).toEqual({ fiveHour: { usedPercent: 42, resetsAt: later }, sevenDay: { usedPercent: 10, resetsAt: later } })
    // The same figures again right away: nothing new is posted.
    work.reportLimits()
    await settle()
    expect(await relay.events('limits')).toHaveLength(1)

    await start('oc', 'opencode', [], null)
    plan = { fiveHour: { usedPercent: 42, resetsAt: later } }
    work.reportLimits()
    await settle()
    expect(await relay.events('limits')).toEqual([])
  })

  test('the orchestrator sees each plan, and its rules skip a session about to run out', async () => {
    const low = { fiveHour: { usedPercent: 92, resetsAt: later }, runsOutAt: soon }
    await start(
      'lead',
      'claude',
      [
        { account: 'acc_low', session: 'low', tool: 'claude', limits: low },
        { account: 'acc_ok', session: 'ok', tool: 'claude', limits: { fiveHour: { usedPercent: 12, resetsAt: later } } },
        { account: 'acc_oc', session: 'oc', tool: 'opencode' },
      ],
      { account: 'acc_lead', session: 'lead' },
    )
    const overview = JSON.parse(await call('pool_overview'))
    const plan = (id: string) => overview.sessions.find((s: { session: string }) => s.session === id).plan
    expect(plan('oc')).toBe('no plan limit')
    expect(plan('low').runsOut).toContain('min at this pace')
    expect(plan('ok').fiveHour).toContain('12 % used')
    expect(await call('task_create', big('Checkout', { assign: 'auto' } as never))).toContain('(ok)')
    // The only free large-task session left is short of time: it is not given the task, and the orchestrator hears why.
    expect(await call('task_create', big('Search', { assign: 'auto' } as never))).toContain('No free session has time left')
    expect(await call('task_create', { ...big('Search banner'), hours: 0.25, assign: 'auto' })).toContain('(low)')
    expect(await call('task_create', { ...big('Search'), hours: -1 })).toContain('hours is a number')
  })

  test('near its limit, a session holding a task is told once to hand it over, and the orchestrator hears of it', async () => {
    plan = { fiveHour: { usedPercent: 97, resetsAt: later } }
    await start('cc', 'claude', [{ account: 'acc_lead', session: 'lead', tool: 'claude' }], { account: 'acc_lead', session: 'lead' })
    await relay.otherTask(
      't1',
      { ...big('Checkout'), state: 'in_progress', assignee: { account: 'acc_cc', session: 'cc' }, branch: 'pool/t1-checkout' },
      { account: 'acc_lead', session: 'lead' },
    )
    await settle()
    work.reportLimits()
    work.reportLimits()
    await settle()
    const asked = delivered.filter(d => d.includes('Handover:'))
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('pool/t1-checkout')

    // The orchestrator's agent, seeing that session's shared figures.
    const low = { fiveHour: { usedPercent: 97, resetsAt: later } }
    await start('lead', 'claude', [{ account: 'acc_cc', session: 'cc', tool: 'claude', limits: low }], {
      account: 'acc_lead',
      session: 'lead',
    })
    await relay.otherTask(
      't1',
      { ...big('Checkout'), state: 'in_progress', assignee: { account: 'acc_cc', session: 'cc' } },
      { account: 'acc_cc', session: 'cc' },
    )
    await settle()
    expect(delivered.filter(d => d.includes('97 % used') && d.includes('task_reassign'))).toHaveLength(1)
  })
})

describe('review in the pool', () => {
  const author = { account: 'acc_author', session: 'author' }
  const reviewer = { account: 'acc_rev', session: 'rev' }

  test('with a review session, task_done sends the task to review instead of done', async () => {
    await start('author', 'claude', [{ ...reviewer, area: 'review', tool: 'claude' }], null)
    await relay.otherTask('t1', { ...big('Checkout'), state: 'in_progress', assignee: author, branch: 'pool/t1-checkout' }, author)
    expect(await call('task_done', { task: 't1', summary: 'Built it', tests: 'bun test' })).toContain('Sent to review')
    expect(await relay.read('t1')).toMatchObject({ state: 'review', reviewer })
    expect((await relay.events('task_moved')).at(-1)?.text).toContain('review by')
  })

  test('without one, it is done at once', async () => {
    await start('author', 'claude', [{ account: 'acc_x', session: 'x', tool: 'claude' }], null)
    await relay.otherTask('t1', { ...big('Checkout'), state: 'in_progress', assignee: author, branch: 'pool/t1-checkout' }, author)
    expect(await call('task_done', { task: 't1', summary: 'Built it', tests: 'bun test' })).toBe('Done: the pool sees it.')
    expect((await relay.read('t1'))?.state).toBe('done')
  })

  test('the reviewer gets the branch and criteria, then sends it back with notes or accepts it', async () => {
    await start('rev', 'claude', [{ ...author, tool: 'claude' }], null)
    // The orchestrator does not exist here: the author's own task_done asked for the review.
    await relay.otherTask(
      't1',
      {
        ...big('Checkout'),
        state: 'review',
        assignee: author,
        reviewer,
        branch: 'pool/t1-checkout',
        summary: 'Built it\n\nTests: bun test',
      },
      author,
    )
    await settle()
    const brief = delivered.find(d => d.startsWith('<pool kind="review"'))
    expect(brief).toContain('git switch pool/t1-checkout')
    expect(brief).toContain('its tests pass')
    expect(brief).toContain('Tests: bun test')
    expect(await call('review_reject', { task: 't1' })).toContain('Say what to fix')
    expect(await call('review_reject', { task: 't1', notes: 'The total ignores the discount.' })).toContain('Sent back')
    expect(await relay.read('t1')).toMatchObject({ state: 'assigned', assignee: author, review: 'The total ignores the discount.' })
    expect(await call('review_accept', { task: 't1' })).toContain('not in review')
    await relay.otherTask('t1', { ...big('Checkout'), state: 'review', assignee: author, reviewer, branch: 'pool/t1-checkout' }, author)
    expect(await call('review_accept', { task: 't1', notes: 'Checked the discount.' })).toContain('Accepted')
    expect(await relay.read('t1')).toMatchObject({ state: 'done', review: 'Checked the discount.' })
    expect((await relay.events('review_rejected')).map(e => e.text)).toEqual(['The total ignores the discount.'])
    expect(await relay.events('review_accepted')).toHaveLength(1)
  })

  test('only the reviewer reviews, and a review asked by another session is not delivered', async () => {
    await start(
      'rev',
      'claude',
      [
        { ...author, tool: 'claude' },
        { account: 'acc_eve', session: 'eve', tool: 'claude' },
      ],
      null,
    )
    await relay.otherTask(
      't1',
      { ...big('Checkout'), state: 'review', assignee: author, reviewer: { account: 'acc_eve', session: 'eve' } },
      author,
    )
    expect(await call('review_accept', { task: 't1' })).toContain('not the reviewer')
    // Eve's Claude cannot make this session review a task it did not write.
    await relay.otherTask('t2', { ...big('Search'), state: 'review', assignee: author, reviewer }, { account: 'acc_eve', session: 'eve' })
    await settle()
    expect(delivered.some(d => d.startsWith('<pool kind="review"') && d.includes('t2'))).toBe(false)
  })

  test('the author gets the task back with the notes, and the orchestrator hears of it', async () => {
    await start('author', 'claude', [{ ...reviewer, area: 'review', tool: 'claude' }], null)
    await relay.otherTask('t1', { ...big('Checkout'), state: 'review', assignee: author, reviewer, branch: 'pool/t1-checkout' }, author)
    await relay.otherTask(
      't1',
      {
        ...big('Checkout'),
        state: 'assigned',
        assignee: author,
        reviewer,
        branch: 'pool/t1-checkout',
        review: 'The total ignores the discount.',
      },
      reviewer,
    )
    await settle()
    const back = delivered.find(d => d.startsWith('<pool kind="task"') && d.includes('Sent back by review'))
    expect(back).toContain('The total ignores the discount.')

    await start(
      'lead',
      'claude',
      [
        { ...author, tool: 'claude' },
        { ...reviewer, area: 'review', tool: 'claude' },
      ],
      { account: 'acc_lead', session: 'lead' },
    )
    await relay.otherTask('t1', { ...big('Checkout'), state: 'in_progress', assignee: author }, author)
    await relay.otherTask('t1', { ...big('Checkout'), state: 'review', assignee: author, reviewer }, author)
    await relay.otherTask(
      't1',
      { ...big('Checkout'), state: 'assigned', assignee: author, reviewer, review: 'The total ignores the discount.' },
      reviewer,
    )
    await settle()
    expect(delivered.some(d => d.includes('in review with rev'))).toBe(true)
    expect(delivered.some(d => d.includes('Review sent task t1') && d.includes('discount'))).toBe(true)
    expect(await call('review_assign', { task: 't1', session: 'rev' })).toContain('not in review')
  })
})
