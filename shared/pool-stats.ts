// What the pool's control center, activity and leaderboard show, worked out from the pool's state as a member's client
// opened it (shared/pool.ts): who is in it and on what, who talked to whom, everything that happened in order, and who
// got the most done. Pure functions over the state, so every client computes the same thing.

import type { PoolMember, PoolPostItem, PoolSession, PoolState } from './pool'
import { memberName, sessionName, TASK_STATE_LABELS } from './pool-board'
import type { PoolEventBody, PoolMessageBody, PoolRole, PoolTaskState, PoolUsage } from './pool-protocol'
import type { SessionStatus } from './protocol'

// MARK: Control center

/** How the control center groups a session's status, and filters by it. */
export type StatusGroup = 'working' | 'needs-you' | 'idle' | 'offline'

export interface SessionCard {
  account: string
  session: string
  name: string
  machine?: string
  area?: string
  tool: 'claude' | 'opencode'
  model?: string
  orchestrator: boolean
  online: boolean
  ready: boolean
  /** As the relay sees it; null from older relays. */
  status: SessionStatus | null
  group: StatusGroup
  /** What it works on: in progress first, then assigned, in review, blocked. */
  task: { id: string; title: string; state: PoolTaskState } | null
  /** The last thing it wrote to the pool or moved, ISO. */
  lastActivity: string | null
  /** As its agent last shared it. */
  usage: PoolUsage | null
}

export interface MemberCard {
  account: string
  name: string
  role: PoolRole
  joinedAt: string
  sessions: SessionCard[]
}

const TASK_ORDER: readonly PoolTaskState[] = ['in_progress', 'assigned', 'review', 'blocked']
const ROLE_ORDER: readonly PoolRole[] = ['owner', 'admin', 'member', 'viewer']

export function statusGroup(online: boolean, status: SessionStatus | null): StatusGroup {
  if (!online || status === 'offline' || status === 'ended') return 'offline'
  if (status === 'working' || status === 'starting') return 'working'
  if (status === 'waiting' || status === 'permission' || status === 'error') return 'needs-you'
  return 'idle'
}

/** The latest event of a kind from a session, newest last in the state. */
function latestFrom(events: readonly PoolPostItem<PoolEventBody>[], kind: string, account: string, session: string) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.body?.kind === kind && event.account === account && event.session === session) return event
  }
  return null
}

const later = (a: string | null, b: string | null | undefined): string | null => (!b ? a : !a || b > a ? b : a)

function sessionCard(state: PoolState, session: PoolSession): SessionCard {
  const { account } = session
  const described = latestFrom(state.events, 'session', account, session.session)
  const usage = latestFrom(state.events, 'usage', account, session.session)?.body?.usage ?? null
  const mine = state.tasks.filter(item => item.task?.assignee?.account === account && item.task.assignee.session === session.session)
  let task: SessionCard['task'] = null
  for (const wanted of TASK_ORDER) {
    const found = mine.find(item => item.task?.state === wanted)
    if (found?.task) {
      task = { id: found.id, title: found.task.title, state: found.task.state }
      break
    }
  }
  let lastActivity: string | null = null
  for (const post of [...state.events, ...state.messages]) {
    if (post.account === account && post.session === session.session && post.body) lastActivity = later(lastActivity, post.ts)
  }
  for (const item of state.tasks)
    if (item.account === account && item.session === session.session) lastActivity = later(lastActivity, item.updatedAt)
  return {
    account,
    session: session.session,
    name: sessionName(state, session),
    machine: session.profile?.machine,
    area: session.profile?.area,
    tool: described?.body?.tool ?? session.profile?.tool ?? 'claude',
    model: described?.body?.model,
    orchestrator: session.profile?.orchestrator === true,
    online: session.online,
    ready: session.ready,
    status: session.status,
    group: statusGroup(session.online, session.status),
    task,
    lastActivity,
    usage,
  }
}

/** Every member with its pool sessions: owners first, then by name. */
export function controlCenter(state: PoolState): MemberCard[] {
  const byAccount = new Map<string, PoolSession[]>()
  for (const session of state.sessions) byAccount.set(session.account, [...(byAccount.get(session.account) ?? []), session])
  return [...state.members]
    .sort(
      (a, b) =>
        ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || memberName(state, a.account).localeCompare(memberName(state, b.account)),
    )
    .map((member: PoolMember) => ({
      account: member.account,
      name: memberName(state, member.account),
      role: member.role,
      joinedAt: member.joinedAt,
      sessions: (byAccount.get(member.account) ?? []).map(session => sessionCard(state, session)),
    }))
}

export interface ControlFilter {
  role?: PoolRole
  account?: string
  group?: StatusGroup
}

/** Members whose role and account match, with only their sessions of that status. A status filter hides members left with none. */
export function filterControl(cards: readonly MemberCard[], filter: ControlFilter): MemberCard[] {
  return cards
    .filter(card => (!filter.role || card.role === filter.role) && (!filter.account || card.account === filter.account))
    .map(card => (filter.group ? { ...card, sessions: card.sessions.filter(session => session.group === filter.group) } : card))
    .filter(card => !filter.group || card.sessions.length > 0)
}

/** How many sessions are in each status group. */
export function statusCounts(cards: readonly MemberCard[]): Record<StatusGroup, number> {
  const counts: Record<StatusGroup, number> = { working: 0, 'needs-you': 0, idle: 0, offline: 0 }
  for (const card of cards) for (const session of card.sessions) counts[session.group]++
  return counts
}

// MARK: Who talks to whom

export interface TalkNode {
  id: string
  label: string
  /** A pool session, a member writing from an app or the website, every session of an area, or everyone. */
  kind: 'session' | 'member' | 'area' | 'everyone'
}

export interface TalkEdge {
  from: string
  to: string
  count: number
}

const sessionNode = (account: string, session: string) => `s:${account}/${session}`

/** Every pool session, and whoever wrote or was written to, with the number of messages between each pair. */
export function talkGraph(state: PoolState): { nodes: TalkNode[]; edges: TalkEdge[] } {
  const nodes = new Map<string, TalkNode>()
  for (const session of state.sessions) {
    nodes.set(sessionNode(session.account, session.session), {
      id: sessionNode(session.account, session.session),
      label: sessionName(state, session),
      kind: 'session',
    })
  }
  const counts = new Map<string, TalkEdge>()
  for (const message of state.messages) {
    if (!message.body) continue
    const from = message.session ? sessionNode(message.account, message.session) : `m:${message.account}`
    if (!nodes.has(from)) {
      const label = message.session
        ? sessionName(state, { account: message.account, session: message.session })
        : memberName(state, message.account)
      nodes.set(from, { id: from, label, kind: message.session ? 'session' : 'member' })
    }
    const to = message.body.to
    let target: string
    if (to?.session) {
      target = sessionNode(to.session.account, to.session.session)
      if (!nodes.has(target)) nodes.set(target, { id: target, label: sessionName(state, to.session), kind: 'session' })
    } else if (to?.area) {
      target = `a:${to.area}`
      if (!nodes.has(target)) nodes.set(target, { id: target, label: `All ${to.area}`, kind: 'area' })
    } else {
      target = 'everyone'
      if (!nodes.has(target)) nodes.set(target, { id: target, label: 'Everyone', kind: 'everyone' })
    }
    const key = `${from}→${target}`
    const edge = counts.get(key) ?? { from, to: target, count: 0 }
    edge.count++
    counts.set(key, edge)
  }
  return { nodes: [...nodes.values()], edges: [...counts.values()] }
}

// MARK: Activity

export interface TimelineItem {
  id: string
  /** ISO time. */
  at: string
  kind: string
  label: string
  account: string
  session: string | null
  /** Who did it, as the pool names them. */
  who: string
  text?: string
  taskId?: string
  taskTitle?: string
  /** Messages: who it was for. */
  to?: string
}

/** What each kind of event reads as. Others read as their kind, words apart. */
const EVENT_LABELS: Record<string, string> = {
  member_joined: 'Joined the pool',
  session_joined: 'Put a session in the pool',
  message: 'Message',
  session: 'Runs on',
  task_created: 'Created a task',
  task_moved: 'Moved a task',
  task_edited: 'Edited a task',
  blocked: 'Blocked',
  merged: 'Merged',
  joined: 'Joined',
  left: 'Left',
  kicked: 'Removed a member',
  key_rotated: 'Rotated the pool key',
  role_changed: 'Changed a role',
  owner_changed: 'Handed the pool over',
  paused: 'Paused the pool',
  resumed: 'Resumed the pool',
  stopped: 'Stopped work',
  budget: 'Changed a budget',
  rules: 'Proposed rules',
}

/** Kinds kept out of the activity: they say how a session is doing, not what happened. */
const QUIET_KINDS = new Set(['usage'])

export const eventLabel = (kind: string): string => EVENT_LABELS[kind] ?? kind.replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase())

function recipient(state: PoolState, to: PoolMessageBody['to']): string {
  if (to?.session) return sessionName(state, to.session)
  if (to?.area) return `every ${to.area} session`
  return 'everyone'
}

const author = (state: PoolState, account: string, session: string | null) =>
  session ? sessionName(state, { account, session }) : memberName(state, account)

/** Everything that happened in the pool, oldest first: joins, messages and events. */
export function timeline(state: PoolState): TimelineItem[] {
  const titles = new Map(state.tasks.map(item => [item.id, item.task?.title]))
  const items: (TimelineItem & { order: number })[] = []
  for (const member of state.members) {
    items.push({
      id: `member:${member.account}`,
      at: member.joinedAt,
      kind: 'member_joined',
      label: eventLabel('member_joined'),
      account: member.account,
      session: null,
      who: memberName(state, member.account),
      order: 0,
    })
  }
  for (const session of state.sessions) {
    items.push({
      id: `session:${session.account}/${session.session}`,
      at: session.joinedAt,
      kind: 'session_joined',
      label: eventLabel('session_joined'),
      account: session.account,
      session: session.session,
      who: sessionName(state, session),
      text: [session.profile?.area, session.profile?.tool === 'opencode' ? 'OpenCode' : 'Claude Code'].filter(Boolean).join(' · '),
      order: 1,
    })
  }
  for (const event of state.events) {
    const body = event.body
    if (!body || QUIET_KINDS.has(body.kind)) continue
    const text =
      body.kind === 'session' ? [body.tool === 'opencode' ? 'OpenCode' : 'Claude Code', body.model].filter(Boolean).join(' · ') : body.text
    items.push({
      id: `event:${event.id}`,
      at: event.ts,
      kind: body.kind,
      label: eventLabel(body.kind),
      account: event.account,
      session: event.session,
      who: author(state, event.account, event.session),
      ...(text ? { text } : {}),
      ...(body.taskId ? { taskId: body.taskId } : {}),
      ...(body.taskId && titles.get(body.taskId) ? { taskTitle: titles.get(body.taskId) } : {}),
      order: 2 + event.seq,
    })
  }
  for (const message of state.messages) {
    if (!message.body) continue
    items.push({
      id: `message:${message.id}`,
      at: message.ts,
      kind: 'message',
      label: eventLabel('message'),
      account: message.account,
      session: message.session,
      who: author(state, message.account, message.session),
      text: message.body.text,
      to: recipient(state, message.body.to),
      order: 2 + message.seq,
    })
  }
  return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order)).map(({ order: _order, ...item }) => item)
}

export interface TimelineFilter {
  /** Matches what was said, who said it, the task and the kind. Any case. */
  query?: string
  account?: string
  /** `account/session`. */
  session?: string
  kind?: string
}

export function filterTimeline(items: readonly TimelineItem[], filter: TimelineFilter): TimelineItem[] {
  const query = filter.query?.trim().toLowerCase()
  return items.filter(item => {
    if (filter.account && item.account !== filter.account) return false
    if (filter.session && `${item.account}/${item.session ?? ''}` !== filter.session) return false
    if (filter.kind && item.kind !== filter.kind) return false
    if (!query) return true
    return [item.label, item.who, item.text, item.taskTitle, item.to, item.kind].some(part => part?.toLowerCase().includes(query))
  })
}

export const timelineJson = (items: readonly TimelineItem[]): string => `${JSON.stringify(items, null, 2)}\n`

/** One line per item, for a pull request or a retrospective. What members wrote stays as they wrote it. */
export function timelineMarkdown(items: readonly TimelineItem[], title: string): string {
  const lines = [`# ${title}`, '']
  for (const item of items) {
    const task = item.taskTitle ? ` (${item.taskTitle})` : item.taskId ? ` (task ${item.taskId})` : ''
    const to = item.to ? ` → ${item.to}` : ''
    const text = item.text ? `: ${item.text.replace(/\s*\n\s*/g, ' ')}` : ''
    lines.push(`- ${item.at} · **${item.who}** · ${item.label}${task}${to}${text}`)
  }
  return `${lines.join('\n')}\n`
}

// MARK: Leaderboard

export type LeaderPeriod = 'today' | 'run' | 'all'

export interface LeaderRow {
  key: string
  name: string
  account: string
  session?: string
  tool?: 'claude' | 'opencode'
  tasksDone: number
  /** From each finished task's start to its end. */
  secondsWorked: number
  costUSD?: number
  tokens?: number
}

/** Events that start a new run of the pool, for "this run". */
const RUN_STARTS = new Set(['resumed', 'started', 'run_started'])

/** Where a period begins, ISO; empty for all time. Today starts at the viewer's midnight. */
export function periodStart(state: PoolState, period: LeaderPeriod, now: Date): string {
  if (period === 'all') return ''
  if (period === 'today') {
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    return midnight.toISOString()
  }
  let start = state.createdAt
  for (const event of state.events) if (event.body && RUN_STARTS.has(event.body.kind) && event.ts > start) start = event.ts
  return start
}

const LABEL_STATES = new Map(Object.entries(TASK_STATE_LABELS).map(([state, label]) => [label.toLowerCase(), state as PoolTaskState]))

/** The state a `task_moved` event moved its task to: agents write the state, the website writes "To do → Done". */
export function movedTo(body: PoolEventBody | null): PoolTaskState | null {
  if (!body || (body.kind !== 'task_moved' && body.kind !== 'blocked')) return null
  if (body.kind === 'blocked') return 'blocked'
  const text = body.text?.trim() ?? ''
  if (text in TASK_STATE_LABELS) return text as PoolTaskState
  const after = text.split('→').at(-1)?.trim().toLowerCase() ?? ''
  return LABEL_STATES.get(after) ?? null
}

/** What sessions and members did in the period: the most tasks done first, then the most time. */
export function leaderboard(state: PoolState, period: LeaderPeriod, now = new Date()): { sessions: LeaderRow[]; members: LeaderRow[] } {
  const start = periodStart(state, period, now)
  const rows = new Map<string, LeaderRow>()
  const row = (account: string, session: string): LeaderRow => {
    const key = `${account}/${session}`
    let found = rows.get(key)
    if (!found) {
      const known = state.sessions.find(s => s.account === account && s.session === session)
      found = {
        key,
        name: sessionName(state, { account, session }),
        account,
        session,
        tool: latestFrom(state.events, 'session', account, session)?.body?.tool ?? known?.profile?.tool ?? 'claude',
        tasksDone: 0,
        secondsWorked: 0,
      }
      rows.set(key, found)
    }
    return found
  }
  for (const session of state.sessions) row(session.account, session.session)

  // Each task counts once, for whoever had it when it was done last in the period.
  const ordered = [...state.events].sort((a, b) => a.seq - b.seq)
  const started = new Map<string, string>()
  const done = new Map<string, { at: string; account: string; session: string | null; startedAt?: string }>()
  for (const event of ordered) {
    const target = movedTo(event.body)
    const taskId = event.body?.taskId
    if (!target || !taskId) continue
    if (target === 'in_progress' && !started.has(taskId)) started.set(taskId, event.ts)
    if (target === 'done' && event.ts >= start)
      done.set(taskId, { at: event.ts, account: event.account, session: event.session, startedAt: started.get(taskId) })
  }
  for (const [taskId, finished] of done) {
    const assignee = state.tasks.find(item => item.id === taskId)?.task?.assignee
    const account = assignee?.account ?? finished.account
    const session = assignee?.session ?? finished.session
    if (!session) continue
    const credited = row(account, session)
    credited.tasksDone++
    if (finished.startedAt) credited.secondsWorked += Math.max(0, (Date.parse(finished.at) - Date.parse(finished.startedAt)) / 1000)
  }

  // Spending is a running total per session: the period's share is the latest reading less the one before it began.
  for (const current of rows.values()) {
    let before: PoolUsage | undefined
    let latest: PoolUsage | undefined
    for (const event of ordered) {
      if (event.body?.kind !== 'usage' || event.account !== current.account || event.session !== current.session || !event.body.usage)
        continue
      if (start && event.ts < start) before = event.body.usage
      else latest = event.body.usage
    }
    if (!latest) continue
    if (latest.costUSD !== undefined) current.costUSD = Math.max(0, latest.costUSD - (before?.costUSD ?? 0))
    if (latest.tokens) {
      const total = latest.tokens.input + latest.tokens.output
      const earlier = before?.tokens ? before.tokens.input + before.tokens.output : 0
      current.tokens = Math.max(0, total - earlier)
    }
  }

  const rank = (a: LeaderRow, b: LeaderRow) =>
    b.tasksDone - a.tasksDone || b.secondsWorked - a.secondsWorked || (b.costUSD ?? 0) - (a.costUSD ?? 0) || a.name.localeCompare(b.name)
  const sessions = [...rows.values()].sort(rank)
  const members = new Map<string, LeaderRow>()
  for (const member of state.members) {
    members.set(member.account, {
      key: member.account,
      name: memberName(state, member.account),
      account: member.account,
      tasksDone: 0,
      secondsWorked: 0,
    })
  }
  for (const session of sessions) {
    const member = members.get(session.account) ?? {
      key: session.account,
      name: memberName(state, session.account),
      account: session.account,
      tasksDone: 0,
      secondsWorked: 0,
    }
    member.tasksDone += session.tasksDone
    member.secondsWorked += session.secondsWorked
    if (session.costUSD !== undefined) member.costUSD = (member.costUSD ?? 0) + session.costUSD
    if (session.tokens !== undefined) member.tokens = (member.tokens ?? 0) + session.tokens
    members.set(session.account, member)
  }
  return { sessions, members: [...members.values()].sort(rank) }
}
