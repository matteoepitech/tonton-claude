// Merging finished pool tasks into main (docs/pool-orchestrator.md, Merging). The orchestrator's `task_merge` takes the
// next finished task in dependency order, or the one it names, and merges its branch in the orchestrator's own folder
// (pool-git.ts): main moves only once the checks pass on the result. What happened goes on the task, sealed like the
// rest, and in the pool's events. A conflict or a failing check sends the task back to its author with what failed, or
// to a new task on the same branch when its author can't take it; main stays as it was. The autopilot's control loop
// can call `mergeQueue` and `PoolMerger.merge` the same way the tool does.

import { newPoolItemId, type PoolState, type PoolTaskItem } from '../../../shared/pool'
import type { PoolTask, PoolTaskMerge } from '../../../shared/pool-protocol'
import type { LandOutcome, PoolGit } from './pool-git'
import type { PoolOps } from './pool-orchestrator'
import type { PoolToolSpec } from './pool-work'

const POOL = { type: 'string', description: 'The pool, by id or name. Only needed when the session is in more than one.' } as const

export const TASK_MERGE_TOOL: PoolToolSpec = {
  name: 'task_merge',
  description:
    "For the orchestrator: merge a finished task's branch into main, in this session's folder (the top of the pool's repository). The branch is merged on top of the latest main, the checks run on the result, and main moves only when they pass. A conflict or a failing check sends the task back to its author, or to a new task. Without task: the next finished one in dependency order, as pool_overview lists them under toMerge.",
  params: {
    pool: POOL,
    task: { type: 'string', description: 'The task id. Missing: the next one in line.' },
    checks: {
      type: 'array',
      description:
        'The commands that build and test the project, run in order in this folder, as its README or the notes say: for example "bun install", "bun test". An empty list merges without a build.',
      required: true,
    },
    pr: {
      type: 'boolean',
      description: "Open a pull request with GitHub's gh instead of pushing main, for a repository that takes changes that way.",
    },
    base: { type: 'string', description: "The branch to merge into. Missing: origin's default branch, else main." },
    force: { type: 'boolean', description: 'Merge it even though a task it depends on is not merged yet.' },
    skip: {
      type: 'boolean',
      description: 'With task: take it off the list without merging, when its work is in main some other way or there is nothing to merge.',
    },
  },
}

/** A finished task whose branch is not in main yet. */
export interface MergeLine {
  id: string
  title: string
  branch: string
  /** The tasks to merge first. */
  waitsFor: string[]
}

export interface MergeRequest {
  /** Missing: the next task in line. */
  task?: string
  /** The commands that build and test the project. Empty: merged without a build. */
  checks: string[]
  pr?: boolean
  base?: string
  /** Past the tasks it depends on that are not merged yet. */
  force?: boolean
  /** Marks the task named merged, without merging anything. */
  skip?: boolean
}

/** Held by a session: it gets no other task, nor one sent back. */
const ACTIVE = new Set(['assigned', 'in_progress', 'blocked'])

/** Off the list: its branch is in main, or in a pull request that the repository's rules merge. */
export const landed = (task: Pick<PoolTask, 'merge'> | null | undefined): boolean =>
  task?.merge?.state === 'merged' || task?.merge?.state === 'pr'

/**
 * The tasks it depends on whose work is not in main yet: not done, or done on a branch not merged. A pull request still
 * open counts as not merged: what depends on it would be checked against a main without it.
 */
export function unmerged(state: PoolState, task: Pick<PoolTask, 'dependsOn'>): string[] {
  return (task.dependsOn ?? []).filter(id => {
    const dependency = state.tasks.find(item => item.id === id)?.task
    if (!dependency) return false
    if (dependency.state !== 'done') return true
    return Boolean(dependency.branch) && dependency.merge?.state !== 'merged'
  })
}

/** The task that fixes its merge, when there is one on the board: one that is gone fixes nothing. */
const fixOf = (state: PoolState, task: Pick<PoolTask, 'merge'>): string | undefined =>
  task.merge?.fix && state.tasks.some(item => item.id === task.merge?.fix) ? task.merge.fix : undefined

/**
 * Finished tasks whose branch is not in main yet, in the order to merge them: each one after the tasks it depends on,
 * then by when it was finished. A task handed to a fix task waits for that one.
 */
export function mergeQueue(state: PoolState): MergeLine[] {
  const pending = state.tasks
    .filter(item => item.task?.state === 'done' && item.task.branch && !landed(item.task) && !fixOf(state, item.task))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .map(item => ({
      id: item.id,
      title: item.task?.title ?? '',
      branch: item.task?.branch ?? '',
      waitsFor: unmerged(state, item.task ?? {}),
    }))
  const ordered: MergeLine[] = []
  let left = pending
  while (left.length) {
    const placed = new Set(ordered.map(line => line.id))
    const next = left.find(line => line.waitsFor.every(id => placed.has(id)))
    // What waits for a task not finished yet, or for one another, comes last.
    if (!next) return [...ordered, ...left]
    ordered.push(next)
    left = left.filter(line => line !== next)
  }
  return ordered
}

export class PoolMerger {
  constructor(
    private readonly ops: PoolOps,
    private readonly git: PoolGit,
    /** This session's folder: the merge runs there, and nowhere else. */
    private readonly folder: () => string | undefined,
    /** The pool as it is now: a merge takes minutes, and the pool moves meanwhile. */
    private readonly current: (poolId: string) => PoolState | null,
  ) {}

  /** The orchestrator's `task_merge`. */
  async call(poolId: string, state: PoolState, args: Record<string, unknown>): Promise<string> {
    const checks = args.checks
    if (!Array.isArray(checks) || checks.some(check => typeof check !== 'string')) {
      return 'Give checks: the commands that build and test the project, as its README or the notes say. An empty list merges without a build.'
    }
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
    const request: MergeRequest = {
      task: text(args.task),
      checks: checks.map(check => (check as string).trim()).filter(Boolean),
      pr: args.pr === true,
      base: text(args.base),
      force: args.force === true,
      skip: args.skip === true,
    }
    return (await this.merge(poolId, state, request)).text
  }

  /** Merges one finished task and records what happened: for the tool, and for a loop that merges on its own. */
  async merge(poolId: string, state: PoolState, request: MergeRequest): Promise<{ text: string; taskId?: string; outcome?: LandOutcome }> {
    const folder = this.folder()
    if (!folder) return { text: "This session's folder is not known: the merge runs in it." }
    if (request.skip && !request.task) return { text: 'skip takes the task named in task, never the next one in line.' }
    const picked = this.pick(state, request.skip ? { ...request, force: true } : request)
    if (typeof picked === 'string') return { text: picked }
    const task = picked.task as PoolTask & { branch: string }
    if (request.skip) return { text: await this.skip(poolId, state, picked), taskId: picked.id }
    const outcome = await this.git.land(folder, {
      branch: task.branch,
      base: request.base,
      checks: request.checks,
      how: request.pr ? 'pr' : 'merge',
      message: `Merge ${task.branch}\n\nPool task ${picked.id}: ${task.title}`,
      title: task.title,
      body: [task.goal, task.summary].filter(Boolean).join('\n\n'),
    })
    const now = this.current(poolId) ?? state
    const fresh = now.tasks.find(item => item.id === picked.id && item.task) ?? picked
    const said = await this.record(poolId, now, fresh, outcome, request)
    // What went wrong around the merge itself: the folder left on it, or main here not moved.
    const text = outcome.note && outcome.kind !== 'merged' ? `${said}\n${outcome.note}` : said
    return { text, taskId: picked.id, outcome }
  }

  /** The task named, or the next one in line: or why there is none to merge. */
  private pick(state: PoolState, request: MergeRequest): PoolTaskItem | string {
    const queue = mergeQueue(state)
    if (!request.task) {
      const next = queue.find(line => !line.waitsFor.length)
      if (next) return state.tasks.find(item => item.id === next.id) ?? 'No such task.'
      if (!queue.length) return 'Nothing to merge: every finished task with a branch is in main.'
      return `Nothing is ready to merge: ${queue.map(line => `${line.id} (${line.title}) waits for ${line.waitsFor.join(', ')}`).join('; ')}.`
    }
    const item = state.tasks.find(t => t.id === request.task)
    if (!item?.task) return 'No such task: pool_tasks lists them.'
    const task = item.task
    if (task.state !== 'done') return `This task is ${task.state}: only finished tasks are merged.`
    if (!task.branch) return 'This task has no branch to merge.'
    if (task.merge?.state === 'merged') return `It is merged already, as ${short(task.merge.commit)}.`
    if (task.merge?.state === 'pr' && !request.skip) {
      return `Its pull request is open: ${task.merge.url ?? 'see the task'}. Once it is merged, pass skip to mark the task merged: what depends on it waits until then.`
    }
    const fix = fixOf(state, task)
    if (fix) return `Its fix is task ${fix}: merge that one once it is done.`
    const waits = unmerged(state, task)
    if (waits.length && !request.force) return `It waits for ${waits.join(', ')} to be merged first: merge them, or pass force.`
    return item
  }

  /** Off the list, on the orchestrator's word: nothing is merged, and the event says so. */
  private async skip(poolId: string, state: PoolState, item: PoolTaskItem): Promise<string> {
    const task = item.task as PoolTask & { branch: string }
    const refused = await this.ops.putTask(poolId, item.id, item.rev, { ...task, merge: { state: 'merged', at: new Date().toISOString() } })
    if (refused) return refused
    await this.ops.event(poolId, 'merged', item.id, `${task.branch}: marked merged without a merge`)
    const after = {
      ...state,
      tasks: state.tasks.map(t => (t.id === item.id ? { ...t, task: { ...task, merge: { state: 'merged' as const, at: '' } } } : t)),
    }
    const next = mergeQueue(after).find(line => !line.waitsFor.length)
    return `Marked ${item.id} (${task.title}) merged, without merging ${task.branch}.${next ? ` Next to merge: ${next.id} (${next.title}).` : ''}`
  }

  private async record(poolId: string, state: PoolState, item: PoolTaskItem, outcome: LandOutcome, request: MergeRequest): Promise<string> {
    const task = item.task as PoolTask & { branch: string }
    const at = new Date().toISOString()
    switch (outcome.kind) {
      case 'refused':
        return outcome.why
      case 'main_red':
        await this.ops.event(poolId, 'main_broken', item.id, `${outcome.command} fails on main`)
        return `Nothing was merged: main itself fails \`${outcome.command}\`, without ${task.branch}.\n${outcome.output}\nHave main fixed first (a task for it with task_create), then merge again.`
      case 'pr': {
        const refused = await this.ops.putTask(poolId, item.id, item.rev, { ...task, merge: { state: 'pr', at, url: outcome.url } })
        await this.ops.event(poolId, 'pr_opened', item.id, outcome.url)
        const opened = `Opened ${outcome.url} for ${task.branch}${checked(request)}: ${outcome.base} moves when it is merged, by the repository's own rules.`
        return refused ? `${opened} The task does not say so: ${refused}` : opened
      }
      case 'merged':
        return this.merged(poolId, state, item, outcome, request, at)
      case 'conflict':
      case 'failed':
        return this.sendBack(poolId, state, item, outcome, at)
    }
  }

  private async merged(
    poolId: string,
    state: PoolState,
    item: PoolTaskItem,
    outcome: Extract<LandOutcome, { kind: 'merged' }>,
    request: MergeRequest,
    at: string,
  ): Promise<string> {
    const task = item.task as PoolTask & { branch: string }
    const merge: PoolTaskMerge = { state: 'merged', at, commit: outcome.commit }
    const refused = await this.ops.putTask(poolId, item.id, item.rev, { ...task, merge })
    await this.ops.event(poolId, 'merged', item.id, `${task.branch} → ${outcome.base} ${short(outcome.commit)}`)
    // A fix task carries the branch of the task it fixes, maybe through other fixes: those are in main now too.
    for (const fixed of fixedBy(state, item.id)) await this.ops.putTask(poolId, fixed.id, fixed.rev, { ...(fixed.task as PoolTask), merge })
    const after = { ...state, tasks: state.tasks.map(t => (t.id === item.id ? { ...t, task: { ...task, merge } } : t)) }
    const freed = after.tasks.filter(
      t => t.task?.state === 'todo' && t.task.dependsOn?.includes(item.id) && !unmerged(after, t.task).length,
    )
    const next = mergeQueue(after).find(line => !line.waitsFor.length)
    return [
      outcome.already
        ? `${task.branch} was in ${outcome.base} already (${short(outcome.commit)}): marked merged.`
        : `Merged ${task.branch} into ${outcome.base} as ${short(outcome.commit)}${outcome.pushed ? ', pushed to origin' : ''}${checked(request)}.`,
      !outcome.already && !request.checks.length ? 'No checks ran: main was not built.' : '',
      outcome.note ?? '',
      refused ? `The task does not say so: ${refused}` : '',
      freed.length ? `It frees ${freed.map(t => `${t.id} (${t.task?.title})`).join(', ')}: assign them.` : '',
      next ? `Next to merge: ${next.id} (${next.title}).` : '',
    ]
      .filter(Boolean)
      .join(' ')
  }

  /** Back to its author when it can take it, else to a new task on the same branch. Main did not move. */
  private async sendBack(
    poolId: string,
    state: PoolState,
    item: PoolTaskItem,
    outcome: Extract<LandOutcome, { kind: 'conflict' | 'failed' }>,
    at: string,
  ): Promise<string> {
    const task = item.task as PoolTask & { branch: string }
    const problemText = outcome.kind === 'conflict' ? 'conflicts with main' : `fails \`${outcome.command}\``
    if (task.state !== 'done') {
      // It moved during the merge: whoever moved it decides now.
      return `${task.branch} ${problemText}: nothing was merged. The task is ${task.state} now, so it stays as it is.\n${outcome.output}`
    }
    const problem: PoolTaskMerge =
      outcome.kind === 'conflict'
        ? { state: 'conflict', at, files: outcome.files, output: outcome.output }
        : { state: 'failed', at, command: outcome.command, output: outcome.output }
    const what =
      outcome.kind === 'conflict'
        ? `${task.branch} conflicts with main in ${outcome.files.join(', ')}: nothing was merged.`
        : `Merged with main, ${task.branch} fails \`${outcome.command}\`, which passes on main: nothing was merged.`
    const output = `\n${outcome.output}`
    const kind = outcome.kind === 'conflict' ? 'merge_conflict' : 'merge_failed'
    const said = outcome.kind === 'conflict' ? outcome.files.join(', ') : `${outcome.command} fails`
    const author = task.assignee
      ? state.sessions.find(s => s.account === task.assignee?.account && s.session === task.assignee.session)
      : undefined
    const busy =
      author && state.tasks.some(t => t.id !== item.id && t.task?.assignee?.session === author.session && ACTIVE.has(t.task.state))
    const leads = author && state.orchestrator?.account === author.account && state.orchestrator.session === author.session
    const why = !author
      ? 'its session left the pool'
      : !author.online || !author.ready
        ? 'its session is offline'
        : busy
          ? 'its session works on another task'
          : leads
            ? 'its session is the orchestrator'
            : null
    if (author && !why) {
      // The review it passed says nothing about what to fix now: an older agent would hand it over as the reason.
      const { review: _passed, ...back } = task
      const refused = await this.ops.putTask(poolId, item.id, item.rev, { ...back, state: 'assigned', merge: problem })
      if (refused) return `${what} It could not go back to its author: ${refused}${output}`
      await this.ops.event(poolId, kind, item.id, said)
      // Its agent hands it the details with the task; an older agent only shows this.
      await this.ops.message(
        poolId,
        { account: author.account, session: author.session },
        `Task ${item.id} (${task.title}) came back from the merge: ${what} Merge the latest main into ${task.branch}, fix it, push it, then call task_done again.`,
      )
      return `${what} Sent back to ${this.ops.who(state, author.account, author.session)} with it: they merge main into the branch, fix it and finish it again.${output}`
    }
    const fixId = newPoolItemId()
    const fix: PoolTask = {
      ...fixTask(item.id, task, outcome),
      state: 'todo',
      branch: task.branch,
      merge: problem,
      ...(task.size ? { size: task.size } : {}),
      ...(task.area ? { area: task.area } : {}),
      ...(task.paths?.length ? { paths: task.paths } : {}),
    }
    const notCreated = await this.ops.putTask(poolId, fixId, 0, fix)
    if (notCreated) return `${what} The fix task could not be made: ${notCreated}${output}`
    await this.ops.event(poolId, 'task_created', fixId, fix.title)
    await this.ops.putTask(poolId, item.id, item.rev, { ...task, merge: { ...problem, fix: fixId } })
    await this.ops.event(poolId, kind, item.id, said)
    return `${what} Its author cannot take it back (${why}), so it is a new task, ${fixId} (${fix.title}), on the same branch: assign it with task_assign.${output}`
  }
}

/** The tasks a fix stands for: those that name it in `fix`, and those that name them, and so on. */
function fixedBy(state: PoolState, id: string): PoolTaskItem[] {
  const ids = new Set([id])
  const found: PoolTaskItem[] = []
  for (let grew = true; grew; ) {
    grew = false
    for (const item of state.tasks) {
      const fix = item.task?.merge?.fix
      if (item.task?.state === 'done' && fix && ids.has(fix) && !ids.has(item.id)) {
        ids.add(item.id)
        found.push(item)
        grew = true
      }
    }
  }
  return found
}

/** The task that fixes a merge its author could not take back. */
function fixTask(
  id: string,
  task: PoolTask & { branch: string },
  outcome: Extract<LandOutcome, { kind: 'conflict' | 'failed' }>,
): Pick<PoolTask, 'title' | 'goal' | 'criteria'> {
  if (outcome.kind === 'conflict') {
    return {
      title: `Merge conflict: ${task.title}`,
      goal: `${task.branch} (task ${id}, ${task.title}) conflicts with main in ${outcome.files.join(', ')}. Merge the latest main into it, resolve the conflicts keeping what both sides meant, run the tests and push the branch.`,
      criteria: [`${task.branch} merges into main without a conflict`, 'its tests and the others pass'],
    }
  }
  return {
    title: `Fix the checks: ${task.title}`,
    goal: `Merged with the latest main, ${task.branch} (task ${id}, ${task.title}) fails \`${outcome.command}\`, which passes on main. Merge the latest main into it, make it pass and push the branch.`,
    criteria: [`\`${outcome.command}\` passes with ${task.branch} merged into main`, 'the other checks still pass'],
  }
}

/** What a session is told when its task comes back from the merge, with what failed. */
export function mergeBrief(task: Pick<PoolTask, 'branch' | 'merge'>): string {
  const merge = task.merge
  const branch = task.branch ?? 'its branch'
  const steps = `Merge the latest main into ${branch} (git fetch, then git merge origin/main), fix it, run the tests, push the branch, then call task_done again.`
  if (merge?.state === 'conflict') {
    return `Sent back by the merge: ${branch} conflicts with main in ${(merge.files ?? []).join(', ') || 'some files'}. ${steps}\n${merge.output ?? ''}`.trim()
  }
  if (merge?.state === 'failed') {
    return `Sent back by the merge: with ${branch} merged into main, \`${merge.command ?? 'a check'}\` fails. ${steps}\n${merge.output ?? ''}`.trim()
  }
  return ''
}

const short = (commit: string | undefined) => (commit ?? '').slice(0, 10)
const checked = (request: MergeRequest) => (request.checks.length ? `, after ${request.checks.map(c => `\`${c}\``).join(', ')} passed` : '')
