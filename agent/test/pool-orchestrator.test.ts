import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { newAccountKey } from '../../shared/crypto'
import { newPoolKey, type PoolSession, type PoolState, PoolVault, sealPoolSessionOrder } from '../../shared/pool'
import type {
  PoolInfo,
  PoolNotes,
  PoolPostWire,
  PoolSessionRef,
  PoolSnapshot,
  PoolTask,
  PoolTaskWire,
  PoolUpdate,
} from '../../shared/pool-protocol'
import type { AgentMessage } from '../../shared/protocol'
import {
  branchFor,
  candidates,
  HACKATHON_GUIDE,
  ORCHESTRATOR_GUIDE,
  ORCHESTRATOR_TOOLS,
  overlapping,
  parseArea,
  refusal,
  tooSmall,
} from '../src/channel/pool-orchestrator'
import { POOL_TOOLS, PoolWork } from '../src/channel/pool-work'
import { SessionPools } from '../src/channel/pools'

const ME = 'ses_lead'
const POOL = 'pool12345678'
const accountKey = newAccountKey()
const poolKey = newPoolKey()
const vault = new PoolVault(poolKey)

const SESSIONS = [
  { account: 'acc_me', session: ME, area: undefined, tool: 'claude' },
  { account: 'acc_bob', session: 'ses_oc', area: 'front', tool: 'opencode' },
  { account: 'acc_ana', session: 'ses_cc', area: 'back', tool: 'claude' },
  { account: 'acc_eve', session: 'ses_eve', area: 'back', tool: 'claude', takes: 'simple' as const },
]

/** A relay that answers like the real one: revisions, conflicts, and every post sent back to the members. */
class FakeRelay {
  tasks = new Map<string, PoolTaskWire>()
  notesRev = 0
  seq = 10
  posts: AgentMessage[] = []
  pools!: SessionPools
  snapshot!: PoolSnapshot

  handle = async (message: AgentMessage) => {
    this.posts.push(message)
    const update = this.answer(message)
    if (update) this.pools.apply(update)
  }

  private answer(message: AgentMessage): PoolUpdate | null {
    const author = { account: 'acc_me', session: 'sessionId' in message ? message.sessionId : null }
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
      case 'pool_notes':
        if (message.rev !== this.notesRev) return { t: 'pool_conflict', poolId: POOL, kind: 'notes', current: null }
        this.notesRev++
        return { t: 'pool_notes', poolId: POOL, notes: { rev: this.notesRev, updatedAt: 'now', blob: message.blob, ...author } }
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
  async otherTask(
    id: string,
    task: PoolTask,
    by: PoolSessionRef | { account: string; session: null },
    updatedAt = new Date().toISOString(),
  ) {
    const wire: PoolTaskWire = { id, rev: (this.tasks.get(id)?.rev ?? 0) + 1, updatedAt, blob: await vault.seal(task), ...by }
    this.tasks.set(id, wire)
    this.pools.apply({ t: 'pool_task', poolId: POOL, task: wire })
  }

  async otherNotes(notes: PoolNotes) {
    this.notesRev++
    const update: PoolUpdate = {
      t: 'pool_notes',
      poolId: POOL,
      notes: { rev: this.notesRev, updatedAt: 'now', blob: await vault.seal(notes), account: 'acc_ana', session: 'ses_cc' },
    }
    this.pools.apply(update)
  }

  read = async (id: string) => vault.read(this.tasks.get(id)?.blob, value => value as PoolTask)
}

let relay: FakeRelay
let pools: SessionPools
let work: PoolWork
let delivered: string[]
let toolsChanged: number

async function join(
  orchestrator: PoolSessionRef | null = { account: 'acc_me', session: ME },
  notes?: PoolNotes,
  info: PoolInfo = { name: 'Hackathon', goal: 'Ship the app' },
) {
  if (notes) relay.notesRev = 1
  relay.snapshot = {
    id: POOL,
    createdAt: 'then',
    paused: false,
    keyVersion: 1,
    info: await vault.seal(info),
    members: await Promise.all(
      [
        ['acc_me', 'owner', 'Me'],
        ['acc_bob', 'member', 'Bob'],
        ['acc_ana', 'member', 'Ana'],
        ['acc_eve', 'member', 'Eve'],
      ].map(async ([account, role, name]) => ({
        account,
        role: role as 'owner' | 'member',
        joinedAt: 'then',
        profile: await vault.seal({ name }),
        publicKeys: [],
      })),
    ),
    sessions: await Promise.all(
      SESSIONS.map(async (s, i) => ({
        account: s.account,
        session: s.session,
        joinedAt: `2026-10-27T10:0${i}:00Z`,
        profile: await vault.seal({
          ...(s.area ? { area: s.area } : {}),
          tool: s.tool as 'claude',
          ...(s.takes ? { takes: s.takes } : {}),
        }),
        online: true,
        ready: true,
      })),
    ),
    tasks: [],
    notes: notes ? { rev: 1, updatedAt: 'then', blob: await vault.seal(notes), account: 'acc_ana', session: 'ses_cc' } : null,
    messages: [],
    events: await Promise.all(
      SESSIONS.slice(1).map(async (s, i) => ({
        id: `e${i}`,
        seq: i + 1,
        ts: 'then',
        blob: await vault.seal({ kind: 'session', tool: s.tool as 'claude', model: s.tool === 'opencode' ? 'gpt-5' : 'claude-opus-5-5' }),
        account: s.account,
        session: s.session,
      })),
    ),
    orchestrator,
  }
  pools.receive(POOL, await sealPoolSessionOrder(accountKey, { poolId: POOL, sessionId: ME, key: poolKey, version: 1, autoStart: true }))
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

beforeEach(() => {
  relay = new FakeRelay()
  let outbox = Promise.resolve()
  const post = (build: () => Promise<AgentMessage | null>) => {
    outbox = outbox.then(async () => {
      const message = await build()
      if (message) await relay.handle(message)
    })
  }
  pools = new SessionPools(() => ME, accountKey, post)
  relay.pools = pools
  delivered = []
  toolsChanged = 0
  work = new PoolWork(
    pools,
    () => ME,
    post,
    text => delivered.push(text),
    () => ({ tool: 'claude', model: 'claude-opus-5-5' }),
    () => toolsChanged++,
    60_000,
  )
})

describe('the rules', () => {
  const session = (s: (typeof SESSIONS)[number], i: number): PoolSession => ({
    account: s.account,
    session: s.session,
    joinedAt: `t${i}`,
    profile: { area: s.area, tool: s.tool as 'claude', ...(s.takes ? { takes: s.takes } : {}) },
    online: true,
    ready: true,
    status: null,
    accepted: 0,
  })
  const state = (tasks: PoolState['tasks'] = []): PoolState => ({
    id: POOL,
    createdAt: 'then',
    paused: false,
    keyVersion: 1,
    info: null,
    members: [],
    sessions: SESSIONS.map(session),
    tasks,
    notes: null,
    messages: [],
    events: [],
    own: { secret: null, wraps: [] },
    orchestrator: { account: 'acc_me', session: ME },
    rules: null,
    budgets: null,
    audit: [],
  })
  const none = new Map()

  test("a session past its member's or the pool's budget gets no task, even forced", () => {
    // Ana's sessions spent $6 of a $5 cap; the pool has no cap.
    const spent = {
      ...state(),
      budgets: { account: 'acc_me', session: null, rev: 1, updatedAt: 'now', value: { member: { costUSD: 5 } } },
      events: [{ account: 'acc_ana', session: 'ses_cc', id: 'e1', seq: 1, ts: 'now', body: { kind: 'spend', costUSD: 6, seconds: 60 } }],
    } as PoolState
    expect(candidates(spent, { size: 'large' }, none)).toEqual([])
    expect(candidates(spent, { size: 'simple' }, none).map(c => c.session.session)).toEqual(['ses_oc', 'ses_eve'])
    expect(refusal(spent, { title: 'API', state: 'todo' }, spent.sessions[2], none)).toBeNull()
  })

  test('a simple task goes to OpenCode first, a large one to Claude Code, never to the orchestrator', () => {
    expect(candidates(state(), { size: 'simple' }, none).map(c => c.session.session)).toEqual(['ses_oc', 'ses_eve', 'ses_cc'])
    // Eve's owner made it take simple tasks only: it gets no large one.
    expect(candidates(state(), { size: 'large' }, none).map(c => c.session.session)).toEqual(['ses_cc'])
    // In its area first, among those that fit.
    expect(candidates(state(), { size: 'simple', area: 'back' }, none)[0].session.session).toBe('ses_eve')
  })

  test('one task per session: a busy session is not a candidate, and is refused by name', () => {
    const busy = state([
      {
        id: 't1',
        rev: 1,
        updatedAt: 'now',
        account: 'x',
        session: null,
        task: { title: 'x', state: 'in_progress', assignee: { account: 'acc_ana', session: 'ses_cc' } },
      },
    ])
    expect(candidates(busy, { size: 'large' }, none)).toEqual([])
    const cc = busy.sessions.find(s => s.session === 'ses_cc') as PoolSession
    expect(refusal(busy, { title: 'y', state: 'todo' }, cc, none)).toContain('one task at a time')
    const lead = busy.sessions.find(s => s.session === ME) as PoolSession
    expect(refusal(busy, { title: 'y', state: 'todo' }, lead, none)).toContain('orchestrator')
  })

  test('tiny tasks are refused, branches and areas have their shape, overlapping paths are found', () => {
    expect(tooSmall({ goal: 'fix', criteria: ['done'] })).toContain('Too small')
    expect(tooSmall({ goal: 'fix the typo', criteria: [] })).toContain('criteria')
    expect(tooSmall({ goal: 'A whole login flow: form, API call, errors, session cookie', criteria: ['works'] })).toBeNull()
    expect(branchFor('Ab_9xYz12', 'Login page & API!')).toBe('pool/ab9xyz-login-page-api')
    expect(parseArea('front: web/, app/ui')).toEqual({ name: 'front', paths: ['web/', 'app/ui'] })
    const s = state([
      { id: 't1', rev: 1, updatedAt: 'now', account: 'x', session: null, task: { title: 'x', state: 'in_progress', paths: ['web/'] } },
    ])
    expect(overlapping(s, 't2', ['web/login']).map(t => t.id)).toEqual(['t1'])
    expect(overlapping(s, 't2', ['api/'])).toEqual([])
  })
})

describe('the orchestrator', () => {
  test('only the orchestrator gets and answers the planning tools; it is told its role once', async () => {
    await join(null)
    expect(work.tools()).toEqual(POOL_TOOLS)
    expect(await call('task_create', big('Login'))).toContain("Only the pool's orchestrator")
    // An admin makes this session the orchestrator.
    pools.apply({ t: 'pool_orchestrator', poolId: POOL, orchestrator: { account: 'acc_me', session: ME } })
    await settle()
    expect(work.tools().map(t => t.name)).toEqual([...POOL_TOOLS, ...ORCHESTRATOR_TOOLS].map(t => t.name))
    expect(toolsChanged).toBe(2)
    const role = delivered.filter(d => d.startsWith('<pool kind="role" from="Tonton"'))
    expect(role).toHaveLength(1)
    expect(role[0]).toContain('Never single steps')
    pools.apply({ t: 'pool_info', poolId: POOL, info: await vault.seal({ name: 'Hackathon' }), paused: false, keyVersion: 1 })
    await settle()
    expect(delivered.filter(d => d.startsWith('<pool kind="role"'))).toHaveLength(1)
  })

  test('the guide in the docs is the one the agent sends', () => {
    const doc = readFileSync(joinPath(import.meta.dir, '../../docs/pool-orchestrator.md'), 'utf8')
    expect(doc).toContain(ORCHESTRATOR_GUIDE)
    expect(doc).toContain(HACKATHON_GUIDE)
  })

  test('plan_create writes the contracts and the areas in the notes', async () => {
    await join()
    expect(await call('plan_create', { goal: 'A shop' })).toContain('contracts')
    expect(
      await call('plan_create', {
        goal: 'A shop',
        contracts: 'GET /v1/items',
        stack: 'Bun, React',
        areas: ['front: web/', 'back: api/, db/'],
      }),
    ).toContain('The plan is in the notes')
    const notes = JSON.parse(await call('pool_notes_read'))
    expect(notes).toMatchObject({ rev: 1, goal: 'A shop', contracts: 'GET /v1/items', stack: 'Bun, React' })
    expect(notes.areas).toEqual([
      { name: 'front', paths: ['web/'] },
      { name: 'back', paths: ['api/', 'db/'] },
    ])
    expect(JSON.parse(await call('pool_notes_read', { section: 'contracts' }))).toEqual({ rev: 1, contracts: 'GET /v1/items' })
    // Its own notes are not told back to it.
    expect(delivered.filter(d => d.includes('kind="notes"'))).toEqual([])
  })

  test('tasks: OpenCode gets the simple one, Claude Code the large one, each on its own branch, with its area paths', async () => {
    await join()
    await call('plan_create', { goal: 'A shop', contracts: 'GET /v1/items', areas: ['front: web/', 'back: api/'] })
    expect(await call('task_create', { title: 'Fix', goal: 'fix', criteria: ['ok'] })).toContain('Too small')

    const small = await call(
      'task_create',
      big('Item list page', { area: 'front', size: 'simple' }) as Record<string, unknown> & { assign?: string },
    )
    expect(small).toContain('Assign it')
    const smallId = [...relay.tasks.keys()][0]
    expect(await relay.read(smallId)).toMatchObject({ state: 'todo', size: 'simple', paths: ['web/'] })
    expect((await relay.read(smallId))?.branch).toStartWith(
      `pool/${smallId
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 6)
        .toLowerCase()}-item-list-page`,
    )
    expect(await call('task_assign', { task: smallId })).toBe('Assigned to Bob · front (ses_oc).')

    expect(await call('task_create', { ...big('Items API', { area: 'back' }), assign: 'auto' })).toContain(
      'Assigned to Ana · back (ses_cc).',
    )
    const largeId = [...relay.tasks.keys()][1]
    expect(await relay.read(largeId)).toMatchObject({ state: 'assigned', assignee: { session: 'ses_cc' }, size: 'large' })

    // Eve takes simple tasks only, Ana is busy: nobody free takes a large task.
    expect(await call('task_create', { ...big('Checkout'), assign: 'auto' })).toContain('No free session takes a large task')
    const checkout = [...relay.tasks.keys()][2]
    expect(await call('task_assign', { task: checkout, session: 'ses_eve' })).toContain('takes simple tasks only')
    expect(await call('task_assign', { task: checkout, session: 'ses_eve', force: true })).toBe('Assigned to Eve · back (ses_eve).')
    expect(relay.posts.filter(p => p.t === 'pool_event').length).toBeGreaterThanOrEqual(6)
  })

  test("the orchestrator can set the tier a task needs over its machine's assessment, and nothing else", async () => {
    await join()
    expect(await call('task_create', { ...big('Session store'), model: 'huge' })).toBe('model is light, balanced or strong.')
    await call('task_create', { ...big('Session store'), model: 'strong' })
    const id = [...relay.tasks.keys()][0]
    expect(await relay.read(id)).toMatchObject({ title: 'Session store', model: 'strong' })
  })

  test('a task that waits is not handed out until what it waits for is done', async () => {
    await join()
    await call('task_create', big('Schema'))
    const schema = [...relay.tasks.keys()][0]
    await call('task_create', big('API', { dependsOn: undefined }))
    expect(await call('task_create', { ...big('Screens'), depends_on: ['nope'] })).toContain('No such task to wait for')
    await call('task_create', { ...big('Screens'), depends_on: [schema] })
    const screens = [...relay.tasks.keys()][2]
    expect(await call('task_assign', { task: screens })).toContain(`It waits for ${schema}`)
    await relay.otherTask(
      schema,
      { ...big('Schema'), state: 'done', assignee: { account: 'acc_ana', session: 'ses_cc' } },
      { account: 'acc_ana', session: 'ses_cc' },
    )
    await settle()
    expect(await call('task_assign', { task: screens })).toStartWith('Assigned to Ana · back')
  })

  test('task_reassign moves the task and tells the first session to stop', async () => {
    await join()
    await call('task_create', { ...big('Items API'), assign: 'ses_cc' })
    const id = [...relay.tasks.keys()][0]
    expect(await call('task_reassign', { task: id, session: 'ses_oc', reason: 'Ana is out of time' })).toContain('takes simple tasks only')
    await call('task_create', big('Other'))
    expect(await call('task_reassign', { task: id, reason: 'Ana is out of time' })).toContain('No free session takes a large task')
    // Bob's owner lets it take large tasks.
    const sessions = pools.state(POOL)?.sessions ?? []
    const bob = sessions.find(s => s.session === 'ses_oc') as PoolSession
    pools.apply({
      t: 'pool_session',
      poolId: POOL,
      session: { ...bob, status: bob.status ?? undefined, profile: await vault.seal({ area: 'front', tool: 'opencode', takes: 'large' }) },
    })
    await settle()
    expect(await call('task_reassign', { task: id, reason: 'Ana is out of time' })).toBe('Assigned to Bob · front (ses_oc).')
    const told = relay.posts.filter(p => p.t === 'pool_message')
    expect(told).toHaveLength(1)
    const body = await vault.read((told[0] as { blob: string }).blob, value => value as { text: string; to: { session: PoolSessionRef } })
    expect(body?.to.session.session).toBe('ses_cc')
    expect(body?.text).toContain('Stop working on it')
  })

  test('it hears when to re-plan: blocked, done with what it frees, a session gone, a task that stalls', async () => {
    await join()
    await call('task_create', { ...big('Schema'), assign: 'ses_cc' })
    const schema = [...relay.tasks.keys()][0]
    await call('task_create', { ...big('Screens'), depends_on: [schema] })
    const screens = [...relay.tasks.keys()][1]
    const ana = { account: 'acc_ana', session: 'ses_cc' }
    await relay.otherTask(schema, { ...big('Schema'), state: 'blocked', summary: 'needs the DB choice', assignee: ana }, ana)
    await settle()
    expect(delivered.at(-1)).toContain('is blocked: needs the DB choice')
    expect(delivered.at(-1)).toStartWith('<pool kind="notice" from="Tonton"')
    await relay.otherTask(schema, { ...big('Schema'), state: 'done', summary: 'Postgres schema\n\nTests: bun test', assignee: ana }, ana)
    await settle()
    expect(delivered.at(-1)).toContain(`It frees ${screens} (Screens)`)

    await call('task_assign', { task: screens })
    const holder = (await relay.read(screens))?.assignee
    expect(holder?.session).toBe('ses_cc')
    await relay.otherTask(
      screens,
      { ...big('Screens'), state: 'in_progress', assignee: ana },
      ana,
      new Date(Date.now() - 2 * 60_000).toISOString(),
    )
    await settle()
    work.lookForStalls()
    expect(delivered.at(-1)).toContain('has not moved for 1 minutes')
    pools.apply({ t: 'pool_session_left', poolId: POOL, account: 'acc_ana', session: 'ses_cc' })
    await settle()
    expect(delivered.at(-1)).toContain('left the pool: reassign it')
    const count = delivered.length
    work.lookForStalls()
    expect(delivered.length).toBe(count)
  })
})

describe('a worker', () => {
  const lead = { account: 'acc_bob', session: 'ses_oc' }
  const mine = (title: string): PoolTask => ({
    ...big(title),
    state: 'assigned',
    assignee: { account: 'acc_me', session: ME },
    branch: 'pool/abc-x',
  })

  test('takes a task from the orchestrator or a person, never from another member’s Claude', async () => {
    await join(lead)
    await relay.otherTask('t1', mine('From another Claude'), { account: 'acc_ana', session: 'ses_cc' })
    await settle()
    expect(delivered.filter(d => d.includes('kind="task"'))).toEqual([])
    await relay.otherTask('t2', mine('From the orchestrator'), lead)
    await relay.otherTask('t3', mine('From a person'), { account: 'acc_ana', session: null })
    await settle()
    const tasks = delivered.filter(d => d.includes('kind="task"'))
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toContain('from="Bob · orchestrator"')
    expect(tasks[0]).toContain('git switch pool/abc-x')
    expect(tasks[0]).toContain('never on main')
  })

  test('finishing needs the branch and the tests', async () => {
    await join(lead)
    await relay.otherTask('t1', { ...mine('API'), branch: undefined }, lead)
    await settle()
    expect(await call('task_claim', { task: 't1' })).toStartWith('Started.')
    expect(await call('task_done', { task: 't1', summary: 'API done' })).toContain('which branch')
    expect(await call('task_done', { task: 't1', summary: 'API done', branch: 'pool/t1-api' })).toContain('which tests')
    expect(await call('task_done', { task: 't1', summary: 'API done', branch: 'pool/t1-api', tests: 'bun test' })).toBe(
      'Done: the pool sees it.',
    )
  })

  test('is told of the notes when it joins and when another session changes them, without their whole text', async () => {
    await join(lead, { text: '', sections: { goal: 'A shop', contracts: 'SECRET GET /v1/items' } })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toStartWith('<pool kind="notes" from="Tonton" rev="1">')
    expect(delivered[0]).toContain('goal, contracts')
    expect(delivered[0]).not.toContain('SECRET')
    await relay.otherNotes({
      text: '',
      sections: { goal: 'A shop', contracts: 'GET /v2/items' },
      areas: [{ name: 'front', paths: ['web/'] }],
    })
    await settle()
    expect(delivered.at(-1)).toContain('from="Ana · back" rev="2"')
    expect(delivered.at(-1)).toContain('The shared notes changed')
    // Writing one part keeps the others.
    expect(await call('pool_notes_write', { section: 'decisions', text: 'Postgres', rev: 2 })).toBe('The notes are saved.')
    const notes = JSON.parse(await call('pool_notes_read'))
    expect(notes).toMatchObject({ rev: 3, goal: 'A shop', contracts: 'GET /v2/items', decisions: 'Postgres' })
    expect(notes.areas).toEqual([{ name: 'front', paths: ['web/'] }])
    expect(await call('pool_notes_write', { section: 'nope', text: 'x', rev: 3 })).toContain('section is')
  })
})

describe('a hackathon', () => {
  const T0 = Date.now()
  const MIN = 60_000
  // Half time ten minutes from now, one hour left in an hour, fifteen minutes left an hour and 45 minutes from now.
  const hackathon = (deadline = new Date(T0 + 120 * MIN)): PoolInfo => ({
    name: 'Basel Hack',
    goal: 'Ship the app',
    template: 'hackathon',
    deadline: deadline.toISOString(),
    startedAt: new Date(T0 - 100 * MIN).toISOString(),
  })
  const notices = () => delivered.filter(d => d.startsWith('<pool kind="notice"'))
  const look = async (minutes: number) => {
    work.lookForStalls(T0 + minutes * MIN)
    await settle()
  }

  test('its orchestrator gets the hackathon guide with its own', async () => {
    await join(undefined, undefined, hackathon())
    const role = delivered.filter(d => d.startsWith('<pool kind="role"'))
    expect(role).toHaveLength(1)
    expect(role[0]).toContain('Never single steps')
    expect(role[0]).toContain(HACKATHON_GUIDE)
    expect(JSON.parse(await call('pool_overview'))).toMatchObject({
      deadline: hackathon().deadline,
      timeLeft: expect.stringContaining('left'),
    })
  })

  test('a deadline given later brings the hackathon guide on its own, once', async () => {
    await join()
    pools.apply({ t: 'pool_info', poolId: POOL, info: await vault.seal(hackathon()), paused: false, keyVersion: 1 })
    await settle()
    pools.apply({ t: 'pool_info', poolId: POOL, info: await vault.seal(hackathon()), paused: false, keyVersion: 1 })
    await settle()
    const role = delivered.filter(d => d.startsWith('<pool kind="role"'))
    expect(role).toHaveLength(2)
    expect(role[1]).toStartWith('<pool kind="role" from="Tonton" pool="Basel Hack">\nThis pool is a hackathon')
  })

  test('time notices come once each, and the final checklist once, near the end', async () => {
    await join(undefined, undefined, hackathon())
    expect(notices()).toEqual([])
    await look(11)
    await look(12)
    expect(notices()).toHaveLength(1)
    expect(notices()[0]).toContain('Half the time is gone')
    await look(61)
    expect(notices()[1]).toContain('Start no new feature')
    expect(relay.tasks.size).toBe(1)
    const checklist = [...relay.tasks.keys()][0]
    expect(await relay.read(checklist)).toMatchObject({ title: 'Final checklist', state: 'todo', size: 'simple' })
    expect(notices()[2]).toContain(`The final checklist is on the board as ${checklist}`)
    await look(106)
    expect(notices()[3]).toContain('freeze main')
    await look(107)
    expect(notices()).toHaveLength(4)
    // One checklist, though the quarter mark came after the hour.
    expect(relay.tasks.size).toBe(1)
  })

  test('marks already past when the agent first sees the deadline are not told late', async () => {
    // Half time and one hour left are both behind: only fifteen minutes left is still to come.
    await join(undefined, undefined, hackathon(new Date(T0 + 30 * MIN)))
    await look(1)
    expect(notices()).toEqual([])
    await look(16)
    expect(notices()[0]).toContain('freeze main')
    // The checklist comes at the first of the last two marks that is told.
    expect(notices()[1]).toContain('The final checklist is on the board')
    expect(notices()).toHaveLength(2)
    expect(relay.tasks.size).toBe(1)
  })

  test('a session that is not the orchestrator gets no time notice', async () => {
    await join({ account: 'acc_ana', session: 'ses_cc' }, undefined, hackathon())
    await look(61)
    expect(notices()).toEqual([])
    expect(relay.tasks.size).toBe(0)
  })
})
