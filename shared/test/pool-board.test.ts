import { expect, test } from 'bun:test'
import type { PoolPostItem, PoolState, PoolTaskItem } from '../pool'
import {
  assignableRoles,
  BOARD_COLUMNS,
  board,
  canKick,
  draftOf,
  invitableRoles,
  memberName,
  moved,
  poolAbilities,
  sessionName,
  sortedMembers,
  taskEvent,
  taskHistory,
  taskOf,
  waitingOn,
} from '../pool-board'
import type { PoolEventBody, PoolRole, PoolTask } from '../pool-protocol'

const item = (id: string, task: PoolTask | null, updatedAt = '2026-10-27T10:00:00Z'): PoolTaskItem => ({
  id,
  rev: 1,
  updatedAt,
  account: 'acc_ana',
  session: null,
  task,
})

test('tasks go in the column of their state, the latest changed first, and unreadable ones apart', () => {
  const tasks = [
    item('a', { title: 'API', state: 'in_progress' }, '2026-10-27T10:00:00Z'),
    item('b', { title: 'Page', state: 'in_progress' }, '2026-10-27T11:00:00Z'),
    item('c', { title: 'Tests', state: 'done' }),
    item('d', null),
  ]
  const shown = board(tasks)
  expect(shown.columns.map(column => column.state)).toEqual(BOARD_COLUMNS.map(column => column.state))
  expect(shown.columns.find(column => column.state === 'in_progress')?.tasks.map(t => t.id)).toEqual(['b', 'a'])
  expect(shown.columns.find(column => column.state === 'done')?.tasks.map(t => t.id)).toEqual(['c'])
  expect(shown.unreadable.map(t => t.id)).toEqual(['d'])
})

test('a role is offered what the relay allows it, nothing more', () => {
  expect(poolAbilities('viewer')).toMatchObject({ write: false, invite: false, kick: false, leave: true, remove: false })
  expect(poolAbilities('member')).toMatchObject({ write: true, invite: false, kick: false })
  expect(poolAbilities('admin')).toMatchObject({ write: true, invite: true, kick: true, manageAdmins: false, remove: false })
  expect(poolAbilities('owner')).toMatchObject({ manageAdmins: true, remove: true, leave: false })

  // As relay/src/pool-routes.ts: the owner changes anyone but itself, admins change members and viewers.
  expect(assignableRoles('owner', 'admin', false)).toEqual(['admin', 'member', 'viewer'])
  expect(assignableRoles('admin', 'member', false)).toEqual(['member', 'viewer'])
  expect(assignableRoles('admin', 'admin', false)).toEqual([])
  expect(assignableRoles('owner', 'owner', false)).toEqual([])
  expect(assignableRoles('owner', 'member', true)).toEqual([])
  expect(assignableRoles('member', 'viewer', false)).toEqual([])
  const roles: PoolRole[] = ['owner', 'admin', 'member', 'viewer']
  const kicks = roles.map(actor => roles.filter(target => canKick(actor, target, false)))
  expect(kicks).toEqual([['admin', 'member', 'viewer'], ['member', 'viewer'], [], []])
  expect(canKick('owner', 'member', true)).toBe(false)
  expect(invitableRoles('owner')).toContain('admin')
  expect(invitableRoles('admin')).not.toContain('admin')
  expect(invitableRoles('member')).toEqual([])
})

test('a task goes through the form and back unchanged, empty fields left out', () => {
  const task: PoolTask = {
    title: 'Checkout page',
    goal: 'Follow the API in the notes',
    criteria: ['Pays with a card', 'Shows the receipt'],
    area: 'front',
    state: 'assigned',
    assignee: { account: 'acc_bob', session: 'ses_1' },
    dependsOn: ['t1', 't2'],
    branch: 'feat/checkout',
  }
  expect(taskOf(draftOf(task))).toEqual(task)
  expect(taskOf({ ...draftOf(null), title: '  Only a title ' })).toEqual({ title: 'Only a title', state: 'todo' })
  expect(taskOf(draftOf(null))).toBeNull()
  expect(taskOf({ ...draftOf(null), title: 'x', criteria: '- one\n\n* two', dependsOn: 'a,b  c' })).toMatchObject({
    criteria: ['one', 'two'],
    dependsOn: ['a', 'b', 'c'],
  })
})

test('moving a task back to "to do" frees it, and each change says what it was', () => {
  const task: PoolTask = { title: 'API', state: 'assigned', assignee: { account: 'a', session: 's' } }
  expect(moved(task, 'todo')).toEqual({ title: 'API', state: 'todo' })
  expect(moved(task, 'in_progress').assignee).toEqual({ account: 'a', session: 's' })
  expect(taskEvent(null, task, 't1')).toEqual({ kind: 'task_created', taskId: 't1', text: 'API' })
  expect(taskEvent(task, moved(task, 'done'), 't1')).toEqual({ kind: 'task_moved', taskId: 't1', text: 'Assigned → Done' })
  expect(taskEvent(task, { ...task, branch: 'b' }, 't1').kind).toBe('task_edited')
})

test("a task's history and what it waits for", () => {
  const event = (seq: number, body: PoolEventBody | null): PoolPostItem<PoolEventBody> => ({
    id: `e${seq}`,
    seq,
    ts: '2026-10-27T10:00:00Z',
    account: 'acc_ana',
    session: null,
    body,
  })
  const events = [
    event(3, { kind: 'task_moved', taskId: 't1' }),
    event(1, { kind: 'task_created', taskId: 't1' }),
    event(2, { kind: 'joined' }),
    event(4, null),
  ]
  expect(taskHistory(events, 't1').map(e => e.seq)).toEqual([1, 3])
  const tasks = [item('t1', { title: 'API', state: 'done' }), item('t2', { title: 'DB', state: 'in_progress' })]
  expect(waitingOn(tasks, { title: 'Page', state: 'todo', dependsOn: ['t1', 't2', 'gone'] })).toEqual(['t2', 'gone'])
})

test('members and sessions go by their names, the owner first', () => {
  const state = {
    members: [
      { account: 'acc_bob', role: 'member', joinedAt: '', profile: { name: 'Bob' }, publicKeys: [] },
      { account: 'acc_zed', role: 'viewer', joinedAt: '', profile: null, publicKeys: [] },
      { account: 'acc_ana', role: 'owner', joinedAt: '', profile: { name: 'Ana' }, publicKeys: [] },
    ],
    sessions: [{ account: 'acc_ana', session: 'ses_back', joinedAt: '', profile: { area: 'back' }, online: true, ready: true }],
  } as unknown as PoolState
  expect(sortedMembers(state).map(m => m.account)).toEqual(['acc_ana', 'acc_bob', 'acc_zed'])
  expect(memberName(state, 'acc_zed')).toBe('Member acc_ze')
  expect(sessionName(state, { account: 'acc_ana', session: 'ses_back' })).toBe('Ana · back')
  expect(sessionName(state, { account: 'acc_bob', session: 'ses_12345678x' })).toBe('Bob · ses_1234')
})
