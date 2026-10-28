// The plan the orchestrator proposes and an admin accepts (shared/pool-plan.ts): what a sealed proposal may hold, when
// the card shows, and how it reads, each machine with what it starts.
import { describe, expect, test } from 'bun:test'
import type { PoolMachine, PoolPostItem, PoolState } from '../pool'
import { decodePlanProposal, pendingPlan, planLanes } from '../pool-plan'
import type { PoolEventBody } from '../pool-protocol'

const LEAD = { account: 'adminaccount', session: 'ses_lead' }
const proposal = {
  tasks: [
    { id: 'task0001api', machine: { account: 'memberacct01', machine: 'machinestud1' } },
    { id: 'task0002web', machine: { account: 'memberacct01', machine: 'machinestud1' } },
    { id: 'task0003e2e' },
  ],
}
const event = (seq: number, body: PoolEventBody, author: Partial<PoolPostItem<PoolEventBody>> = {}): PoolPostItem<PoolEventBody> => ({
  id: `e${seq}`,
  seq,
  ts: 'x',
  ...LEAD,
  body,
  ...author,
})
const proposed = (seq: number, author = {}) => event(seq, { kind: 'plan_proposed', text: 'The API, then the shop.', proposal }, author)
type Pending = Pick<PoolState, 'events' | 'orchestrator' | 'dispatch'>
const pool = (events: PoolPostItem<PoolEventBody>[], fields: Partial<Pending> = {}): Pending => ({
  events,
  orchestrator: LEAD,
  dispatch: null,
  ...fields,
})

describe('a proposal', () => {
  test('keeps the entries of the right shape only', () => {
    expect(decodePlanProposal(proposal)).toEqual(proposal)
    expect(decodePlanProposal({ tasks: [{ id: 'task0001api', machine: { account: 1 } }, { id: '../x' }, 'task', { id: 'ok' }] })).toEqual({
      tasks: [{ id: 'task0001api' }, { id: 'ok' }],
    })
    expect(decodePlanProposal({ tasks: Array.from({ length: 300 }, (_, i) => ({ id: `t${i}` })) })?.tasks).toHaveLength(100)
    expect(decodePlanProposal('plan')).toBeUndefined()
  })

  test('waits for an admin while the dispatch is off and nothing since says the work started', () => {
    expect(pendingPlan(pool([proposed(1)]))?.id).toBe('e1')
    // The latest one.
    expect(pendingPlan(pool([proposed(1), event(2, { kind: 'task_created' }), proposed(3)]))?.id).toBe('e3')
    expect(pendingPlan(pool([proposed(1), event(2, { kind: 'plan_accepted' }, { session: null })]))).toBeNull()
    expect(pendingPlan(pool([proposed(1), event(2, { kind: 'dispatched' }, { machine: 'machinelead1' })]))).toBeNull()
    const on = { rev: 1, updatedAt: 'x', account: LEAD.account, session: null, value: { on: true } }
    expect(pendingPlan(pool([proposed(1)], { dispatch: on }))).toBeNull()
    // A new plan after the work started shows again.
    expect(pendingPlan(pool([proposed(1), event(2, { kind: 'dispatch_done' }), proposed(3)]))?.id).toBe('e3')
  })

  test("only the orchestrator's: the relay attests who posted it", () => {
    expect(pendingPlan(pool([proposed(1, { account: 'memberacct01', session: 'ses_bob' })]))).toBeNull()
    expect(pendingPlan(pool([proposed(1)], { orchestrator: null }))).toBeNull()
  })

  test('reads as each machine with what it starts, then what comes later', () => {
    const studio: PoolMachine = {
      account: 'memberacct01',
      machine: 'machinestud1',
      addedAt: 'x',
      online: true,
      ready: true,
      profile: { name: 'Studio', tool: 'claude', capacity: 2, workdir: '~/p', mode: 'edits', plan: 'max_20x' },
    }
    const task = (id: string) => ({ id, rev: 1, updatedAt: 'x', ...LEAD, task: { title: id.slice(8), state: 'todo' as const } })
    const lanes = planLanes(
      {
        tasks: [task('task0001api'), task('task0002web'), task('task0003e2e')],
        machines: [studio],
        members: [{ account: 'memberacct01', role: 'member', joinedAt: 'x', profile: { name: 'Bob' }, publicKeys: [] }],
      },
      proposal,
    )
    expect(lanes.map(lane => [lane.name, lane.owner, lane.detail, lane.tasks.map(t => t.id)])).toEqual([
      ['Studio', 'Bob', 'Claude Max 20x · 2 at once', ['task0001api', 'task0002web']],
      ['Later', undefined, undefined, ['task0003e2e']],
    ])
  })
})
