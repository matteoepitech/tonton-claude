// The autopilot on the orchestrator's side (docs/pool-autopilot.md): dispatch_start and dispatch_stop, the machines in
// pool_overview, the control loop's events told to the orchestrator as notices, and no request to reassign what the
// loop gives back by itself. The guide it is told is the one in docs/pool-orchestrator.md.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolMachine, PoolPostItem, PoolSession, PoolState, PoolTaskItem } from '../../shared/pool'
import type { PoolDispatch, PoolEventBody, PoolTask } from '../../shared/pool-protocol'
import { AUTOPILOT_GUIDE } from '../src/channel/pool-dispatch'
import { type PoolOps, PoolOrchestrator, planPreview } from '../src/channel/pool-orchestrator'

const ADMIN = 'adminaccount'
const LEAD_MACHINE = 'machinelead1'
const lead: PoolSession = {
  account: ADMIN,
  session: 'ses_lead',
  joinedAt: 'x',
  profile: { tool: 'claude' },
  online: true,
  ready: true,
  status: null,
  accepted: 0,
  machine: LEAD_MACHINE,
}
const studio: PoolMachine = {
  account: 'memberacct01',
  machine: 'machinestud1',
  addedAt: 'x',
  online: true,
  ready: true,
  profile: { name: 'Studio', tool: 'claude', capacity: 2, workdir: '~/pool', mode: 'edits', areas: ['back'] },
}

function pool(fields: Partial<PoolState> = {}): PoolState {
  return {
    id: 'pool00000001',
    createdAt: 'x',
    paused: false,
    keyVersion: 1,
    info: { name: 'Shop' },
    members: [],
    sessions: [lead],
    tasks: [],
    notes: null,
    messages: [],
    events: [],
    own: { secret: null, wraps: [] },
    rules: null,
    budgets: null,
    audit: [],
    orchestrator: { account: ADMIN, session: 'ses_lead' },
    machines: [studio],
    orchestratorMachine: { account: ADMIN, machine: LEAD_MACHINE },
    dispatch: null,
    ...fields,
  }
}

function orchestrator() {
  const dispatches: { rev: number; dispatch: PoolDispatch }[] = []
  const notices: string[] = []
  const posted: PoolEventBody[] = []
  const ops: PoolOps = {
    putTask: async () => null,
    putNotes: async () => null,
    putDispatch: async (_pool, rev, dispatch) => {
      dispatches.push({ rev, dispatch })
      return null
    },
    message: async () => null,
    event: async (_pool, kind, taskId, text, extra) => {
      posted.push({ ...extra, kind, ...(taskId ? { taskId } : {}), ...(text ? { text } : {}) })
    },
    descriptions: () => new Map(),
    who: (_state, _account, session) => session ?? 'a member',
  }
  return { orchestrator: new PoolOrchestrator(ops, text => notices.push(text)), dispatches, notices, posted }
}

const event = (seq: number, body: PoolEventBody, author: Partial<PoolPostItem<PoolEventBody>> = {}): PoolPostItem<PoolEventBody> => ({
  id: `e${seq}`,
  seq,
  ts: 'x',
  account: ADMIN,
  session: null,
  machine: LEAD_MACHINE,
  body,
  ...author,
})

describe('starting and stopping the dispatch', () => {
  test('only the orchestrator, only with machines and an orchestrator machine, and only when it changes something', async () => {
    const { orchestrator: o, dispatches } = orchestrator()
    const call = (name: string, state: PoolState, args = {}) => o.call(name, state.id, state, lead, args)
    expect(await call('dispatch_start', pool({ machines: [] }))).toContain('no machines')
    expect(await call('dispatch_start', pool({ orchestratorMachine: null }))).toContain('No machine runs the control loop')
    expect(await call('dispatch_start', pool(), { note: ' Go ' })).toContain('The dispatch is on')
    expect(dispatches).toEqual([{ rev: 0, dispatch: { on: true, note: 'Go' } }])
    const on = pool({ dispatch: { rev: 1, updatedAt: 'x', account: ADMIN, session: 'ses_lead', value: { on: true } } })
    expect(await call('dispatch_start', on)).toBe('The dispatch is already on.')
    // Stopping works in a paused pool too.
    expect(await call('dispatch_stop', { ...on, paused: true })).toContain('The dispatch is off')
    expect(dispatches.at(-1)).toEqual({ rev: 1, dispatch: { on: false } })
    expect(await call('dispatch_start', { ...on, dispatch: null, paused: true })).toContain('paused')
    // Another session of the pool is not the orchestrator.
    const other = { ...lead, session: 'ses_other' }
    expect(await o.call('dispatch_start', 'pool00000001', pool(), other, {})).toContain("Only the pool's orchestrator")
  })

  test('pool_overview lists the machines, what each runs, and the dispatch', async () => {
    const { orchestrator: o } = orchestrator()
    const task: PoolTaskItem = {
      id: 'task0001api',
      rev: 2,
      updatedAt: 'x',
      account: ADMIN,
      session: null,
      task: { title: 'API', state: 'in_progress', machine: { account: 'memberacct01', machine: 'machinestud1' } },
    }
    const view = JSON.parse(await o.call('pool_overview', 'pool00000001', pool({ tasks: [task] }), lead, {}))
    expect(view.dispatch).toBe('off')
    expect(view.machines).toEqual([
      {
        machine: 'machinestud1',
        name: 'Studio',
        tool: 'claude',
        // Its plan was not known when it joined.
        plan: 'Claude Code',
        capacity: 2,
        mode: 'edits',
        areas: ['back'],
        online: true,
        ready: true,
        running: [{ id: 'task0001api', title: 'API', state: 'in_progress' }],
      },
    ])
  })
})

describe('the plan the orchestrator proposes', () => {
  const todo = (id: string, fields: Partial<PoolTask> = {}): PoolTaskItem => ({
    id,
    rev: 1,
    updatedAt: 'x',
    account: ADMIN,
    session: 'ses_lead',
    task: { title: id, state: 'todo', criteria: ['a', 'b'], ...fields },
  })
  const laptop: PoolMachine = {
    ...studio,
    machine: 'machinelapt1',
    profile: { ...studio.profile, name: 'Laptop', capacity: 1 },
  } as PoolMachine

  test('each task where the loop would start it now, slots taken one after the other; what waits starts later', () => {
    const state = pool({
      machines: [studio, laptop],
      tasks: [
        todo('task0001api'),
        todo('task0002web'),
        todo('task0003ops'),
        todo('task0004e2e', { dependsOn: ['task0001api'] }),
        todo('task0005more'),
      ],
    })
    expect(planPreview(state).tasks).toEqual([
      { id: 'task0001api', machine: { account: 'memberacct01', machine: 'machinestud1' } },
      { id: 'task0002web', machine: { account: 'memberacct01', machine: 'machinestud1' } },
      { id: 'task0003ops', machine: { account: 'memberacct01', machine: 'machinelapt1' } },
      // It waits for the API.
      { id: 'task0004e2e' },
      // Every slot is taken.
      { id: 'task0005more' },
    ])
  })

  test('plan_propose posts it for the user, never starts the dispatch, and says what to wait for', async () => {
    const { orchestrator: o, dispatches, posted } = orchestrator()
    const call = (state: PoolState, args = {}) => o.call('plan_propose', state.id, state, lead, args)
    expect(await call(pool({ tasks: [todo('task0001api')] }))).toContain('Give the plan')
    expect(await call(pool(), { summary: 'A shop.' })).toContain('no task to do')
    const on = { rev: 1, updatedAt: 'x', account: ADMIN, session: null, value: { on: true } }
    expect(await call(pool({ tasks: [todo('task0001api')], dispatch: on }), { summary: 'A shop.' })).toContain('already on')
    const answer = await call(pool({ tasks: [todo('task0001api'), todo('task0002web')] }), { summary: 'The API, then the shop.' })
    expect(answer).toContain('2 of 2 tasks start on 1 machine')
    expect(answer).toContain('Do not call dispatch_start')
    expect(posted).toEqual([
      {
        kind: 'plan_proposed',
        text: 'The API, then the shop.',
        proposal: {
          tasks: [
            { id: 'task0001api', machine: { account: 'memberacct01', machine: 'machinestud1' } },
            { id: 'task0002web', machine: { account: 'memberacct01', machine: 'machinestud1' } },
          ],
        },
      },
    ])
    expect(dispatches).toEqual([])
    expect(await call(pool({ tasks: [todo('task0001api')], machines: [] }), { summary: 'A shop.' })).toContain('no machines yet')
  })

  test('the orchestrator hears when an owner or an admin accepts it, not when anyone else says so', () => {
    const { orchestrator: o, notices } = orchestrator()
    const members: PoolState['members'] = [
      { account: ADMIN, role: 'owner', joinedAt: 'x', profile: { name: 'Ana' }, publicKeys: [] },
      { account: 'memberacct01', role: 'member', joinedAt: 'x', profile: { name: 'Bob' }, publicKeys: [] },
    ]
    const first = pool({ members })
    o.watch(first.id, first, lead)
    const accepted = pool({
      members,
      events: [
        event(1, { kind: 'plan_accepted' }, { machine: undefined, account: 'memberacct01' }),
        event(2, { kind: 'plan_accepted' }, { machine: undefined }),
      ],
    })
    o.watch(accepted.id, accepted, lead)
    expect(notices).toEqual(['a member accepted the plan: the dispatch is on, and the control loop hands out the tasks.'])
  })
})

describe("the control loop's notices", () => {
  test("its machine's loop events are told once, as they come; nobody else's", () => {
    const { orchestrator: o, notices } = orchestrator()
    const first = pool({ events: [event(1, { kind: 'dispatched', text: 'Dispatched old (Old) to Studio.' })] })
    o.watch(first.id, first, lead)
    // What came before it watched is not told late.
    expect(notices).toEqual([])
    const later = pool({
      events: [
        ...first.events,
        event(2, { kind: 'dispatched', text: 'Dispatched task0001api (API) to Studio.' }),
        event(3, { kind: 'dispatched', text: 'Forged by a member.' }, { account: 'memberacct01', machine: 'machinestud1' }),
        event(4, { kind: 'dispatched', text: 'From a session.' }, { machine: undefined, session: 'ses_x' }),
        event(5, { kind: 'task_moved', text: 'started on Studio' }),
        event(6, { kind: 'dispatch_done', text: 'Every task is done: the dispatch stopped.' }),
      ],
    })
    o.watch(later.id, later, lead)
    o.watch(later.id, later, lead)
    expect(notices).toEqual(['Dispatched task0001api (API) to Studio.', 'Every task is done: the dispatch stopped.'])
  })

  test('while the dispatch is on, a machine’s task that stalls or loses its session is the loop’s to give back', () => {
    const { orchestrator: o, notices } = orchestrator()
    const stalled = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    const held = (machine: boolean): PoolTaskItem => ({
      id: machine ? 'task0001mach' : 'task0002hand',
      rev: 1,
      updatedAt: stalled,
      account: ADMIN,
      session: null,
      task: {
        title: machine ? 'On a machine' : 'By hand',
        state: 'in_progress',
        assignee: { account: 'memberacct01', session: 'ses_gone' },
        ...(machine ? { machine: { account: 'memberacct01', machine: 'machinestud1' } } : {}),
      } as PoolTask,
    })
    const on = { rev: 1, updatedAt: 'x', account: ADMIN, session: null, value: { on: true } }
    const state = pool({ tasks: [held(true), held(false)], dispatch: on })
    o.watch(state.id, state, lead)
    o.watch(state.id, { ...state, events: [event(1, { kind: 'session' })] }, lead)
    expect(notices.join('\n')).not.toContain('task0001mach')
    expect(notices.join('\n')).toContain('task0002hand')
  })
})

test('the autopilot guide in the docs is the one the agent sends', () => {
  const doc = readFileSync(join(import.meta.dir, '../../docs/pool-orchestrator.md'), 'utf8')
  expect(doc).toContain(AUTOPILOT_GUIDE)
})
