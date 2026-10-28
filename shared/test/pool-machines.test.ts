// Pool machines in the client core (docs/pool-autopilot.md): the profile and the order, as sealed and as checked; the
// relay's machine messages, checked like the rest; and the pool state that follows them.
import { describe, expect, test } from 'bun:test'
import { newAccountKey } from '../crypto'
import { decodePoolTask, openPoolSessionOrder, PoolVault, sealPoolSessionOrder } from '../pool'
import {
  decodePoolDispatch,
  decodePoolMachineProfile,
  isPoolWorkdir,
  openPoolMachineOrder,
  poolMachineProfile,
  sealPoolMachineOrder,
} from '../pool-machines'
import type { PoolMachineProfile, PoolMachineWire, PoolSnapshot } from '../pool-protocol'
import { isPoolOrderType, parsePoolToMachine, parsePoolUpdate } from '../pool-wire'

const accountKey = newAccountKey()
const poolKey = newAccountKey()
const profile: PoolMachineProfile = { name: 'Studio', tool: 'claude', capacity: 2, workdir: '~/pool', mode: 'edits', areas: ['back'] }

describe('the machine profile', () => {
  test('a form gives a profile, or why it cannot be one', () => {
    expect(
      poolMachineProfile({
        name: ' Studio ',
        tool: 'claude',
        capacity: 2,
        workdir: ' ~/pool ',
        mode: 'edits',
        areas: ['Back', 'back', ' '],
      }),
    ).toEqual(profile)
    expect(poolMachineProfile({ tool: 'opencode', capacity: 1, workdir: '/srv/pool', mode: 'full', takes: 'simple' })).toEqual({
      tool: 'opencode',
      capacity: 1,
      workdir: '/srv/pool',
      mode: 'full',
      takes: 'simple',
    })
    expect(poolMachineProfile({ tool: 'cursor', capacity: 1, workdir: '~/pool', mode: 'ask' })).toBeString()
    expect(poolMachineProfile({ tool: 'claude', capacity: 9, workdir: '~/pool', mode: 'ask' })).toBeString()
    expect(poolMachineProfile({ tool: 'claude', capacity: 1.5, workdir: '~/pool', mode: 'ask' })).toBeString()
    expect(poolMachineProfile({ tool: 'claude', capacity: 1, workdir: 'pool', mode: 'ask' })).toBeString()
    expect(poolMachineProfile({ tool: 'claude', capacity: 1, workdir: '~/pool', mode: 'everything' })).toBeString()
  })

  test('a work folder is a full path on the machine, never relative and never climbing out', () => {
    for (const good of ['/srv/pool', '~/pool', 'C:\\pool', 'D:/work/pool']) expect(isPoolWorkdir(good)).toBe(true)
    for (const bad of ['pool', './pool', '/', '~', '~/', '/srv/../etc', '~/a/../../b', 'C:', '/a\nb', 5, null]) {
      expect(isPoolWorkdir(bad)).toBe(false)
    }
  })

  test('what another member sealed keeps the fields it should and drops a profile the agent could not run', () => {
    expect(decodePoolMachineProfile({ ...profile, extra: 1, takes: 'huge', areas: ['front', 3, ''] })).toEqual({
      ...profile,
      areas: ['front'],
    })
    expect(decodePoolMachineProfile({ ...profile, capacity: 0 })).toBeNull()
    expect(decodePoolMachineProfile({ ...profile, mode: 'root' })).toBeNull()
    expect(decodePoolMachineProfile({ ...profile, workdir: '../x' })).toBeNull()
    expect(decodePoolMachineProfile({ ...profile, tool: undefined })).toBeNull()
    expect(decodePoolMachineProfile('profile')).toBeNull()
    expect(decodePoolDispatch({ on: true, note: 'Go', x: 1 })).toEqual({ on: true, note: 'Go' })
    expect(decodePoolDispatch({ on: 'yes' })).toBeNull()
  })
})

describe('the machine order', () => {
  test('it opens with the account key, for the machine and the pool it names, with a profile the agent can apply', async () => {
    const order = await sealPoolMachineOrder(accountKey, {
      poolId: 'pool00000001',
      machineId: 'machine00001',
      key: poolKey,
      version: 2,
      profile,
    })
    expect(await openPoolMachineOrder(accountKey, order, 'machine00001', 'pool00000001')).toMatchObject({
      key: poolKey,
      version: 2,
      profile,
    })
    // The relay could hand it to another machine or pool; it could not make one.
    expect(await openPoolMachineOrder(accountKey, order, 'machine00002', 'pool00000001')).toBeNull()
    expect(await openPoolMachineOrder(accountKey, order, 'machine00001', 'pool00000002')).toBeNull()
    expect(await openPoolMachineOrder(newAccountKey(), order, 'machine00001', 'pool00000001')).toBeNull()
    const broken = await sealPoolMachineOrder(accountKey, {
      poolId: 'pool00000001',
      machineId: 'machine00001',
      key: poolKey,
      version: 1,
      profile: { ...profile, mode: 'root' as never },
    })
    expect(await openPoolMachineOrder(accountKey, broken, 'machine00001', 'pool00000001')).toBeNull()
  })

  test("a worker session's order says its machine and the mode its owner chose; one put in by hand says neither", async () => {
    const worker = await sealPoolSessionOrder(accountKey, {
      poolId: 'pool00000001',
      sessionId: 's1',
      key: poolKey,
      version: 1,
      autoStart: true,
      machine: 'machine00001',
      mode: 'edits',
    })
    expect(await openPoolSessionOrder(accountKey, worker, 's1', 'pool00000001')).toMatchObject({ machine: 'machine00001', mode: 'edits' })
    const forged = await sealPoolSessionOrder(accountKey, {
      poolId: 'pool00000001',
      sessionId: 's1',
      key: poolKey,
      version: 1,
      machine: 'machine00001',
      mode: 'root' as never,
    })
    const opened = await openPoolSessionOrder(accountKey, forged, 's1', 'pool00000001')
    expect(opened?.machine).toBeUndefined()
    expect(opened?.mode).toBeUndefined()
  })

  test('the relay hands a machine its orders; a wrong shape is no order', () => {
    expect(isPoolOrderType('pool_machine_join')).toBe(true)
    expect(isPoolOrderType('pool_machine_leave')).toBe(true)
    const join = { t: 'pool_machine_join' as const, machineId: 'm1', poolId: 'p1', order: 'sealed' }
    expect(parsePoolToMachine({ ...join, extra: 1 })).toEqual(join)
    expect(parsePoolToMachine({ t: 'pool_machine_leave', machineId: 'm1', poolId: 'p1' })).toEqual({
      t: 'pool_machine_leave',
      machineId: 'm1',
      poolId: 'p1',
    })
    expect(parsePoolToMachine({ ...join, order: 5 })).toBeNull()
    expect(parsePoolToMachine({ ...join, machineId: undefined })).toBeNull()
    expect(parsePoolToMachine({ t: 'pool_join', machineId: 'm1', poolId: 'p1', order: 'x' })).toBeNull()
  })
})

describe('machines in the pool state', () => {
  const vault = new PoolVault(poolKey)
  const author = { account: 'acct', session: null }
  const ref = { account: 'acct', machine: 'machine00001' }

  async function machine(fields: Partial<PoolMachineWire> = {}): Promise<PoolMachineWire> {
    return { ...ref, addedAt: '2026-10-28T10:00:00.000Z', profile: await vault.seal(profile), online: true, ready: false, ...fields }
  }

  async function snapshot(fields: Partial<PoolSnapshot> = {}): Promise<PoolSnapshot> {
    return {
      id: 'pool00000001',
      createdAt: '2026-10-28T10:00:00.000Z',
      paused: false,
      keyVersion: 1,
      info: await vault.seal({ name: 'Hackathon' }),
      members: [],
      sessions: [],
      tasks: [],
      notes: null,
      messages: [],
      events: [],
      ...fields,
    }
  }

  test("a snapshot opens the machines' profiles; older relays have none", async () => {
    const dispatch = { rev: 1, updatedAt: 'x', ...author, blob: await vault.seal({ on: true }) }
    const pool = await snapshot({ machines: [await machine()], orchestratorMachine: ref, dispatch })
    const state = await vault.snapshot(pool)
    expect(state.machines).toEqual([{ ...ref, addedAt: '2026-10-28T10:00:00.000Z', profile, online: true, ready: false }])
    expect(state.orchestratorMachine).toEqual(ref)
    expect(state.dispatch?.value).toEqual({ on: true })
    const older = await vault.snapshot(await snapshot())
    expect(older.machines).toBeUndefined()
    expect(older.orchestratorMachine).toBeNull()
    expect(older.dispatch).toBeNull()
  })

  test('each machine update folds in; a machine whose member left goes, and the orchestrator machine with it', async () => {
    let state = await vault.snapshot(await snapshot({ machines: [], orchestratorMachine: null }))
    const apply = async (update: Parameters<PoolVault['apply']>[1]) => {
      const next = await vault.apply(state, update)
      if (!next) throw new Error('the pool went away')
      state = next
    }
    await apply({ t: 'pool_machine', poolId: state.id, machine: await machine() })
    await apply({ t: 'pool_machine', poolId: state.id, machine: await machine({ ready: true }) })
    expect(state.machines?.map(m => m.ready)).toEqual([true])
    await apply({ t: 'pool_orchestrator', poolId: state.id, orchestrator: null, machine: ref })
    expect(state.orchestratorMachine).toEqual(ref)
    // An older relay names no machine: the one known stays.
    await apply({ t: 'pool_orchestrator', poolId: state.id, orchestrator: { account: 'acct', session: 's1' } })
    expect(state.orchestratorMachine).toEqual(ref)
    await apply({
      t: 'pool_dispatch',
      poolId: state.id,
      dispatch: { rev: 2, updatedAt: 'y', ...author, machine: ref.machine, blob: await vault.seal({ on: false }) },
    })
    expect(state.dispatch).toMatchObject({ rev: 2, machine: ref.machine, value: { on: false } })
    await apply({ t: 'pool_machine_left', poolId: state.id, account: 'acct', machine: ref.machine })
    expect(state.machines).toEqual([])
    expect(state.orchestratorMachine).toBeNull()

    await apply({ t: 'pool_machine', poolId: state.id, machine: await machine() })
    await apply({ t: 'pool_orchestrator', poolId: state.id, orchestrator: null, machine: ref })
    await apply({ t: 'pool_member_left', poolId: state.id, account: 'acct' })
    expect(state.machines).toEqual([])
    expect(state.orchestratorMachine).toBeNull()
  })

  test("the relay's machine messages are checked: a wrong shape is dropped, and so is a record that mislabels its machine", async () => {
    const good = await machine()
    expect(parsePoolUpdate({ t: 'pool_machine', poolId: 'p', machine: good })).toEqual({ t: 'pool_machine', poolId: 'p', machine: good })
    expect(parsePoolUpdate({ t: 'pool_machine', poolId: 'p', machine: { ...good, ready: 'yes' } })).toBeNull()
    expect(parsePoolUpdate({ t: 'pool_machine_left', poolId: 'p', account: 'a', machine: 7 })).toBeNull()
    expect(parsePoolUpdate({ t: 'pool_orchestrator', poolId: 'p', orchestrator: null, machine: { account: 'a' } })).toBeNull()
    expect(parsePoolUpdate({ t: 'pool_orchestrator', poolId: 'p', orchestrator: null, machine: null })).toEqual({
      t: 'pool_orchestrator',
      poolId: 'p',
      orchestrator: null,
      machine: null,
    })
    const task = { id: 'task0001', rev: 1, updatedAt: 'x', ...author, blob: 'b' }
    expect(parsePoolUpdate({ t: 'pool_task', poolId: 'p', task: { ...task, machine: 'm1' } })).not.toBeNull()
    expect(parsePoolUpdate({ t: 'pool_task', poolId: 'p', task: { ...task, machine: { id: 'm1' } } })).toBeNull()
    expect(parsePoolUpdate({ t: 'pool_conflict', poolId: 'p', kind: 'dispatch', current: null })).toEqual({
      t: 'pool_conflict',
      poolId: 'p',
      kind: 'dispatch',
      current: null,
    })
    // A snapshot keeps the good machines and leaves out a field of the wrong shape.
    const parsed = parsePoolUpdate({
      t: 'pool_snapshot',
      pool: { ...(await snapshot()), machines: [good, { ...good, online: 1 }], orchestratorMachine: 5 },
    })
    expect(parsed?.t === 'pool_snapshot' && parsed.pool.machines).toEqual([good])
    expect(parsed?.t === 'pool_snapshot' && 'orchestratorMachine' in parsed.pool).toBe(false)
  })

  test('a task names the machine it is dispatched to, and how many times it failed', () => {
    expect(decodePoolTask({ title: 'API', state: 'assigned', machine: ref, attempts: 2 })).toEqual({
      title: 'API',
      state: 'assigned',
      machine: ref,
      attempts: 2,
    })
    expect(decodePoolTask({ title: 'API', state: 'assigned', machine: { account: 'a' }, attempts: -1 })).toEqual({
      title: 'API',
      state: 'assigned',
    })
  })
})
