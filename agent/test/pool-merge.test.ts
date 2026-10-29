// The pool side of task_merge: what is next in dependency order, and what each outcome does to the board. The merges
// themselves run on real repositories in a temporary folder; the pool is a plain state, and its writes are recorded.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PoolSession, PoolState, PoolTaskItem } from '../../shared/pool'
import type { PoolTask } from '../../shared/pool-protocol'
import { PoolGit } from '../src/channel/pool-git'
import { mergeBrief, mergeQueue, PoolMerger } from '../src/channel/pool-merge'
import type { PoolOps } from '../src/channel/pool-orchestrator'
import { isolateGit, makeRepos, originMain, pushBranch, pushMain, type Repos } from './git-repos'

const root = mkdtempSync(join(tmpdir(), 'tonton-pool-merge-'))
const restore = isolateGit(root)
let count = 0
const fresh = (): Repos => makeRepos(join(root, `case-${++count}`))

afterAll(() => {
  restore()
  rmSync(root, { recursive: true, force: true })
})

const NAMES: Record<string, string> = { ses_lead: 'Lea · orchestrator', ses_ana: 'Ana · back', ses_bob: 'Bob · front' }
const CHECKS = ['test ! -e BROKEN']

const session = (account: string, id: string, online = true): PoolSession => ({
  account,
  session: id,
  joinedAt: '2026-10-28T09:00:00Z',
  profile: { tool: 'claude' },
  online,
  ready: online,
  status: null,
  accepted: 0,
})

const item = (id: string, task: PoolTask, updatedAt = '2026-10-28T10:00:00Z'): PoolTaskItem => ({
  id,
  rev: 3,
  updatedAt,
  account: 'acc_ana',
  session: 'ses_ana',
  task,
})

const finished = (title: string, more: Partial<PoolTask> = {}): PoolTask => ({
  title,
  state: 'done',
  branch: `pool/${title.toLowerCase()}`,
  assignee: { account: 'acc_ana', session: 'ses_ana' },
  summary: 'Done\n\nTests: bun test',
  ...more,
})

const poolWith = (tasks: PoolTaskItem[], sessions = [session('acc_lea', 'ses_lead'), session('acc_ana', 'ses_ana')]): PoolState => ({
  id: 'pool1',
  createdAt: 'then',
  paused: false,
  keyVersion: 1,
  info: { name: 'Shop' },
  members: [],
  sessions,
  tasks,
  notes: null,
  messages: [],
  events: [],
  own: { secret: null, wraps: [] },
  rules: null,
  budgets: null,
  audit: [],
  orchestrator: { account: 'acc_lea', session: 'ses_lead' },
})

/** The pool tools, recorded: every task written, every event posted. */
function recorder() {
  const writes: { id: string; rev: number; task: PoolTask }[] = []
  const events: { kind: string; taskId?: string; text?: string }[] = []
  const messages: { to: string; text: string }[] = []
  const ops: PoolOps = {
    putTask: async (_pool, id, rev, task) => {
      writes.push({ id, rev, task })
      return null
    },
    putNotes: async () => null,
    putDispatch: async () => null,
    message: async (_pool, to, text) => {
      messages.push({ to: to.session, text })
      return null
    },
    event: async (_pool, kind, taskId, text) => {
      events.push({ kind, taskId, text })
    },
    descriptions: () => new Map(),
    who: (_state, _account, id) => (id ? (NAMES[id] ?? id) : 'a member'),
  }
  return { ops, writes, events, messages }
}

function merger(state: PoolState, folder: string | undefined) {
  const recorded = recorder()
  return {
    ...recorded,
    merger: new PoolMerger(
      recorded.ops,
      new PoolGit(),
      () => folder,
      () => state,
    ),
  }
}

describe('the merge queue', () => {
  test('finished branches not in main, each after the tasks it depends on, then by when they finished', () => {
    const state = poolWith([
      item('a', finished('A'), '2026-10-28T10:30:00Z'),
      item('b', finished('B', { dependsOn: ['a'] }), '2026-10-28T10:10:00Z'),
      item('c', finished('C', { merge: { state: 'merged', at: 'then', commit: 'abc' } })),
      item('d', finished('D', { branch: undefined })),
      item('e', finished('E', { merge: { state: 'conflict', at: 'then', fix: 'e2' } })),
      item('e2', { title: 'Merge conflict: E', state: 'in_progress', branch: 'pool/e' }),
      item('f', finished('F', { dependsOn: ['g', 'c', 'd'] }), '2026-10-28T09:00:00Z'),
      item('g', { title: 'G', state: 'in_progress', branch: 'pool/g' }),
      item('h', finished('H', { merge: { state: 'pr', at: 'then', url: 'https://example.com/pr/1' } })),
      item('i', finished('I'), '2026-10-28T10:20:00Z'),
      // A pull request still open: what depends on it waits.
      item('j', finished('J', { dependsOn: ['h'] }), '2026-10-28T08:00:00Z'),
      // A fix task that is not on the board fixes nothing.
      item('k', finished('K', { merge: { state: 'conflict', at: 'then', fix: 'gone' } }), '2026-10-28T10:40:00Z'),
    ])
    expect(mergeQueue(state)).toEqual([
      { id: 'i', title: 'I', branch: 'pool/i', waitsFor: [] },
      { id: 'a', title: 'A', branch: 'pool/a', waitsFor: [] },
      { id: 'b', title: 'B', branch: 'pool/b', waitsFor: ['a'] },
      { id: 'k', title: 'K', branch: 'pool/k', waitsFor: [] },
      { id: 'j', title: 'J', branch: 'pool/j', waitsFor: ['h'] },
      { id: 'f', title: 'F', branch: 'pool/f', waitsFor: ['g'] },
    ])
  })
})

describe('task_merge', () => {
  test('merges the next task in line, records the commit, and says what it frees and what comes next', async () => {
    const repos = fresh()
    pushBranch(repos.ana, 'pool/a', { 'a.txt': 'a\n' })
    const state = poolWith([
      item('a', finished('A')),
      item('b', finished('B', { dependsOn: ['a'] }), '2026-10-28T11:00:00Z'),
      item('t', { title: 'Screens', state: 'todo', dependsOn: ['a'] }),
    ])
    const { merger: m, writes, events } = merger(state, repos.lead)
    const said = await m.call('pool1', state, { checks: CHECKS })
    expect(said).toContain(
      `Merged pool/a into main as ${originMain(repos).slice(0, 10)}, pushed to origin, after \`test ! -e BROKEN\` passed.`,
    )
    expect(said).toContain('It frees t (Screens): assign them.')
    expect(said).toContain('Next to merge: b (B).')
    expect(writes).toEqual([
      { id: 'a', rev: 3, task: { ...finished('A'), merge: { state: 'merged', at: expect.any(String), commit: originMain(repos) } } },
    ])
    expect(events).toEqual([{ kind: 'merged', taskId: 'a', text: `pool/a → main ${originMain(repos).slice(0, 10)}` }])
  })

  test('the sessions working on what builds on it are told it is in main, and how to bring it in', async () => {
    const repos = fresh()
    pushBranch(repos.ana, 'pool/a', { 'a.txt': 'a\n' })
    const bob = { account: 'acc_bob', session: 'ses_bob' }
    const state = poolWith([
      item('a', finished('A')),
      item('f', { title: 'Front', state: 'in_progress', assignee: bob, buildsOn: ['a'] }),
      item('x', { title: 'Docs', state: 'in_progress', assignee: { account: 'acc_lea', session: 'ses_doc' } }),
      item('t', { title: 'Screens', state: 'todo', buildsOn: ['a'] }),
    ])
    const { merger: m, messages } = merger(state, repos.lead)
    await m.call('pool1', state, { checks: CHECKS })
    expect(messages).toEqual([
      {
        to: 'ses_bob',
        text: `Tonton: a (A), which f builds on, is in main now (${originMain(repos).slice(0, 10)}). Bring it into your branch to use it: git fetch, then git merge origin/main.`,
      },
    ])
  })

  test('a conflict sends the task back to its free author, with the files and the conflict', async () => {
    const repos = fresh()
    pushBranch(repos.ana, 'pool/a', { 'app.txt': 'mine\n' })
    pushMain(repos.ana, { 'app.txt': 'theirs\n' })
    const before = originMain(repos)
    const state = poolWith([item('a', finished('A', { review: 'Checked it' }))])
    const { merger: m, writes, events, messages } = merger(state, repos.lead)
    const said = await m.call('pool1', state, { task: 'a', checks: CHECKS })
    expect(said).toContain('pool/a conflicts with main in app.txt: nothing was merged.')
    // An older agent drops the record: the message tells it anyway.
    expect(messages).toEqual([
      { to: 'ses_ana', text: expect.stringContaining('came back from the merge: pool/a conflicts with main in app.txt') },
    ])
    expect(said).toContain('Sent back to Ana · back')
    expect(originMain(repos)).toBe(before)
    expect(writes).toHaveLength(1)
    expect(writes[0].task).toMatchObject({
      state: 'assigned',
      assignee: { session: 'ses_ana' },
      merge: { state: 'conflict', files: ['app.txt'] },
    })
    expect(writes[0].task.merge?.output).toContain('<<<<<<<')
    expect(events).toEqual([{ kind: 'merge_conflict', taskId: 'a', text: 'app.txt' }])
    // Its agent hands it the details, not the review it passed.
    expect(writes[0].task.review).toBeUndefined()
    const brief = mergeBrief(writes[0].task)
    expect(brief).toContain('Sent back by the merge: pool/a conflicts with main in app.txt.')
    expect(brief).toContain('git merge origin/main')
  })

  test('a failing check, with an author on another task, becomes a new task on the same branch', async () => {
    const repos = fresh()
    pushBranch(repos.ana, 'pool/a', { BROKEN: 'yes\n' })
    const state = poolWith([
      item('a', finished('A', { area: 'back', size: 'simple' })),
      item('other', { title: 'Other', state: 'in_progress', assignee: { account: 'acc_ana', session: 'ses_ana' } }),
    ])
    const { merger: m, writes, events } = merger(state, repos.lead)
    const said = await m.call('pool1', state, { checks: CHECKS })
    expect(said).toContain('Merged with main, pool/a fails `test ! -e BROKEN`, which passes on main: nothing was merged.')
    expect(said).toContain('Its author cannot take it back (its session works on another task)')
    const [fix, original] = writes
    expect(fix.rev).toBe(0)
    expect(fix.task).toMatchObject({
      title: 'Fix the checks: A',
      state: 'todo',
      branch: 'pool/a',
      area: 'back',
      size: 'simple',
      merge: { state: 'failed', command: 'test ! -e BROKEN' },
    })
    expect(fix.task.assignee).toBeUndefined()
    // Work that fails main's checks is a setback: the fix may run on a stronger model.
    expect(fix.task.setbacks).toBe(1)
    expect(original).toMatchObject({ id: 'a', rev: 3, task: { state: 'done', merge: { state: 'failed', fix: fix.id } } })
    expect(events.map(e => e.kind)).toEqual(['task_created', 'merge_failed'])
    // The task waits for its fix, which is not finished: nothing is ready.
    const after = poolWith([item('a', original.task), item(fix.id, fix.task)])
    expect(mergeQueue(after)).toEqual([])
  })

  test('once its fix is merged, the task it fixes is merged too, through a fix of the fix', async () => {
    const repos = fresh()
    pushBranch(repos.ana, 'pool/a', { 'a.txt': 'fixed\n' })
    const state = poolWith([
      item('a', finished('A', { merge: { state: 'failed', at: 'then', command: 'bun test', fix: 'fix1' } })),
      item('fix1', finished('Fix the checks: A', { branch: 'pool/a', merge: { state: 'conflict', at: 'then', fix: 'fix2' } })),
      item('fix2', finished('Merge conflict: Fix the checks: A', { branch: 'pool/a' })),
    ])
    const { merger: m, writes } = merger(state, repos.lead)
    expect(await m.call('pool1', state, { checks: CHECKS })).toContain('Merged pool/a into main')
    expect(writes.map(w => [w.id, w.task.merge?.state, w.task.merge?.commit])).toEqual([
      ['fix2', 'merged', originMain(repos)],
      ['fix1', 'merged', originMain(repos)],
      ['a', 'merged', originMain(repos)],
    ])
  })

  test('a task moved while it merged is left to whoever moved it', async () => {
    const repos = fresh()
    pushBranch(repos.ana, 'pool/a', { BROKEN: 'yes\n' })
    const state = poolWith([item('a', finished('A'))])
    const moved = poolWith([item('a', { ...finished('A'), state: 'in_progress' })])
    const recorded = recorder()
    const m = new PoolMerger(
      recorded.ops,
      new PoolGit(),
      () => repos.lead,
      () => moved,
    )
    expect(await m.call('pool1', state, { checks: CHECKS })).toContain('The task is in_progress now, so it stays as it is.')
    expect(recorded.writes).toEqual([])
  })

  test('a pull request leaves what depends on it waiting until skip says it is merged', async () => {
    const state = poolWith([
      item('a', finished('A', { merge: { state: 'pr', at: 'then', url: 'https://github.com/team/app/pull/7' } })),
      item('b', finished('B', { dependsOn: ['a'] })),
    ])
    const { merger: m, writes } = merger(state, root)
    expect(await m.call('pool1', state, { checks: [] })).toBe('Nothing is ready to merge: b (B) waits for a.')
    expect(await m.call('pool1', state, { task: 'a', checks: [] })).toContain('Once it is merged, pass skip')
    expect(await m.call('pool1', state, { task: 'a', checks: [], skip: true })).toBe(
      'Marked a (A) merged, without merging pool/a. Next to merge: b (B).',
    )
    expect(writes.map(w => [w.id, w.task.merge?.state])).toEqual([['a', 'merged']])
  })

  test('a main that already fails is not blamed on the task, and nothing on the board moves', async () => {
    const repos = fresh()
    pushMain(repos.ana, { BROKEN: 'yes\n' })
    pushBranch(repos.ana, 'pool/a', { 'a.txt': 'a\n' })
    const state = poolWith([item('a', finished('A'))])
    const { merger: m, writes, events } = merger(state, repos.lead)
    const said = await m.call('pool1', state, { checks: CHECKS })
    expect(said).toContain('main itself fails `test ! -e BROKEN`, without pool/a')
    expect(writes).toEqual([])
    expect(events).toEqual([{ kind: 'main_broken', taskId: 'a', text: 'test ! -e BROKEN fails on main' }])
  })

  test('what it refuses: no checks given, a task not finished or waiting, nothing to merge, no folder', async () => {
    const state = poolWith([
      item('a', finished('A')),
      item('b', finished('B', { dependsOn: ['a'] })),
      item('w', { title: 'W', state: 'in_progress', branch: 'pool/w' }),
    ])
    const { merger: m, writes } = merger(state, root)
    expect(await m.call('pool1', state, {})).toContain('Give checks')
    expect(await m.call('pool1', state, { task: 'w', checks: [] })).toBe('This task is in_progress: only finished tasks are merged.')
    expect(await m.call('pool1', state, { task: 'b', checks: [] })).toContain('It waits for a to be merged first')
    expect(await m.call('pool1', state, { task: 'nope', checks: [] })).toContain('No such task')
    const empty = poolWith([item('c', finished('C', { merge: { state: 'merged', at: 'then', commit: 'abc' } }))])
    expect(await merger(empty, root).merger.call('pool1', empty, { checks: [] })).toContain('Nothing to merge')
    expect(await merger(state, undefined).merger.call('pool1', state, { checks: [] })).toContain('folder is not known')
    expect(await m.call('pool1', state, { checks: [], skip: true })).toContain('skip takes the task named')
    expect(writes).toEqual([])
  })

  test('skip takes a task off the list without merging anything, and says so in the events', async () => {
    const state = poolWith([item('a', finished('A')), item('b', finished('B'), '2026-10-28T11:00:00Z')])
    const { merger: m, writes, events } = merger(state, root)
    expect(await m.call('pool1', state, { task: 'a', checks: [], skip: true })).toBe(
      'Marked a (A) merged, without merging pool/a. Next to merge: b (B).',
    )
    expect(writes).toEqual([{ id: 'a', rev: 3, task: { ...finished('A'), merge: { state: 'merged', at: expect.any(String) } } }])
    expect(events).toEqual([{ kind: 'merged', taskId: 'a', text: 'pool/a: marked merged without a merge' }])
  })
})
