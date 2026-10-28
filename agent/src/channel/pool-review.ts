// Review inside a pool (docs/pools.md): when the pool has sessions with the review area, a finished task goes to one of
// them before it counts as done. The reviewer checks out the branch, runs the tests, and accepts it or sends it back to
// its author with notes. The orchestrator can pick the reviewer itself. Claude Code and OpenCode alike.

import type { PoolSession, PoolState } from '../../../shared/pool'
import type { PoolTask } from '../../../shared/pool-protocol'
import type { PoolToolSpec } from './pool-work'

const POOL = { type: 'string', description: 'The pool, by id or name. Only needed when the session is in more than one.' } as const
const TASK = { type: 'string', description: 'The task id, as pool_tasks lists it.', required: true } as const

/** The area of the sessions that review the others' work. */
export const REVIEW_AREA = 'review'

export const REVIEW_TOOLS: PoolToolSpec[] = [
  {
    name: 'review_accept',
    description:
      'For the reviewer of a task: its branch does what the criteria say and its tests pass. The task is done; the orchestrator merges it.',
    params: {
      pool: POOL,
      task: TASK,
      notes: { type: 'string', description: 'What you checked, or anything the orchestrator should know.' },
    },
  },
  {
    name: 'review_reject',
    description: 'For the reviewer of a task: send it back to its author with what to fix. Be specific: what fails, where, and why.',
    params: { pool: POOL, task: TASK, notes: { type: 'string', description: 'What to fix.', required: true } },
  },
]

export const REVIEW_ASSIGN_TOOL: PoolToolSpec = {
  name: 'review_assign',
  description: 'For the orchestrator: choose who reviews a task that is in review, instead of the session the rules picked.',
  params: { pool: POOL, task: TASK, session: { type: 'string', description: 'The reviewing session.', required: true } },
}

/**
 * The sessions that may review a task, best first: of the review area, online, never its author nor the orchestrator.
 * The one that reviewed it before comes first, then the one with the fewest reviews waiting.
 */
export function reviewers(state: PoolState, task: Pick<PoolTask, 'assignee' | 'reviewer'>): PoolSession[] {
  const waiting = (session: string) => state.tasks.filter(t => t.task?.state === 'review' && t.task.reviewer?.session === session).length
  const leads = (s: PoolSession) => state.orchestrator?.account === s.account && state.orchestrator.session === s.session
  return state.sessions
    .filter(s => s.profile?.area === REVIEW_AREA && s.online && s.ready && s.session !== task.assignee?.session && !leads(s))
    .sort(
      (a, b) =>
        Number(b.session === task.reviewer?.session) - Number(a.session === task.reviewer?.session) ||
        waiting(a.session) - waiting(b.session) ||
        a.joinedAt.localeCompare(b.joinedAt),
    )
}

/** What the reviewer is given: the branch, the criteria, what its author said it did. */
export function reviewBrief(id: string, task: PoolTask, author: string): string {
  return [
    `Review task ${id}: ${task.title}, by ${author}.`,
    task.goal ? `Goal: ${task.goal}` : '',
    task.criteria?.length ? `Done when:\n${task.criteria.map(c => `- ${c}`).join('\n')}` : '',
    task.summary ? `Its author says:\n${task.summary}` : '',
    task.branch
      ? `Branch: ${task.branch}. Fetch it and check it out (git fetch, then git switch ${task.branch}), read the change against main, and run its tests.`
      : '',
    'Then call review_accept, or review_reject with what to fix. Change nothing on the branch yourself: its author does.',
  ]
    .filter(Boolean)
    .join('\n')
}
