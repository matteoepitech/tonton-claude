import { expect, test } from 'bun:test'
import type { PoolPostItem, PoolState, PoolTaskItem } from '../pool'
import type { PoolEventBody, PoolMessageBody, PoolTask } from '../pool-protocol'
import {
  controlCenter,
  filterControl,
  filterTimeline,
  leaderboard,
  movedTo,
  periodStart,
  statusCounts,
  talkGraph,
  timeline,
  timelineJson,
  timelineMarkdown,
} from '../pool-stats'

const ANA = 'acc_ana'
const BOB = 'acc_bob'
let seq = 0
const event = (ts: string, account: string, session: string | null, body: PoolEventBody): PoolPostItem<PoolEventBody> => ({
  id: `e${++seq}`,
  seq,
  ts,
  account,
  session,
  body,
})
const message = (ts: string, account: string, session: string | null, body: PoolMessageBody): PoolPostItem<PoolMessageBody> => ({
  id: `m${++seq}`,
  seq,
  ts,
  account,
  session,
  body,
})
const task = (id: string, value: PoolTask, by: { account: string; session: string | null }): PoolTaskItem => ({
  id,
  rev: 3,
  updatedAt: '2026-10-27T11:00:00.000Z',
  ...by,
  task: value,
})

function pool(): PoolState {
  seq = 0
  return {
    id: 'pool12345678',
    createdAt: '2026-10-26T09:00:00.000Z',
    paused: false,
    keyVersion: 1,
    info: { name: 'Hack', goal: 'Ship it' },
    members: [
      { account: BOB, role: 'member', joinedAt: '2026-10-26T09:05:00.000Z', profile: { name: 'Bob' }, publicKeys: [] },
      { account: ANA, role: 'owner', joinedAt: '2026-10-26T09:00:00.000Z', profile: { name: 'Ana' }, publicKeys: [] },
    ],
    sessions: [
      {
        account: ANA,
        session: 'ses_claude',
        joinedAt: '2026-10-26T09:10:00.000Z',
        profile: { area: 'back', tool: 'claude', machine: 'Mac', orchestrator: true },
        online: true,
        ready: true,
        status: 'working',
      },
      {
        account: BOB,
        session: 'ses_open',
        joinedAt: '2026-10-26T09:12:00.000Z',
        profile: { area: 'front', tool: 'opencode' },
        online: true,
        ready: true,
        status: 'permission',
      },
      { account: BOB, session: 'ses_gone', joinedAt: '2026-10-26T09:13:00.000Z', profile: null, online: false, ready: false, status: null },
    ],
    tasks: [
      task(
        't1',
        { title: 'Login page', state: 'done', area: 'front', assignee: { account: BOB, session: 'ses_open' } },
        { account: BOB, session: 'ses_open' },
      ),
      task(
        't2',
        { title: 'Sessions API', state: 'in_progress', area: 'back', assignee: { account: ANA, session: 'ses_claude' } },
        { account: ANA, session: null },
      ),
      task('t3', { title: 'Old task', state: 'done', assignee: { account: ANA, session: 'ses_claude' } }, { account: ANA, session: null }),
    ],
    notes: null,
    messages: [],
    events: [],
    own: { secret: null, wraps: [] },
  }
}

function busy(): PoolState {
  const state = pool()
  state.events = [
    event('2026-10-26T10:00:00.000Z', ANA, 'ses_claude', { kind: 'session', tool: 'claude', model: 'claude-opus-5-5' }),
    event('2026-10-26T10:00:01.000Z', BOB, 'ses_open', { kind: 'session', tool: 'opencode', model: 'gpt-5' }),
    // Yesterday: the old task, started by the agent and finished from the website.
    event('2026-10-26T10:10:00.000Z', ANA, 'ses_claude', { kind: 'task_moved', taskId: 't3', text: 'in_progress' }),
    event('2026-10-26T11:10:00.000Z', ANA, null, { kind: 'task_moved', taskId: 't3', text: 'In progress → Done' }),
    event('2026-10-26T20:00:00.000Z', ANA, 'ses_claude', { kind: 'usage', usage: { costUSD: 2, tokens: { input: 10_000, output: 1000 } } }),
    event('2026-10-27T08:00:00.000Z', ANA, null, { kind: 'resumed' }),
    // Today: Bob's OpenCode session does the login page in 30 minutes.
    event('2026-10-27T09:00:00.000Z', BOB, 'ses_open', { kind: 'task_moved', taskId: 't1', text: 'in_progress' }),
    event('2026-10-27T09:30:00.000Z', BOB, 'ses_open', { kind: 'task_moved', taskId: 't1', text: 'done' }),
    event('2026-10-27T09:40:00.000Z', ANA, 'ses_claude', {
      kind: 'usage',
      usage: { costUSD: 5.5, tokens: { input: 40_000, output: 4000 }, fiveHour: { usedPercent: 61 } },
    }),
    event('2026-10-27T09:45:00.000Z', ANA, 'ses_claude', { kind: 'blocked', taskId: 't2', text: 'Waiting for the schema' }),
  ]
  state.messages = [
    message('2026-10-27T09:05:00.000Z', ANA, 'ses_claude', {
      text: 'The API is at /v1',
      to: { session: { account: BOB, session: 'ses_open' } },
    }),
    message('2026-10-27T09:06:00.000Z', BOB, 'ses_open', { text: 'Thanks', to: { area: 'back' } }),
    message('2026-10-27T09:07:00.000Z', ANA, 'ses_claude', { text: 'And again', to: { session: { account: BOB, session: 'ses_open' } } }),
    message('2026-10-27T09:08:00.000Z', ANA, null, { text: 'Demo at six' }),
  ]
  return state
}

test('the control center lists every member with its sessions: tool, model, status, task and usage', () => {
  const cards = controlCenter(busy())
  expect(cards.map(card => [card.name, card.role])).toEqual([
    ['Ana', 'owner'],
    ['Bob', 'member'],
  ])
  const [claude] = cards[0].sessions
  expect(claude).toMatchObject({
    tool: 'claude',
    model: 'claude-opus-5-5',
    area: 'back',
    machine: 'Mac',
    orchestrator: true,
    status: 'working',
    group: 'working',
    task: { id: 't2', title: 'Sessions API', state: 'in_progress' },
    lastActivity: '2026-10-27T09:45:00.000Z',
  })
  expect(claude.usage?.fiveHour?.usedPercent).toBe(61)
  const [open, gone] = cards[1].sessions
  expect(open).toMatchObject({ tool: 'opencode', model: 'gpt-5', group: 'needs-you', task: null })
  // No session event from an older agent, no status from an older relay: the profile and "offline" still say something.
  expect(gone).toMatchObject({ tool: 'claude', group: 'offline', model: undefined, usage: null })
  expect(statusCounts(cards)).toEqual({ working: 1, 'needs-you': 1, idle: 0, offline: 1 })
})

test('the control center filters by role, member and status', () => {
  const cards = controlCenter(busy())
  expect(filterControl(cards, { role: 'member' }).map(card => card.name)).toEqual(['Bob'])
  expect(filterControl(cards, { account: ANA }).map(card => card.name)).toEqual(['Ana'])
  const needsYou = filterControl(cards, { group: 'needs-you' })
  expect(needsYou.map(card => [card.name, card.sessions.map(s => s.session)])).toEqual([['Bob', ['ses_open']]])
})

test('who talks to whom: one edge per pair, counted, with areas, everyone and members writing from the website', () => {
  const { nodes, edges } = talkGraph(busy())
  expect(nodes.map(node => node.kind).sort()).toEqual(['area', 'everyone', 'member', 'session', 'session', 'session'])
  expect(edges).toContainEqual({ from: `s:${ANA}/ses_claude`, to: `s:${BOB}/ses_open`, count: 2 })
  expect(edges).toContainEqual({ from: `s:${BOB}/ses_open`, to: 'a:back', count: 1 })
  expect(edges).toContainEqual({ from: `m:${ANA}`, to: 'everyone', count: 1 })
  expect(edges).toHaveLength(3)
})

test('the activity puts joins, events and messages in order, without the usage readings', () => {
  const items = timeline(busy())
  expect(items[0]).toMatchObject({ kind: 'member_joined', who: 'Ana' })
  expect(items.map(item => item.at)).toEqual([...items.map(item => item.at)].sort())
  expect(items.some(item => item.kind === 'usage')).toBe(false)
  expect(items.find(item => item.kind === 'blocked')).toMatchObject({ label: 'Blocked', taskTitle: 'Sessions API', who: 'Ana · back' })
  expect(items.find(item => item.text === 'Thanks')).toMatchObject({ kind: 'message', to: 'every back session' })
  expect(items.find(item => item.kind === 'session' && item.account === BOB)?.text).toBe('OpenCode · gpt-5')
  expect(items.find(item => item.kind === 'resumed')?.label).toBe('Resumed the pool')
})

test('the activity searches and filters, and exports as JSON and Markdown', () => {
  const items = timeline(busy())
  expect(filterTimeline(items, { query: 'SCHEMA' }).map(item => item.kind)).toEqual(['blocked'])
  expect(filterTimeline(items, { query: 'login' }).every(item => item.taskTitle === 'Login page')).toBe(true)
  expect(filterTimeline(items, { kind: 'message', account: ANA })).toHaveLength(3)
  expect(filterTimeline(items, { session: `${BOB}/ses_open`, kind: 'message' }).map(item => item.text)).toEqual(['Thanks'])
  expect(JSON.parse(timelineJson(items))).toHaveLength(items.length)
  const markdown = timelineMarkdown(filterTimeline(items, { kind: 'message' }), 'Hack')
  expect(markdown).toStartWith('# Hack\n')
  expect(markdown).toContain('**Ana · back** · Message → Bob · front: The API is at /v1')
})

test('tasks moved by agents and by the website both say where they went', () => {
  expect(movedTo({ kind: 'task_moved', text: 'done' })).toBe('done')
  expect(movedTo({ kind: 'task_moved', text: 'To do → In progress' })).toBe('in_progress')
  expect(movedTo({ kind: 'blocked', text: 'No schema' })).toBe('blocked')
  expect(movedTo({ kind: 'task_moved', text: 'A summary' })).toBeNull()
  expect(movedTo({ kind: 'merged' })).toBeNull()
})

test('the leaderboard counts tasks done, time and spending per session and per member, by period', () => {
  const state = busy()
  const now = new Date('2026-10-27T12:00:00.000Z')
  const today = leaderboard(state, 'today', now)
  const open = today.sessions.find(row => row.session === 'ses_open')
  expect(open).toMatchObject({ tasksDone: 1, secondsWorked: 1800, tool: 'opencode' })
  expect(today.sessions[0].session).toBe('ses_open')
  const claudeToday = today.sessions.find(row => row.session === 'ses_claude')
  // Today's share of a running total: 5.50 less the 2.00 spent before midnight.
  expect(claudeToday).toMatchObject({ tasksDone: 0, costUSD: 3.5, tokens: 33_000 })

  const all = leaderboard(state, 'all', now)
  // The old task was finished from the website: it counts for the session it was assigned to.
  expect(all.sessions.find(row => row.session === 'ses_claude')).toMatchObject({
    tasksDone: 1,
    secondsWorked: 3600,
    costUSD: 5.5,
    tokens: 44_000,
  })
  expect(all.members.map(row => [row.name, row.tasksDone])).toEqual([
    ['Ana', 1],
    ['Bob', 1],
  ])
  // This run started when the pool was resumed this morning.
  expect(periodStart(state, 'run', now)).toBe('2026-10-27T08:00:00.000Z')
  expect(leaderboard(state, 'run', now).members.find(row => row.name === 'Ana')?.tasksDone).toBe(0)
  expect(periodStart(pool(), 'run', now)).toBe('2026-10-26T09:00:00.000Z')
})
