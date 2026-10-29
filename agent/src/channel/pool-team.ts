// How the sessions of a pool work together rather than side by side (docs/pool-orchestrator.md, Working together): what a
// task waits for and what it builds on, who holds each of them and how to reach them, and the questions between sessions
// that nobody answered. Pure code: the task's brief (pool-work.ts), the orchestrator's agent (pool-orchestrator.ts) and
// the control loop (agent/src/service/pool-loop.ts) read the pool through it.

import type { PoolPostItem, PoolState } from '../../../shared/pool'
import type { PoolMessageBody, PoolTask } from '../../../shared/pool-protocol'

/** Held by a session: it can be asked. */
const ACTIVE = new Set(['assigned', 'in_progress', 'blocked'])

type Who = (account: string, session: string) => string

/**
 * The tasks it waits for whose work is not in main yet: not done, or done on a branch not merged. An open pull request
 * holds it too, until `task_merge` with `skip` marks it merged (docs/pool-orchestrator.md, Merging); a task gone from the
 * board does not. The merges follow the same order (`unmerged` in pool-merge.ts).
 */
export function waitingFor(state: Pick<PoolState, 'tasks'>, task: Pick<PoolTask, 'dependsOn'>): string[] {
  return (task.dependsOn ?? []).filter(id => {
    const dependency = state.tasks.find(item => item.id === id)?.task
    if (!dependency) return false
    if (dependency.state !== 'done') return true
    return Boolean(dependency.branch) && dependency.merge?.state !== 'merged'
  })
}

/** Where another task's work stands, for a session that needs it. */
function standing(task: PoolTask, who: Who): string {
  if (task.state === 'done') {
    if (!task.branch || task.merge?.state === 'merged') return 'done, in main'
    if (task.merge?.state === 'pr') return `done, in a pull request (${task.merge.url ?? task.branch}), not in main yet`
    return `done on ${task.branch}, not in main yet: git merge origin/${task.branch} if you need it now`
  }
  if (task.assignee && ACTIVE.has(task.state)) {
    return `${task.state.replace('_', ' ')} with ${who(task.assignee.account, task.assignee.session)} (session ${task.assignee.session})${task.branch ? `, on ${task.branch}` : ''}`
  }
  if (task.state === 'review') return `in review${task.branch ? `, on ${task.branch}` : ''}`
  return 'not started yet'
}

/**
 * What a task's brief says of the tasks around it: those it waits for or builds on, where each one stands and whose
 * session to ask, the ones that build on it, and how to work with them without waiting idle. Empty for a task alone.
 */
export function teamLines(state: Pick<PoolState, 'tasks'>, id: string, task: PoolTask, who: Who): string[] {
  const related = (ids: string[] | undefined, label: string) =>
    (ids ?? []).flatMap(other => {
      const found = state.tasks.find(item => item.id === other)?.task
      return found ? [`${label} ${other} (${found.title}): ${standing(found, who)}.`] : []
    })
  const before = [...related(task.dependsOn, 'Waits for'), ...related(task.buildsOn, 'Builds on')]
  const after = state.tasks.flatMap(item => {
    const other = item.task
    if (!other || item.id === id || !(other.dependsOn?.includes(id) || other.buildsOn?.includes(id))) return []
    const holder = other.assignee && ACTIVE.has(other.state) ? other.assignee : undefined
    return [
      `${item.id} (${other.title}) builds on this task${holder ? `, with ${who(holder.account, holder.session)} (session ${holder.session})` : ''}.`,
    ]
  })
  if (!before.length && !after.length) return []
  return [
    ...before,
    ...after,
    'Work with them, never wait idle: first build what does not need the others, against the contracts (pool_notes_read contracts). When you need something from another task (an API, a data shape, a decision), ask its session with pool_send to_session and go on meanwhile; answer the questions you get. When you change something a task builds on, tell its session.',
  ]
}

/** A message from one session to another that is still waiting for its answer. */
export interface Unanswered {
  message: PoolPostItem<PoolMessageBody>
  from: { account: string; session: string }
  to: { account: string; session: string }
  /** Since it was sent. */
  age: number
}

/**
 * Messages sent to one session by another one at least `after` ago, that the session has not answered: it wrote nothing
 * since to the asker, to the asker's area or to everyone. The orchestrator's own are left out (it follows them itself,
 * and its agent's nudges are its own too), as are those to an area or everyone, which no one session owes an answer,
 * and those to a session gone or offline.
 */
export function unanswered(state: Pick<PoolState, 'messages' | 'sessions'>, me: string, after: number, now = Date.now()): Unanswered[] {
  return state.messages.flatMap(message => {
    const to = message.body?.to?.session
    const asker = message.session
    const sent = Date.parse(message.ts)
    if (!to || !asker || asker === me || to.session === me || to.session === asker) return []
    if (!Number.isFinite(sent) || now - sent < after) return []
    if (!state.sessions.some(s => s.session === to.session && s.online)) return []
    const area = state.sessions.find(s => s.session === asker)?.profile?.area
    const answered = state.messages.some(other => {
      if (other.seq <= message.seq || other.session !== to.session) return false
      const target = other.body?.to
      return !target || target.session?.session === asker || (target.area !== undefined && target.area === area)
    })
    return answered ? [] : [{ message, from: { account: message.account, session: asker }, to, age: now - sent }]
  })
}
