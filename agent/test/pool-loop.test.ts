// The pool's control loop (docs/pool-autopilot.md) on a pool kept in memory: what it hands to which machine, one change
// at a time, what it gives back and when, and when it stops. The relay and the machines' services are tested elsewhere
// (agent/test/pool-worker.test.ts, test/pool-autopilot.test.ts); here each rule shows on its own.
import { describe, expect, test } from 'bun:test'
import type { PoolMachine, PoolPostItem, PoolState, PoolTaskItem } from '../../shared/pool'
import type { PoolDispatch, PoolEventBody, PoolMachineProfile, PoolTask } from '../../shared/pool-protocol'
import { DispatchLoop, machineCandidates, whyNoMachine } from '../src/service/pool-loop'
import type { MachinePools } from '../src/service/pool-machines'

const ADMIN = 'adminaccount'
const LEAD = 'machinelead1'
const T0 = Date.parse('2026-10-28T10:00:00Z')

const machine = (id: string, profile: Partial<PoolMachineProfile>, fields: Partial<PoolMachine> = {}): PoolMachine => ({
  account: fields.account ?? 'memberacct01',
  machine: id,
  addedAt: fields.addedAt ?? `2026-10-28T09:0${id.length % 10}:00Z`,
  online: true,
  ready: true,
  profile: { tool: 'claude', capacity: 1, workdir: '~/pool', mode: 'edits', ...profile },
  ...fields,
})

const item = (id: string, task: PoolTask, updatedAt = new Date(T0).toISOString()): PoolTaskItem => ({
  id,
  rev: 1,
  updatedAt,
  account: ADMIN,
  session: null,
  task,
})

function pool(machines: PoolMachine[], tasks: PoolTaskItem[], fields: Partial<PoolState> = {}): PoolState {
  return {
    id: 'pool00000001',
    createdAt: '2026-10-28T09:00:00Z',
    paused: false,
    keyVersion: 1,
    info: { name: 'Hack', repo: 'https://example.com/shop.git' },
    members: [{ account: 'memberacct01', role: 'member', joinedAt: 'x', profile: { name: 'Bob' }, publicKeys: [] }],
    sessions: [],
    tasks,
    notes: null,
    messages: [],
    events: [],
    own: { secret: null, wraps: [] },
    rules: null,
    budgets: null,
    audit: [],
    orchestrator: null,
    machines: [machine(LEAD, { name: 'Lead', takes: 'simple', capacity: 1 }, { account: ADMIN }), ...machines],
    orchestratorMachine: { account: ADMIN, machine: LEAD },
    dispatch: { rev: 1, updatedAt: 'x', account: ADMIN, session: null, value: { on: true } },
    ...fields,
  }
}

/** The orchestrator machine's view of the pool, in memory: what the loop writes lands in it, as the relay would echo it. */
function fakePools(initial: PoolState, now: () => number) {
  let state = initial
  const events: PoolEventBody[] = []
  const pools = {
    machineId: LEAD,
    ids: () => [state.id],
    state: () => state,
    account: () => ADMIN,
    putTask: async (_poolId: string, at: Pick<PoolTaskItem, 'id' | 'rev'>, next: PoolTask) => {
      const current = state.tasks.find(t => t.id === at.id)
      if (current?.rev !== at.rev) return 'The task changed meanwhile.'
      const updated: PoolTaskItem = { ...current, rev: at.rev + 1, updatedAt: new Date(now()).toISOString(), machine: LEAD, task: next }
      state = { ...state, tasks: state.tasks.map(t => (t.id === at.id ? updated : t)) }
      return null
    },
    putDispatch: async (_poolId: string, dispatch: PoolDispatch) => {
      state = {
        ...state,
        dispatch: { rev: (state.dispatch?.rev ?? 0) + 1, updatedAt: 'y', account: ADMIN, session: null, value: dispatch },
      }
      return null
    },
    event: async (_poolId: string, kind: string, taskId: string | undefined, text: string) => {
      events.push({ kind, ...(taskId ? { taskId } : {}), text })
    },
  }
  return {
    pools: pools as unknown as MachinePools,
    events,
    get: () => state,
    set: (next: Partial<PoolState>) => {
      state = { ...state, ...next }
    },
  }
}

async function look(fake: ReturnType<typeof fakePools>, loop: DispatchLoop) {
  loop.changed(fake.get().id)
  await loop.settled(fake.get().id)
}

const big = (title: string, fields: Partial<PoolTask> = {}): PoolTask => ({ title, state: 'todo', criteria: ['a', 'b'], ...fields })

describe('which machine takes a task', () => {
  const claude = machine('machineclau1', { tool: 'claude', capacity: 2, areas: ['back'] })
  const opencode = machine('machineopen1', { tool: 'opencode', capacity: 1 })
  const front = machine('machinefron1', { tool: 'claude', capacity: 1, areas: ['front'] })

  test('large to Claude Code, never to a machine that takes simple ones; simple to OpenCode first', () => {
    const state = pool([claude, opencode, front], [])
    expect(machineCandidates(state, { size: 'large' }).map(m => m.machine)).toEqual(['machineclau1', 'machinefron1'])
    expect(machineCandidates(state, { size: 'simple' })[0].machine).toBe('machineopen1')
    // The task's area first, among those of the right kind.
    expect(machineCandidates(state, { size: 'large', area: 'front' })[0].machine).toBe('machinefron1')
  })

  test('only machines online, ready, with a free slot, within budget and with time left on their plan', () => {
    const busy = item('task0001busy', big('Busy', { state: 'in_progress', machine: { account: 'memberacct01', machine: 'machinefron1' } }))
    const state = pool([machine('machineoffl1', {}, { online: false }), machine('machineold01', {}, { ready: false }), front], [busy])
    expect(machineCandidates(state, { size: 'large' })).toEqual([])
    expect(whyNoMachine(state, { size: 'large' })).toBe('every machine that takes it is busy')
    const spent = pool([claude], [], {
      budgets: { rev: 1, updatedAt: 'x', account: ADMIN, session: null, value: { member: { costUSD: 1 } } },
      events: [{ id: 'e1', seq: 1, ts: 'x', account: 'memberacct01', session: 'ses_1', body: { kind: 'spend', costUSD: 2, seconds: 60 } }],
    })
    expect(machineCandidates(spent, { size: 'large' })).toEqual([])
    const resetsAt = new Date(Date.now() + 4 * 3_600_000).toISOString()
    const limits: PoolPostItem<PoolEventBody> = {
      id: 'e2',
      seq: 2,
      ts: 'x',
      account: 'memberacct01',
      session: 'ses_1',
      body: { kind: 'limits', limits: { fiveHour: { usedPercent: 100, resetsAt } } },
    }
    expect(machineCandidates(pool([claude], [], { events: [limits] }), { size: 'large' })).toEqual([])
    expect(whyNoMachine(pool([opencode], []), { size: 'large' })).toBe('every machine of the pool takes simple tasks only')
    expect(whyNoMachine(pool([{ ...claude, online: false }], []), { size: 'large' })).toBe(
      'no machine that takes it is online with an agent that runs pool machines',
    )
    expect(whyNoMachine(spent, { size: 'large' })).toBe("this member's budget of $1 is spent")
    expect(whyNoMachine(pool([], [], { machines: [] }), {})).toBe('the pool has no machines')
  })
})

describe('the control loop', () => {
  const worker = machine('machinework1', { name: 'Linux', tool: 'claude', capacity: 1 })

  test('hands out the tasks to do that wait for nothing, one change at a time, and says why the others wait', async () => {
    let now = T0
    const tasks = [
      item('task0001api', big('API', { size: 'large' })),
      item('task0002ui', big('UI', { size: 'large', dependsOn: ['task0001api'] })),
      item('task0003db', big('Database', { size: 'large' })),
    ]
    const fake = fakePools(pool([worker], tasks), () => now)
    const loop = new DispatchLoop(fake.pools, { now: () => now })
    await look(fake, loop)
    const dispatched = fake.get().tasks.find(t => t.id === 'task0001api')?.task
    expect(dispatched).toMatchObject({ state: 'assigned', machine: { account: 'memberacct01', machine: 'machinework1' } })
    // The UI waits for the API; the database for a free machine: the lead machine only takes simple tasks.
    expect(fake.get().tasks.find(t => t.id === 'task0003db')?.task?.state).toBe('todo')
    expect(fake.events.map(e => e.kind)).toEqual(['dispatched', 'dispatch_waiting'])
    expect(fake.events[0].text).toBe('Dispatched task0001api (API) to Linux.')
    expect(fake.events[1].text).toContain('task0003db')
    // Said once: the next look, with nothing new, says nothing.
    now += 1000
    await look(fake, loop)
    expect(fake.events).toHaveLength(2)
    loop.stop()
  })

  test('does nothing unless its machine is the orchestrator machine, the dispatch is on and the pool runs', async () => {
    for (const fields of [
      { orchestratorMachine: { account: ADMIN, machine: 'machineothr1' } },
      { dispatch: null },
      { dispatch: { rev: 2, updatedAt: 'x', account: ADMIN, session: null, value: { on: false } } },
      { paused: true },
    ] as Partial<PoolState>[]) {
      const fake = fakePools(pool([worker], [item('task0001api', big('API'))], fields), () => T0)
      const loop = new DispatchLoop(fake.pools, { now: () => T0 })
      await look(fake, loop)
      expect(fake.get().tasks[0].task?.state).toBe('todo')
      expect(fake.events).toEqual([])
      loop.stop()
    }
  })

  test('gives back a task whose machine went offline, after a while; three times at most, then it is blocked', async () => {
    let now = T0
    const held = item('task0001api', big('API', { state: 'in_progress', machine: { account: 'memberacct01', machine: 'machinework1' } }))
    const fake = fakePools(pool([{ ...worker, online: false }], [held]), () => now)
    const loop = new DispatchLoop(fake.pools, { now: () => now })
    await look(fake, loop)
    now += 60_000
    await look(fake, loop)
    expect(fake.get().tasks[0].task?.state).toBe('in_progress')
    now += 2 * 60_000
    await look(fake, loop)
    expect(fake.get().tasks[0].task).toMatchObject({ state: 'todo', attempts: 1, summary: 'Linux went offline.' })
    expect(fake.events.find(e => e.kind === 'retried')?.text).toBe(
      'task0001api (API) went back to the board: Linux went offline. Attempt 2 of 3 next.',
    )
    expect(fake.get().tasks[0].task?.machine).toBeUndefined()

    // Two failures before: this one blocks it, for the orchestrator.
    const again = item(
      'task0002ui',
      big('UI', { state: 'assigned', attempts: 2, machine: { account: 'memberacct01', machine: 'machinegone' } }),
    )
    const gone = fakePools(pool([worker], [again]), () => now)
    await look(gone, new DispatchLoop(gone.pools, { now: () => now }))
    expect(gone.get().tasks[0].task).toMatchObject({ state: 'blocked', attempts: 3, summary: 'Its machine left the pool.' })
    expect(gone.events[0]).toMatchObject({ kind: 'blocked', text: 'task0002ui (UI) failed 3 times: its machine left the pool.' })
    loop.stop()
  })

  test('a task whose session works on stays, however long since the task last changed', async () => {
    let now = T0 + 60 * 60_000
    const on = { account: 'memberacct01', machine: 'machinework1' }
    const assignee = { account: 'memberacct01', session: 'ses_busy' }
    const session = (status: 'working' | 'idle') => ({
      account: 'memberacct01',
      session: 'ses_busy',
      joinedAt: 'x',
      profile: null,
      online: true,
      ready: true,
      status,
      accepted: 0,
    })
    const fake = fakePools(
      pool([worker], [item('task0001api', big('API', { state: 'in_progress', machine: on, assignee }))], {
        sessions: [session('working')],
      }),
      () => now,
    )
    const loop = new DispatchLoop(fake.pools, { now: () => now })
    await look(fake, loop)
    expect(fake.get().tasks[0].task?.state).toBe('in_progress')
    // It goes idle: only after 30 minutes of that does the task go back.
    fake.set({ sessions: [session('idle')] })
    await look(fake, loop)
    now += 20 * 60_000
    await look(fake, loop)
    expect(fake.get().tasks[0].task?.state).toBe('in_progress')
    now += 15 * 60_000
    await look(fake, loop)
    expect(fake.get().tasks[0].task?.summary).toBe('It has not moved for 30 minutes on Linux.')
    loop.stop()
  })

  test('gives back a task its machine never started, whose session ended, or that stopped moving', async () => {
    const now = T0 + 40 * 60_000
    const on = { account: 'memberacct01', machine: 'machinework1' }
    const cases: [PoolTask, string][] = [
      [big('A', { state: 'assigned', machine: on }), 'Linux did not start it.'],
      [
        big('B', { state: 'in_progress', machine: on, assignee: { account: 'memberacct01', session: 'ses_gone' } }),
        'Its session on Linux ended.',
      ],
      [big('C', { state: 'in_progress', machine: on }), 'It has not moved for 30 minutes on Linux.'],
    ]
    for (const [task, why] of cases) {
      const fake = fakePools(
        pool([{ ...worker, profile: { ...(worker.profile as PoolMachineProfile), capacity: 5 } }], [item('task0001xyz', task)]),
        () => now,
      )
      await look(fake, new DispatchLoop(fake.pools, { now: () => now }))
      expect(fake.get().tasks[0].task?.summary).toBe(why)
    }
    // A task that just moved is left alone.
    const fresh = fakePools(pool([worker], [item('task0001xyz', cases[0][0], new Date(now - 60_000).toISOString())]), () => now)
    await look(fresh, new DispatchLoop(fresh.pools, { now: () => now }))
    expect(fresh.get().tasks[0].task?.state).toBe('assigned')
  })

  test('a stopped machine gets nothing, and what it held goes elsewhere as it was, uncounted', async () => {
    const stopped = { ...worker, stopped: true }
    expect(machineCandidates(pool([stopped], []), { size: 'large' })).toEqual([])
    expect(whyNoMachine(pool([stopped], []), { size: 'large' })).toBe('every machine that takes it is stopped')
    const on = { account: 'memberacct01', machine: 'machinework1' }
    const held = item('task0001api', big('API', { state: 'in_progress', machine: on, attempts: 1 }))
    const fake = fakePools(pool([stopped], [held]), () => T0)
    await look(fake, new DispatchLoop(fake.pools, { now: () => T0 }))
    expect(fake.get().tasks[0].task).toMatchObject({ state: 'todo', attempts: 1, summary: 'Linux was stopped.' })
    expect(fake.events[0]).toEqual({
      kind: 'retried',
      taskId: 'task0001api',
      text: 'task0001api (API) went back to the board: Linux was stopped.',
    })
  })

  test('when every task is done it says so, with what waits to be merged, and stops the dispatch', async () => {
    const done = [
      item('task0001api', big('API', { state: 'done', branch: 'pool/task0001api' })),
      item('task0002ui', big('UI', { state: 'done', branch: 'pool/task0002ui', merge: { state: 'merged' } as PoolTask['merge'] })),
    ]
    const fake = fakePools(pool([worker], done), () => T0)
    await look(fake, new DispatchLoop(fake.pools, { now: () => T0 }))
    expect(fake.get().dispatch?.value).toEqual({ on: false, note: 'Every task is done.' })
    expect(fake.events).toEqual([
      { kind: 'dispatch_done', text: 'Every task is done: the dispatch stopped. 1 finished branch waits to be merged (task_merge).' },
    ])
  })
})
