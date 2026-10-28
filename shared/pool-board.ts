// What a pool page shows and allows, without the DOM: the task board's columns, what each role may do (the same rules
// the relay enforces, so a button is never offered for something it would refuse), a task's history from the events,
// and the names members and sessions go by. The website renders it (web/pools.ts, web/tasks.ts).

import type { PoolMember, PoolPostItem, PoolSession, PoolState, PoolTaskItem } from './pool'
import type { PoolEventBody, PoolRole, PoolTask, PoolTaskState } from './pool-protocol'

/** The board's columns, left to right. */
export const BOARD_COLUMNS: readonly { state: PoolTaskState; label: string }[] = [
  { state: 'todo', label: 'To do' },
  { state: 'assigned', label: 'Assigned' },
  { state: 'in_progress', label: 'In progress' },
  { state: 'review', label: 'In review' },
  { state: 'done', label: 'Done' },
  { state: 'blocked', label: 'Blocked' },
]

export const TASK_STATE_LABELS: Record<PoolTaskState, string> = Object.fromEntries(
  BOARD_COLUMNS.map(column => [column.state, column.label]),
) as Record<PoolTaskState, string>

export interface Board {
  columns: { state: PoolTaskState; label: string; tasks: PoolTaskItem[] }[]
  /** Tasks that do not open with the keys this member holds, or that another member sealed with a wrong shape. */
  unreadable: PoolTaskItem[]
}

/** The tasks in their columns, the latest changed first in each. */
export function board(tasks: readonly PoolTaskItem[]): Board {
  const newest = (a: PoolTaskItem, b: PoolTaskItem) => b.updatedAt.localeCompare(a.updatedAt)
  return {
    columns: BOARD_COLUMNS.map(column => ({
      ...column,
      tasks: tasks.filter(item => item.task?.state === column.state).sort(newest),
    })),
    unreadable: tasks.filter(item => !item.task),
  }
}

// MARK: What a role may do

export interface PoolAbilities {
  /** Change the name and goal. */
  editInfo: boolean
  invite: boolean
  /** Invite as admin, hand the pool over, change admins. */
  manageAdmins: boolean
  /** Create, edit and move tasks, edit the notes, write messages. */
  write: boolean
  /** Kick members and viewers (admins), or anyone but itself (owner); rotate the key. */
  kick: boolean
  /** Make a pool session the orchestrator, or none. */
  chooseOrchestrator: boolean
  /** The owner deletes; everyone else leaves. */
  remove: boolean
  leave: boolean
}

export function poolAbilities(role: PoolRole): PoolAbilities {
  const lead = role === 'owner' || role === 'admin'
  return {
    editInfo: lead,
    invite: lead,
    manageAdmins: role === 'owner',
    write: role !== 'viewer',
    kick: lead,
    chooseOrchestrator: lead,
    remove: role === 'owner',
    leave: role !== 'owner',
  }
}

/** The roles `actor` may give `target`, nothing when it may not change it (as in relay/src/pool-routes.ts). */
export function assignableRoles(actor: PoolRole, target: PoolRole, isSelf: boolean): Exclude<PoolRole, 'owner'>[] {
  if (isSelf || target === 'owner') return []
  if (actor === 'owner') return ['admin', 'member', 'viewer']
  if (actor === 'admin' && target !== 'admin') return ['member', 'viewer']
  return []
}

export function canKick(actor: PoolRole, target: PoolRole, isSelf: boolean): boolean {
  if (isSelf || target === 'owner') return false
  return actor === 'owner' || (actor === 'admin' && target !== 'admin')
}

/** The roles an invite may give: only the owner invites admins. */
export const invitableRoles = (actor: PoolRole): Exclude<PoolRole, 'owner'>[] =>
  actor === 'owner' ? ['member', 'viewer', 'admin'] : actor === 'admin' ? ['member', 'viewer'] : []

// MARK: Names

/** A member's name, else the start of its account id. */
export function memberName(state: Pick<PoolState, 'members'>, account: string): string {
  return state.members.find(member => member.account === account)?.profile?.name || `Member ${account.slice(0, 6)}`
}

/** "Ana · back", or the session's project, or the start of its id. */
export function sessionName(state: Pick<PoolState, 'members' | 'sessions'>, ref: { account: string; session: string }): string {
  const session = state.sessions.find(s => s.account === ref.account && s.session === ref.session)
  const what = session?.profile?.area || session?.profile?.project || ref.session.slice(0, 8)
  return `${memberName(state, ref.account)} · ${what}`
}

/** The members, owner first, then by role, then by name. */
export function sortedMembers(state: Pick<PoolState, 'members'>): PoolMember[] {
  const rank: Record<PoolRole, number> = { owner: 0, admin: 1, member: 2, viewer: 3 }
  return [...state.members].sort(
    (a, b) => rank[a.role] - rank[b.role] || (a.profile?.name ?? a.account).localeCompare(b.profile?.name ?? b.account),
  )
}

/** The sessions a task can go to: those whose agent holds the pool key. */
export const assignableSessions = (state: Pick<PoolState, 'sessions'>): PoolSession[] => state.sessions.filter(session => session.ready)

// MARK: Tasks

export interface TaskDraft {
  title: string
  goal: string
  /** One criterion per line. */
  criteria: string
  area: string
  state: PoolTaskState
  /** `account/session`, or empty. */
  assignee: string
  /** Task ids, separated by commas or spaces. */
  dependsOn: string
  branch: string
  summary: string
}

/** The form's fields for a task, empty for a new one. */
export function draftOf(task: PoolTask | null): TaskDraft {
  return {
    title: task?.title ?? '',
    goal: task?.goal ?? '',
    criteria: (task?.criteria ?? []).join('\n'),
    area: task?.area ?? '',
    state: task?.state ?? 'todo',
    assignee: task?.assignee ? `${task.assignee.account}/${task.assignee.session}` : '',
    dependsOn: (task?.dependsOn ?? []).join(', '),
    branch: task?.branch ?? '',
    summary: task?.summary ?? '',
  }
}

/** The task a form describes, null without a title. Empty fields are left out, as the agent's tools leave them. */
export function taskOf(draft: TaskDraft): PoolTask | null {
  const title = draft.title.trim()
  if (!title) return null
  const [account, session] = draft.assignee.split('/')
  const criteria = draft.criteria
    .split('\n')
    .map(line => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean)
  const dependsOn = draft.dependsOn.split(/[\s,]+/).filter(Boolean)
  const task: PoolTask = { title, state: draft.state }
  if (draft.goal.trim()) task.goal = draft.goal.trim()
  if (criteria.length) task.criteria = criteria
  if (draft.area.trim()) task.area = draft.area.trim()
  if (account && session) task.assignee = { account, session }
  if (dependsOn.length) task.dependsOn = dependsOn
  if (draft.branch.trim()) task.branch = draft.branch.trim()
  if (draft.summary.trim()) task.summary = draft.summary.trim()
  return task
}

/** The same task in another column. A task moved back to "to do" loses its assignee. */
export function moved(task: PoolTask, state: PoolTaskState): PoolTask {
  const next: PoolTask = { ...task, state }
  if (state === 'todo') delete next.assignee
  return next
}

/** What a change to a task says in the pool's events, for its history and the activity page. */
export function taskEvent(before: PoolTask | null, after: PoolTask, taskId: string): PoolEventBody {
  if (!before) return { kind: 'task_created', taskId, text: after.title }
  if (before.state !== after.state)
    return { kind: 'task_moved', taskId, text: `${TASK_STATE_LABELS[before.state]} → ${TASK_STATE_LABELS[after.state]}` }
  return { kind: 'task_edited', taskId, text: after.title }
}

/** The events about one task, oldest first. */
export const taskHistory = (events: readonly PoolPostItem<PoolEventBody>[], taskId: string): PoolPostItem<PoolEventBody>[] =>
  events.filter(event => event.body?.taskId === taskId).sort((a, b) => a.seq - b.seq)

/** Ids of the tasks a task waits for that are not done yet. */
export function waitingOn(tasks: readonly PoolTaskItem[], task: PoolTask): string[] {
  return (task.dependsOn ?? []).filter(id => tasks.find(item => item.id === id)?.task?.state !== 'done')
}
