import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_POOL_INVITES, MAX_POOL_MACHINES, MAX_POOL_MESSAGES, MAX_POOL_TASKS, MAX_POOLS_PER_ACCOUNT } from '../src/limits'
import { PoolMachineStore } from '../src/pool-machines'
import { PoolStore } from '../src/pools'
import { Registry } from '../src/registry'

let dir: string
let registry: Registry
let pools: PoolStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tonton-pool-store-'))
  registry = new Registry(dir)
  pools = new PoolStore(registry.db)
})

afterEach(() => {
  registry.close()
  rmSync(dir, { recursive: true, force: true })
})

const id = (n: number) => `pool${String(n).padStart(8, '0')}`
const author = (accountId: string) => ({ accountId, sessionId: null })
const keys = { publicKey: 'public-v1', secret: 'secret' }

test('an account is in a bounded number of pools, and a pool id is used once', () => {
  const owner = registry.createAccount().id
  for (let i = 0; i < MAX_POOLS_PER_ACCOUNT; i++) expect(pools.create(owner, id(i), 'info', 'grant', null, keys)).not.toBeNull()
  expect(pools.create(owner, id(99), 'info', 'grant', null, keys)).toBeNull()
  const other = registry.createAccount().id
  expect(pools.create(other, id(0), 'info', 'grant', null, keys)).toBeNull()
})

test('an invite expires, runs out, and only so many can be open', () => {
  const owner = registry.createAccount().id
  const member = registry.createAccount().id
  pools.create(owner, id(1), 'info', 'grant', null, keys)
  const expired = pools.createInvite(id(1), 'member', 5, Date.now() - 1)
  expect(expired).not.toBeNull()
  expect(pools.join(expired?.token ?? '', member, 'grant', null, keys)).toEqual({ ok: false, reason: 'invalid' })
  for (let i = 0; i < MAX_POOL_INVITES; i++) expect(pools.createInvite(id(1), 'member', 1, Date.now() + 60_000)).not.toBeNull()
  expect(pools.createInvite(id(1), 'member', 1, Date.now() + 60_000)).toBeNull()
  // An invite token of another kind opens nothing.
  expect(pools.join(registry.createAccount().token, member, 'grant', null, keys)).toEqual({ ok: false, reason: 'invalid' })
})

test('tasks are bounded, and a change over an older revision is refused with the current one', () => {
  const owner = registry.createAccount().id
  pools.create(owner, id(1), 'info', 'grant', null, keys)
  const first = pools.putTask(id(1), 'task0001', 0, 'v1', author(owner))
  expect(first).toMatchObject({ ok: true, value: { rev: 1, blob: 'v1' } })
  expect(pools.putTask(id(1), 'task0001', 0, 'other', author(owner))).toMatchObject({ ok: false, reason: 'conflict', current: { rev: 1 } })
  expect(pools.putTask(id(1), 'task0001', 1, 'v2', author(owner))).toMatchObject({ ok: true, value: { rev: 2 } })
  // A change to a task nobody made yet is a conflict with nothing.
  expect(pools.putTask(id(1), 'task0002', 3, 'v1', author(owner))).toEqual({ ok: false, reason: 'conflict', current: null })
  for (let i = 1; i < MAX_POOL_TASKS; i++) pools.putTask(id(1), `task${String(i + 1).padStart(4, '0')}`, 0, 'v', author(owner))
  expect(pools.tasks(id(1))).toHaveLength(MAX_POOL_TASKS)
  expect(pools.putTask(id(1), 'tasklast1', 0, 'v', author(owner))).toEqual({ ok: false, reason: 'limit' })
  // Changing an existing one still works at the cap.
  expect(pools.putTask(id(1), 'task0001', 2, 'v3', author(owner)).ok).toBe(true)
})

test('messages go oldest first past the cap, and an id is posted once', () => {
  const owner = registry.createAccount().id
  pools.create(owner, id(1), 'info', 'grant', null, keys)
  for (let i = 0; i < MAX_POOL_MESSAGES + 5; i++)
    pools.addPost('message', id(1), `message${String(i).padStart(5, '0')}`, 'm', author(owner))
  const kept = pools.posts('message', id(1), MAX_POOL_MESSAGES + 10)
  expect(kept).toHaveLength(MAX_POOL_MESSAGES)
  expect(kept[0].id).toBe('message00005')
  expect(pools.addPost('message', id(1), 'message02004', 'again', author(owner))).toBeNull()
  // Events have their own cap: messages leave them alone.
  expect(pools.addPost('event', id(1), 'message00000', 'e', author(owner))).not.toBeNull()
})

test('deleting an account deletes the pools it owns and its memberships, sessions included', () => {
  const owner = registry.createAccount().id
  const member = registry.createAccount().id
  pools.create(owner, id(1), 'info', 'grant', null, keys)
  pools.create(member, id(2), 'info', 'grant', null, keys)
  const invite = pools.createInvite(id(2), 'member', 1, Date.now() + 60_000)
  expect(pools.join(invite?.token ?? '', owner, 'grant', null, keys)).toEqual({ ok: true, poolId: id(2), fresh: true })
  pools.addSession(id(2), owner, 'ses_1', 'order', 'profile')
  registry.deleteAccount(owner)
  expect(pools.summaries(owner)).toEqual([])
  expect(pools.snapshot(id(1), () => ({ online: false, ready: false }))).toBeNull()
  expect(pools.memberAccounts(id(2))).toEqual([member])
  expect(pools.sessions(id(2))).toEqual([])
})

test('a pool holds a bounded number of machines; one goes with its member, and when it is revoked', () => {
  const machines = new PoolMachineStore(registry.db)
  const owner = registry.createAccount().id
  const member = registry.createAccount().id
  pools.create(owner, id(1), 'info', 'grant', null, keys)
  const invite = pools.createInvite(id(1), 'member', 1, Date.now() + 60_000)
  pools.join(invite?.token ?? '', member, 'grant', null, keys)
  const secret = registry.newJoinSecret(owner, false)?.secret ?? ''
  const joined = Array.from({ length: MAX_POOL_MACHINES + 1 }, () => {
    const result = registry.joinMachine(owner, secret, 'name')
    if (!result.ok) throw new Error(result.reason)
    return result.machine.id
  })
  for (const machineId of joined.slice(0, MAX_POOL_MACHINES))
    expect(machines.add(id(1), owner, machineId, 'order', 'profile')).not.toBeNull()
  expect(machines.add(id(1), owner, joined[MAX_POOL_MACHINES], 'order', 'profile')).toBeNull()
  // Changing one already in works at the cap, and keeps when it was added.
  const first = machines.get(id(1), joined[0])
  expect(machines.add(id(1), owner, joined[0], 'order-2', 'profile-2')).toEqual({
    ...first,
    order: 'order-2',
    profile: 'profile-2',
  } as never)

  registry.revokeMachine(owner, joined[0])
  expect(machines.get(id(1), joined[0])).toBeNull()
  expect(machines.list(id(1))).toHaveLength(MAX_POOL_MACHINES - 1)

  // The orchestrator machine is none once it leaves the pool.
  machines.setOrchestrator(id(1), joined[1])
  expect(machines.orchestrator(id(1))).toEqual({ account: owner, machine: joined[1] })
  machines.remove(id(1), joined[1])
  expect(machines.orchestrator(id(1))).toBeNull()
  expect(machines.orchestratorId(id(1))).toBe(joined[1])

  // A member's machines go with it.
  const memberSecret = registry.newJoinSecret(member, false)?.secret ?? ''
  const own = registry.joinMachine(member, memberSecret, 'name')
  if (!own.ok) throw new Error(own.reason)
  machines.remove(id(1), joined[2])
  expect(machines.add(id(1), member, own.machine.id, 'order', 'profile')).not.toBeNull()
  pools.leave(id(1), member)
  expect(machines.poolsOf(own.machine.id)).toEqual([])
})
