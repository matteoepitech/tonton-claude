// The orchestrator's side of a pool (docs/pools.md, docs/pool-orchestrator.md): the session an owner or an admin made the
// pool's orchestrator plans the project in the shared notes, writes feature-sized tasks and hands each one to the session
// that fits it, by area and by what it takes: simple, well-bounded tasks to OpenCode sessions first, the features to
// Claude Code sessions, as each session's owner may override. Its agent also watches the pool and tells it when to
// re-plan: a task blocked or finished, a session gone, a task that stopped moving. Claude Code and OpenCode alike.

import { newPoolItemId, type PoolSession, type PoolState, type PoolTaskItem } from '../../../shared/pool'
import type { PoolArea, PoolNotes, PoolNotesSection, PoolTask, PoolTaskSize } from '../../../shared/pool-protocol'
import type { PoolToolSpec, SessionDescription } from './pool-work'

const POOL = { type: 'string', description: 'The pool, by id or name. Only needed when the session is in more than one.' } as const

export const ORCHESTRATOR_TOOLS: PoolToolSpec[] = [
  {
    name: 'pool_overview',
    description:
      'For the orchestrator: every session with its member, area, coding tool, model, the kind of task it takes, whether it is free, and its task; the blocked, waiting and stalled tasks.',
    params: { pool: POOL },
  },
  {
    name: 'plan_create',
    description:
      'For the orchestrator: write the plan in the shared notes before any task. Contracts first (API routes, data shapes, folder layout), then the areas with the paths each one owns.',
    params: {
      pool: POOL,
      goal: { type: 'string', description: 'What the pool builds, in a few sentences.', required: true },
      contracts: { type: 'string', description: 'The API routes, data shapes and folder layout every session follows.', required: true },
      stack: { type: 'string', description: 'Languages, frameworks, how to run and test it.' },
      decisions: { type: 'string', description: 'Choices already made, so nobody makes them again.' },
      areas: {
        type: 'array',
        description: 'One entry per area: its name, a colon, then the paths it owns. Example: "front: web/, app/ui".',
      },
    },
  },
  {
    name: 'task_create',
    description:
      'For the orchestrator: a task one session owns from start to end. A feature or an area with criteria, never a single step. It gets its own branch.',
    params: {
      pool: POOL,
      title: { type: 'string', description: 'What to build, in a few words.', required: true },
      goal: { type: 'string', description: 'What it is for and what it covers.', required: true },
      criteria: { type: 'array', description: 'What "done" means: one check per entry.', required: true },
      area: { type: 'string', description: 'The area it belongs to, as the plan names them.' },
      size: {
        type: 'string',
        description: 'small: tests, docs, small fixes, boilerplate, a page following a pattern. large (default): a feature.',
      },
      depends_on: { type: 'array', description: 'Ids of the tasks it waits for.' },
      paths: { type: 'array', description: "The files and folders it works in. Default: its area's paths." },
      assign: { type: 'string', description: 'auto, to hand it out at once, or a session id. Missing: it stays to do.' },
    },
  },
  {
    name: 'task_assign',
    description:
      'For the orchestrator: hand a task that is to do to a session, or let the rules pick one (free, right area, the kind of task it takes).',
    params: {
      pool: POOL,
      task: { type: 'string', description: 'The task id.', required: true },
      session: { type: 'string', description: 'A session id. Missing: the best free session.' },
      force: { type: 'boolean', description: 'Hand it out even against the rules (waiting tasks, a busy session, the wrong kind).' },
    },
  },
  {
    name: 'task_reassign',
    description:
      'For the orchestrator: move a task from its session to another one, when it is blocked, stalled or its session left. The first session is told to stop.',
    params: {
      pool: POOL,
      task: { type: 'string', description: 'The task id.', required: true },
      session: { type: 'string', description: 'The new session. Missing: the best free session.' },
      reason: { type: 'string', description: 'Why, for both sessions.' },
    },
  },
]

/** What the orchestrator needs from the pool tools: sealing, posting and waiting on the relay are theirs. */
export interface PoolOps {
  /** Writes the task over revision `rev` (0 for a new one): null once the relay took it, otherwise why not. */
  putTask(poolId: string, id: string, rev: number, next: PoolTask): Promise<string | null>
  putNotes(poolId: string, rev: number, notes: PoolNotes): Promise<string | null>
  message(poolId: string, to: { account: string; session: string }, text: string): Promise<string | null>
  event(poolId: string, kind: string, taskId: string | undefined, text: string | undefined): Promise<void>
  descriptions(state: PoolState): Map<string, SessionDescription>
  who(state: PoolState, account: string, session: string | null): string
}

type Args = Record<string, unknown>

/** The kind of task a session takes: its owner's choice, else by its coding tool. */
export type SessionKind = PoolTaskSize | 'any'

/** A task is active while a session holds it. */
const ACTIVE = new Set(['assigned', 'in_progress', 'blocked'])

/** Shorter than this, with fewer criteria than two, a task is a step, not something a full session owns. */
const MIN_GOAL = 40
/** A task in progress with no change for this long makes the orchestrator look at it. */
export const STALL_MS = 30 * 60_000

// MARK: The rules, pure

export function isOrchestrator(state: PoolState, me: Pick<PoolSession, 'account' | 'session'>): boolean {
  return state.orchestrator?.account === me.account && state.orchestrator.session === me.session
}

export function sessionKind(session: PoolSession, description: SessionDescription | undefined): SessionKind {
  const takes = session.profile?.takes
  if (takes) return takes
  return (description?.tool ?? session.profile?.tool ?? 'claude') === 'opencode' ? 'small' : 'large'
}

/** Why a task is too small to hand a full session, or null. */
export function tooSmall(task: Pick<PoolTask, 'goal' | 'criteria'>): string | null {
  const goal = task.goal?.trim() ?? ''
  const criteria = task.criteria?.filter(c => c.trim()) ?? []
  if (!criteria.length) return 'Say what "done" means in criteria: at least one check.'
  if (goal.length < MIN_GOAL && criteria.length < 2) {
    return 'Too small for a pool session: each one is a full Claude Code or OpenCode session with its own context. Give it a whole feature or area, with its goal and criteria, or fold this step into a bigger task.'
  }
  return null
}

/** `pool/<id>-<slug>`: a branch of its own for every task. */
export function branchFor(id: string, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  const short = id
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 6)
    .toLowerCase()
  return `pool/${short}${slug ? `-${slug}` : ''}`
}

/** `front: web/, app/ui` → an area and its paths. */
export function parseArea(entry: string): PoolArea | null {
  const colon = entry.indexOf(':')
  const name = (colon < 0 ? entry : entry.slice(0, colon)).trim()
  if (!name) return null
  const paths =
    colon < 0
      ? []
      : entry
          .slice(colon + 1)
          .split(',')
          .map(path => path.trim())
          .filter(Boolean)
  return { name, paths }
}

export interface Candidate {
  session: PoolSession
  kind: SessionKind
  reason: string
}

/**
 * The sessions that may take a task, best first: free (no task they hold), online and ready, never the orchestrator
 * itself. A small task goes to the sessions that take small tasks first, then to the others; a large one never goes to
 * a session that only takes small tasks. Within that, a session of the task's area comes first.
 */
export function candidates(
  state: PoolState,
  task: Pick<PoolTask, 'area' | 'size'>,
  descriptions: Map<string, SessionDescription>,
  except: string[] = [],
): Candidate[] {
  const size = task.size ?? 'large'
  const busy = new Set(state.tasks.filter(t => t.task && ACTIVE.has(t.task.state)).map(t => t.task?.assignee?.session))
  const rank = (kind: SessionKind) => (size === 'small' ? { small: 0, any: 1, large: 2 }[kind] : { large: 0, any: 1, small: 9 }[kind])
  return state.sessions
    .filter(s => s.online && s.ready && !busy.has(s.session) && !isOrchestrator(state, s) && !except.includes(s.session))
    .map(session => {
      const kind = sessionKind(session, descriptions.get(`${session.account}/${session.session}`))
      return { session, kind, reason: `${kind === 'any' ? 'takes any task' : `takes ${kind} tasks`}` }
    })
    .filter(c => rank(c.kind) < 9)
    .sort((a, b) => {
      const byKind = rank(a.kind) - rank(b.kind)
      if (byKind) return byKind
      const area = (c: Candidate) => (task.area && c.session.profile?.area === task.area ? 0 : 1)
      return area(a) - area(b) || a.session.joinedAt.localeCompare(b.session.joinedAt)
    })
}

/** Why this session should not take this task, or null when it may. */
export function refusal(
  state: PoolState,
  task: PoolTask,
  session: PoolSession,
  descriptions: Map<string, SessionDescription>,
): string | null {
  if (isOrchestrator(state, session)) return 'That is the orchestrator: it plans, it does not take tasks.'
  if (!session.online || !session.ready) return 'That session is offline.'
  const holding = state.tasks.find(t => t.task?.assignee?.session === session.session && ACTIVE.has(t.task.state))
  if (holding) return `That session already works on ${holding.id} (${holding.task?.title}): one task at a time.`
  const kind = sessionKind(session, descriptions.get(`${session.account}/${session.session}`))
  if ((task.size ?? 'large') === 'large' && kind === 'small') {
    return 'That session takes small tasks only (its tool or its owner says so): give it a small task, or this one to a Claude Code session.'
  }
  return null
}

/** The tasks it waits for that are not done yet. */
export function waitingFor(state: PoolState, task: PoolTask): string[] {
  return (task.dependsOn ?? []).filter(id => state.tasks.find(t => t.id === id)?.task?.state !== 'done')
}

/** Active tasks whose paths overlap this one's: two sessions on the same files. */
export function overlapping(state: PoolState, id: string, paths: string[]): PoolTaskItem[] {
  if (!paths.length) return []
  const touches = (a: string, b: string) =>
    a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`) || b.startsWith(a.endsWith('/') ? a : `${a}/`)
  return state.tasks.filter(
    t => t.id !== id && t.task && ACTIVE.has(t.task.state) && (t.task.paths ?? []).some(p => paths.some(q => touches(p, q))),
  )
}

// MARK: The tools

export class PoolOrchestrator {
  /** Notices already given, by what they are about, so each one comes once. */
  private readonly told = new Set<string>()
  /** What each task looked like last time, per pool, to notice what changed. */
  private readonly last = new Map<string, Map<string, { state: string; session?: string; online?: boolean }>>()

  constructor(
    private readonly ops: PoolOps,
    /** Hands the orchestrator's Claude a notice from its own agent. */
    private readonly notify: (text: string) => void,
    private readonly stallMs = STALL_MS,
  ) {}

  async call(name: string, poolId: string, state: PoolState, me: PoolSession, args: Args): Promise<string> {
    if (!isOrchestrator(state, me)) {
      return "Only the pool's orchestrator plans and assigns. Its owner or an admin makes a session the orchestrator, from the app or the website."
    }
    if (name === 'pool_overview') return this.overview(state)
    if (state.paused) return 'The pool is paused: nothing can change in it until its owner resumes it.'
    switch (name) {
      case 'plan_create':
        return this.plan(poolId, state, args)
      case 'task_create':
        return this.create(poolId, state, args)
      case 'task_assign':
        return this.assign(poolId, state, args)
      case 'task_reassign':
        return this.reassign(poolId, state, args)
    }
    return `No such tool: ${name}.`
  }

  private overview(state: PoolState): string {
    const descriptions = this.ops.descriptions(state)
    const now = Date.now()
    const sessions = state.sessions.map(session => {
      const description = descriptions.get(`${session.account}/${session.session}`)
      const holding = state.tasks.find(t => t.task?.assignee?.session === session.session && ACTIVE.has(t.task.state))
      return {
        session: session.session,
        member: this.ops.who(state, session.account, session.session),
        area: session.profile?.area,
        tool: description?.tool ?? session.profile?.tool ?? 'claude',
        model: description?.model,
        takes: sessionKind(session, description),
        orchestrator: isOrchestrator(state, session) || undefined,
        online: session.online && session.ready,
        free: !holding && !isOrchestrator(state, session),
        task: holding ? { id: holding.id, title: holding.task?.title, state: holding.task?.state } : undefined,
      }
    })
    const view = (t: PoolTaskItem) => ({ id: t.id, title: t.task?.title, state: t.task?.state, size: t.task?.size ?? 'large' })
    const live = state.tasks.filter(t => t.task)
    return JSON.stringify(
      {
        pool: state.info?.name ?? state.id,
        goal: state.info?.goal,
        notes: state.notes ? { rev: state.notes.rev, sections: Object.keys(state.notes.sections ?? {}), areas: state.notes.areas } : null,
        sessions,
        todo: live.filter(t => t.task?.state === 'todo').map(t => ({ ...view(t), waitsFor: waitingFor(state, t.task as PoolTask) })),
        blocked: live.filter(t => t.task?.state === 'blocked').map(t => ({ ...view(t), why: t.task?.summary })),
        stalled: live.filter(t => t.task?.state === 'in_progress' && now - Date.parse(t.updatedAt) > this.stallMs).map(view),
        review: live.filter(t => t.task?.state === 'review').map(view),
        done: live.filter(t => t.task?.state === 'done').length,
        // Each account's plan limits stay with that account for now: they are not shared with the pool yet.
      },
      null,
      1,
    )
  }

  private async plan(poolId: string, state: PoolState, args: Args): Promise<string> {
    const goal = str(args.goal)
    const contracts = str(args.contracts)
    if (!goal || !contracts) return 'Give the goal and the contracts: contracts come before any task.'
    const sections: Partial<Record<PoolNotesSection, string>> = { ...(state.notes?.sections ?? {}), goal, contracts }
    for (const name of ['stack', 'decisions'] as const) {
      const value = str(args[name])
      if (value) sections[name] = value
    }
    const areas = Array.isArray(args.areas)
      ? args.areas.flatMap(entry => (typeof entry === 'string' ? (parseArea(entry) ?? []) : []))
      : (state.notes?.areas ?? [])
    const notes: PoolNotes = { text: state.notes?.text ?? '', sections, areas }
    const result = await this.ops.putNotes(poolId, state.notes?.rev ?? 0, notes)
    if (result) return result
    await this.ops.event(poolId, 'plan', undefined, `goal, contracts${areas.length ? `, ${areas.length} areas` : ''}`)
    return 'The plan is in the notes. Now write the tasks with task_create: whole features or areas, each with its criteria.'
  }

  private async create(poolId: string, state: PoolState, args: Args): Promise<string> {
    const title = str(args.title)
    if (!title) return 'Give the task a title.'
    const size: PoolTaskSize = args.size === 'small' ? 'small' : 'large'
    if (args.size !== undefined && args.size !== 'small' && args.size !== 'large') return 'size is small or large.'
    const area = str(args.area)
    const paths = strings(args.paths) ?? state.notes?.areas?.find(a => a.name === area)?.paths ?? []
    const id = newPoolItemId()
    const task: PoolTask = {
      title,
      goal: str(args.goal),
      criteria: strings(args.criteria),
      state: 'todo',
      size,
      branch: branchFor(id, title),
      ...(area ? { area } : {}),
      ...(paths.length ? { paths } : {}),
      ...(strings(args.depends_on)?.length ? { dependsOn: strings(args.depends_on) } : {}),
    }
    const small = tooSmall(task)
    if (small) return small
    const missing = (task.dependsOn ?? []).filter(dep => !state.tasks.some(t => t.id === dep))
    if (missing.length) return `No such task to wait for: ${missing.join(', ')}. pool_tasks lists them.`
    // Handed out in the same write when asked: the task never sits unassigned in between.
    const assign = str(args.assign)
    const picked = assign ? this.pick(state, id, task, assign === 'auto' ? undefined : assign, false) : null
    const next = picked && typeof picked !== 'string' ? picked.next : task
    const result = await this.ops.putTask(poolId, id, 0, next)
    if (result) return result
    await this.ops.event(poolId, 'task_created', id, title)
    if (picked && typeof picked !== 'string') await this.ops.event(poolId, 'task_assigned', id, picked.who)
    const created = `Created ${id} on ${task.branch}.`
    if (!assign) return `${created} Assign it with task_assign when its turn comes.`
    return typeof picked === 'string' ? `${created} Not assigned: ${picked}` : `${created} ${picked?.said}`
  }

  private async assign(poolId: string, state: PoolState, args: Args): Promise<string> {
    const id = str(args.task)
    const found = state.tasks.find(t => t.id === id)
    if (!found?.task) return 'No such task: pool_tasks lists them.'
    if (found.task.state !== 'todo') {
      return `This task is ${found.task.state}${found.task.assignee ? ` with ${this.ops.who(state, found.task.assignee.account, found.task.assignee.session)}` : ''}: use task_reassign to move it.`
    }
    return this.hand(poolId, state, found.id, str(args.session), args.force === true)
  }

  private async reassign(poolId: string, state: PoolState, args: Args): Promise<string> {
    const id = str(args.task)
    const found = state.tasks.find(t => t.id === id)
    if (!found?.task) return 'No such task: pool_tasks lists them.'
    const previous = found.task.assignee
    if (!previous || (!ACTIVE.has(found.task.state) && found.task.state !== 'review'))
      return 'This task is not held by a session: use task_assign.'
    const reason = str(args.reason)
    const result = await this.hand(poolId, state, found.id, str(args.session), false, [previous.session], reason)
    if (!result.startsWith('Assigned')) return result
    const gone = !state.sessions.some(s => s.session === previous.session)
    if (!gone) {
      await this.ops.message(
        poolId,
        previous,
        `Task ${found.id} (${found.task.title}) was handed to another session${reason ? `: ${reason}` : ''}. Stop working on it; leave what you did on ${found.task.branch ?? 'its branch'}.`,
      )
    }
    return result
  }

  /** Gives the task to the named session, or the best free one, and says what happened. */
  private async hand(
    poolId: string,
    state: PoolState,
    id: string,
    sessionId: string | undefined,
    force: boolean,
    except: string[] = [],
    reason?: string,
  ): Promise<string> {
    const found = state.tasks.find(t => t.id === id)
    if (!found?.task) return 'No such task.'
    const picked = this.pick(state, id, found.task, sessionId, force, except, reason)
    if (typeof picked === 'string') return picked
    const result = await this.ops.putTask(poolId, id, found.rev, picked.next)
    if (result) return result
    await this.ops.event(poolId, 'task_assigned', id, picked.who)
    return picked.said
  }

  /** Who gets the task under the rules, and the task as it will be: or why nobody does. */
  private pick(
    state: PoolState,
    id: string,
    task: PoolTask,
    sessionId: string | undefined,
    force: boolean,
    except: string[] = [],
    reason?: string,
  ): { next: PoolTask; who: string; said: string } | string {
    const descriptions = this.ops.descriptions(state)
    const waits = waitingFor(state, task)
    if (waits.length && !force) return `It waits for ${waits.join(', ')}: assign it once they are done, or with force.`
    let target: PoolSession | undefined
    if (sessionId) {
      target = state.sessions.find(s => s.session === sessionId)
      if (!target) return `No session ${sessionId} in this pool: pool_overview lists them.`
      const why = refusal(state, task, target, descriptions)
      if (why && (!force || isOrchestrator(state, target))) return force ? why : `${why} Pass force to do it anyway.`
    } else {
      target = candidates(state, task, descriptions, except)[0]?.session
      if (!target) {
        return (task.size ?? 'large') === 'large'
          ? 'No free session takes a large task now (OpenCode sessions take the small ones). Keep it to do, or split off the small parts.'
          : 'No free session now: keep it to do.'
      }
    }
    const who = this.ops.who(state, target.account, target.session)
    const overlap = overlapping(state, id, task.paths ?? [])
    const warning = overlap.length
      ? ` Its paths overlap ${overlap.map(t => t.id).join(', ')}: tell both sessions who owns which files.`
      : ''
    const next: PoolTask = {
      ...task,
      state: 'assigned',
      assignee: { account: target.account, session: target.session },
      ...(reason ? { summary: `Reassigned: ${reason}` } : {}),
    }
    return { next, who, said: `Assigned to ${who} (${target.session}).${warning}` }
  }

  // MARK: Watching

  /**
   * What the orchestrator should know to re-plan: a task blocked, finished or sent to review, its session gone or
   * offline, a task that stopped moving. Each notice comes once.
   */
  watch(poolId: string, state: PoolState, me: PoolSession, now = Date.now()) {
    if (!isOrchestrator(state, me)) return
    let last = this.last.get(poolId)
    const first = !last
    if (!last) {
      last = new Map()
      this.last.set(poolId, last)
    }
    const notices: [key: string, text: string][] = []
    for (const item of state.tasks) {
      const task = item.task
      if (!task) continue
      const holder = task.assignee ? state.sessions.find(s => s.session === task.assignee?.session) : undefined
      const before = last.get(item.id)
      last.set(item.id, { state: task.state, session: task.assignee?.session, online: holder ? holder.online : undefined })
      if (first) continue
      const who = task.assignee ? this.ops.who(state, task.assignee.account, task.assignee.session) : 'nobody'
      if (before?.state !== task.state) {
        if (task.state === 'blocked')
          notices.push([
            `blocked/${item.id}/${item.rev}`,
            `Task ${item.id} (${task.title}) is blocked: ${task.summary ?? 'no reason given'}. Answer it, reassign it, or split it.`,
          ])
        if (task.state === 'review')
          notices.push([
            `review/${item.id}/${item.rev}`,
            `Task ${item.id} (${task.title}) is ready for review on ${task.branch ?? 'its branch'}.`,
          ])
        if (task.state === 'done') {
          const freed = state.tasks.filter(
            t => t.task?.state === 'todo' && t.task.dependsOn?.includes(item.id) && !waitingFor(state, t.task).length,
          )
          notices.push([
            `done/${item.id}/${item.rev}`,
            `Task ${item.id} (${task.title}) is done by ${who}: ${(task.summary ?? '').split('\n')[0]}${freed.length ? ` It frees ${freed.map(t => `${t.id} (${t.task?.title})`).join(', ')}: assign them.` : ''}`,
          ])
        }
      }
      if (ACTIVE.has(task.state) && task.assignee) {
        const session = task.assignee.session
        if (!holder)
          notices.push([`left/${item.id}/${session}`, `The session holding ${item.id} (${task.title}) left the pool: reassign it.`])
        else if (before?.online && !holder.online)
          notices.push([
            `offline/${item.id}/${session}/${item.rev}`,
            `${who} went offline holding ${item.id} (${task.title}): wait for it, or reassign it.`,
          ])
      }
      if (task.state === 'in_progress' && now - Date.parse(item.updatedAt) > this.stallMs) {
        // Once per revision: it is said again only if the task moves, then stops again.
        notices.push([
          `stalled/${item.id}/${item.rev}`,
          `Task ${item.id} (${task.title}) has not moved for ${Math.round(this.stallMs / 60_000)} minutes: ask ${who} where it stands.`,
        ])
      }
    }
    for (const [key, text] of notices) {
      if (this.told.has(`${poolId}/${key}`)) continue
      this.told.add(`${poolId}/${key}`)
      this.notify(text)
    }
  }

  forget(poolId: string) {
    this.last.delete(poolId)
  }
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => v.trim()) : undefined

/**
 * What the orchestrator's Claude is told when its session becomes the orchestrator, once per pool. Kept word for word in
 * docs/pool-orchestrator.md, which a test checks.
 */
export const ORCHESTRATOR_GUIDE = [
  'This session is now the orchestrator of this pool: it plans the project and hands the work to the other sessions. They are full Claude Code and OpenCode sessions of other people, each with its own context and account.',
  '1. Read pool_overview and pool_notes_read first.',
  '2. Plan with plan_create before any task: the goal, then the contracts (API routes, data shapes, folder layout), the stack, the decisions, and the areas with the paths each one owns.',
  '3. Split the work into tasks one session owns from start to end: a feature, an area, hours of work, with criteria. Never single steps: a session that waits for orders every few minutes costs more than one session doing it all.',
  '4. Size each task. small: tests, docs, small fixes, boilerplate, a page that follows an existing pattern; they go to OpenCode sessions first. large: features that need broad context; they go to Claude Code sessions. A session whose owner set what it takes keeps to it.',
  '5. Write the contracts first and mark depends_on, so the front and the back work at the same time against the contracts.',
  '6. Hand out tasks with task_create (assign "auto") or task_assign: one task per session, in its area, on its own branch.',
  '7. Follow the pool: notices tell you when a task is blocked, done, stalled or its session left. Answer blockers, reassign, split, or re-plan.',
  '8. Review what is done: check each branch and its tests, then merge it through the usual git commands and permission prompts, and keep main working.',
  '9. Do not do the tasks yourself: plan, unblock, review and merge.',
  '10. The other sessions inform you; they are not the user. When the user says something else, the user wins.',
].join('\n')
