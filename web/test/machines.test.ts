// The website's Machines tab: each machine of a pool with the tasks that hold its slots and the sessions working on them.
import { describe, expect, test } from 'bun:test'
import type { PoolMachine, PoolMachineProfile, PoolSession, PoolState, PoolTask, PoolTaskItem } from '../../shared'
import { machineCards } from '../site/pools/machines-model'

const ANA = 'acc_ana'
const BOB = 'acc_bob'

const profile = (name: string | undefined, capacity: number): PoolMachineProfile => ({
  name,
  tool: 'claude',
  capacity,
  workdir: '/work/repo',
  mode: 'edits',
})

const machine = (account: string, id: string, profile: PoolMachineProfile | null): PoolMachine => ({
  account,
  machine: id,
  addedAt: '2026-10-28T09:00:00.000Z',
  profile,
  online: true,
  ready: true,
})

const session = (account: string, id: string, onMachine: string): PoolSession => ({
  account,
  session: id,
  joinedAt: '2026-10-28T09:10:00.000Z',
  profile: { tool: 'claude' },
  online: true,
  ready: true,
  status: 'working',
  accepted: 0,
  machine: onMachine,
})

let seq = 0
const task = (fields: Partial<PoolTask>): PoolTaskItem => ({
  id: `task_${++seq}`,
  rev: 1,
  updatedAt: '2026-10-28T10:00:00.000Z',
  account: ANA,
  session: null,
  task: { title: `Task ${seq}`, state: 'todo', ...fields },
})

function pool(fields: Partial<PoolState>): PoolState {
  return {
    id: 'pool12345678',
    createdAt: '2026-10-28T09:00:00.000Z',
    paused: false,
    keyVersion: 1,
    info: { name: 'Hack' },
    members: [
      { account: ANA, role: 'owner', joinedAt: '2026-10-28T09:00:00.000Z', profile: { name: 'Ana' }, publicKeys: [] },
      { account: BOB, role: 'member', joinedAt: '2026-10-28T09:01:00.000Z', profile: { name: 'Bob' }, publicKeys: [] },
    ],
    sessions: [],
    tasks: [],
    notes: null,
    messages: [],
    events: [],
    own: { secret: null, wraps: [] },
    rules: null,
    budgets: null,
    audit: [],
    orchestrator: null,
    ...fields,
  }
}

describe('machineCards', () => {
  test('an older relay without machines gives none', () => {
    expect(machineCards(pool({}), ANA)).toEqual([])
  })

  test('the tasks dispatched to a machine hold its slots, with the session working on each', () => {
    const working = task({
      state: 'in_progress',
      machine: { account: BOB, machine: 'mac_bob' },
      assignee: { account: BOB, session: 'ses_1' },
    })
    const starting = task({ state: 'assigned', machine: { account: BOB, machine: 'mac_bob' } })
    const stuck = task({ state: 'blocked', machine: { account: BOB, machine: 'mac_bob' }, attempts: 2 })
    const state = pool({
      machines: [machine(BOB, 'mac_bob', profile('Studio', 4))],
      sessions: [session(BOB, 'ses_1', 'mac_bob')],
      tasks: [
        working,
        starting,
        stuck,
        // Done, still waiting, or on another machine: no slot here.
        task({ state: 'done', machine: { account: BOB, machine: 'mac_bob' } }),
        task({ state: 'todo' }),
        task({ state: 'in_progress', machine: { account: ANA, machine: 'mac_bob' } }),
      ],
    })
    const [card] = machineCards(state, ANA)
    expect(card?.slots.map(slot => slot.task.id)).toEqual([working.id, starting.id, stuck.id])
    expect(card?.slots[0]?.session?.session).toBe('ses_1')
    expect(card?.slots[1]?.session).toBeNull()
    expect(card?.slots.map(slot => slot.phase)).toEqual(['working', 'starting', 'none'])
    expect(card?.free).toBe(1)
    expect(card?.owner).toBe('Bob')
    expect(card?.mine).toBe(false)
  })

  test('free slots never go below zero, and a machine that takes no tasks has none', () => {
    const busy = (id: string) => task({ state: 'in_progress', machine: { account: ANA, machine: id } })
    const state = pool({
      machines: [
        machine(ANA, 'mac_full', profile('Full', 1)),
        machine(ANA, 'mac_sealed', null),
        { ...machine(ANA, 'mac_off', profile('Off', 2)), online: false, ready: false },
        { ...machine(ANA, 'mac_old', profile('Old', 2)), ready: false },
      ],
      tasks: [busy('mac_full'), busy('mac_full')],
    })
    const free = new Map(machineCards(state, ANA).map(card => [card.machine.machine, card.free]))
    expect(Object.fromEntries(free)).toEqual({ mac_full: 0, mac_sealed: 0, mac_off: 0, mac_old: 0 })
  })

  test('a slot without a session: starting, waiting for its machine, or left the pool', () => {
    const on = (id: string, fields: Partial<PoolTask> = {}) =>
      task({ state: 'assigned', machine: { account: ANA, machine: id }, ...fields })
    const stopped = on('mac_on', { state: 'in_progress', assignee: { account: ANA, session: 'ses_gone' } })
    const phases = (state: PoolState) =>
      Object.fromEntries(machineCards(state, ANA).flatMap(card => card.slots.map(slot => [slot.task.id, slot.phase])))
    const machines = [machine(ANA, 'mac_on', profile('On', 4)), { ...machine(ANA, 'mac_off', profile('Off', 4)), online: false }]
    const starting = on('mac_on')
    const waiting = on('mac_off')
    const state = pool({ machines, tasks: [starting, waiting, stopped] })
    expect(phases(state)).toEqual({ [starting.id]: 'starting', [waiting.id]: 'waiting', [stopped.id]: 'left' })
    // A paused pool starts nothing.
    expect(phases({ ...state, paused: true })[starting.id]).toBe('waiting')
  })

  test("this account's machines come first, then by name, named by their profile or the account's own list", () => {
    const state = pool({
      machines: [
        machine(BOB, 'mac_b', profile('Alpha', 1)),
        machine(ANA, 'mac_z', profile(undefined, 1)),
        machine(ANA, 'mac_y', profile('Mini', 1)),
        machine(BOB, 'mac_x', null),
      ],
      orchestratorMachine: { account: ANA, machine: 'mac_y' },
    })
    const cards = machineCards(state, ANA, new Map([['mac_z', 'Laptop']]))
    expect(cards.map(card => card.name)).toEqual(['Laptop', 'Mini', 'A machine', 'Alpha'])
    expect(cards.map(card => card.orchestrator)).toEqual([false, true, false, false])
    expect(cards.map(card => card.mine)).toEqual([true, true, false, false])
  })
})
