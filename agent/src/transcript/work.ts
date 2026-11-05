// The work a Claude Code session did, read line by line from its transcript, for the agent's XP (agent/src/rpg-work.ts):
// its turns and the checklist tasks it finished. Pushes and submits come from agent/src/cluster/detect.ts. The same lines
// give the same facts in the same order, whether the agent follows the session live or the backfill reads it weeks later.

import type { Entry } from '../../../shared/protocol'
import { TurnSlices } from '../rpg-slices'
import type { ParsedLine, TaskCall } from './parser'

/**
 * A turn that ended. `id` names it for good: in Claude Code the line that ended it, which any read that reaches the end
 * sees, even one that starts in the middle of a long transcript; in OpenCode the prompt.
 */
export interface TurnFact {
  id: string
  /** When it ended. */
  at: string
  seconds: number
  /** Started by its user, and neither interrupted nor failed. */
  prompted: boolean
  /** Ten minutes of a turn still going (agent/src/rpg-slices.ts), not the turn itself. */
  slice?: boolean
}

/** A checklist task marked done by a call that succeeded. `content` is normalized, as version 1 named it. */
export interface TaskFact {
  content: string
  at: string
}

export interface WorkFacts {
  turns: TurnFact[]
  tasks: TaskFact[]
}

/** Calls waiting for their result. A session that never answers them must not fill memory. */
const MAX_PENDING = 500

interface OpenTurn {
  /** A start line was seen: a turn whose start was not read is not known to be its user's. */
  started: boolean
  user: boolean
  broken: boolean
  waitedMs: number
  /** The line that started it: its slices are named after it, since the line that ends it is not written yet. */
  startId?: string
}

export class TranscriptWork {
  private turn: OpenTurn = { started: false, user: false, broken: false, waitedMs: 0 }
  private readonly slices = new TurnSlices()
  /** TodoWrite calls, with the tasks they mark done. */
  private readonly todos = new Map<string, TaskFact[]>()
  /** TaskUpdate calls that mark a task done. */
  private readonly updates = new Map<string, { call: TaskCall; ts: string }>()
  /** TaskCreate calls, with their subject: the result gives the task's number. */
  private readonly creates = new Map<string, string>()
  /** Task numbers and their subjects. */
  private readonly subjects = new Map<string, string>()
  /** Shell calls' whole commands, for agent/src/cluster/detect.ts: an entry's summary is cut. */
  private readonly commands = new Map<string, string>()
  /** The folder the session last ran in. */
  cwd: string | undefined
  /** A pool post started a turn: the session works for a pool, and its own checklist earns no solo XP. */
  pool = false

  line(parsed: ParsedLine): WorkFacts {
    const facts: WorkFacts = { turns: [], tasks: [] }
    const work = parsed.work ?? {}
    if (work.cwd) this.cwd = work.cwd
    for (const [id, command] of Object.entries(parsed.commands ?? {})) remember(this.commands, id, command)
    const start = work.start
    if (start) {
      if (start.from === 'pool') this.pool = true
      // A line of its own starts a new turn: Claude Code only queues what arrives during one.
      if (!start.queued) {
        if (this.turn.startId) this.slices.forget(this.turn.startId)
        this.turn = { started: true, user: false, broken: false, waitedMs: 0, startId: start.id }
      }
      this.turn.started = true
      if (start.from === 'user') this.turn.user = true
    }
    if (this.turn.startId && work.at && !parsed.turn) facts.turns.push(...this.slices.progress(this.turn.startId, Date.parse(work.at)))
    if (work.broken) this.turn.broken = true
    for (const call of work.tasks ?? []) this.task(call, parsed.entries)
    for (const entry of parsed.entries) this.entry(entry, facts)
    if (parsed.turn && work.turnId) {
      const seconds = Math.max(0, parsed.turn.seconds - this.turn.waitedMs / 1000)
      const prompted = this.turn.started && this.turn.user && !this.turn.broken
      const turn = { id: work.turnId, at: parsed.turn.end, seconds, prompted }
      facts.turns.push(this.turn.startId ? this.slices.end(this.turn.startId, turn) : turn)
      this.turn = { started: false, user: false, broken: false, waitedMs: 0 }
    }
    return facts
  }

  /** The whole command of a shell call this transcript made. */
  command(toolUseId: string): string | undefined {
    return this.commands.get(toolUseId)
  }

  /** Time the turn spent waiting on a permission prompt, as far as the agent can tell: it does not count as work. */
  waited(ms: number) {
    if (Number.isFinite(ms) && ms > 0) this.turn.waitedMs += ms
    if (this.turn.startId) this.slices.waited(this.turn.startId, ms)
  }

  private entry(entry: Entry, facts: WorkFacts) {
    if (entry.kind === 'tool') {
      if (entry.name === 'TodoWrite' && entry.todos) {
        const done = entry.todos.filter(todo => todo.status === 'completed' && todo.content.trim())
        remember(
          this.todos,
          entry.toolUseId,
          done.map(todo => ({ content: normalized(todo.content), at: entry.ts })),
        )
      }
      return
    }
    if (entry.kind !== 'tool_result') return
    const id = entry.toolUseId
    const todos = this.todos.get(id)
    const update = this.updates.get(id)
    const create = this.creates.get(id)
    this.todos.delete(id)
    this.updates.delete(id)
    this.creates.delete(id)
    if (entry.isError) return
    if (todos) facts.tasks.push(...todos)
    const number = /^Task #(\S+) created successfully/.exec(entry.text)?.[1]
    if (create && number) remember(this.subjects, number, create)
    const subject = update ? (update.call.subject ?? (update.call.taskId ? this.subjects.get(update.call.taskId) : undefined)) : undefined
    if (update && subject?.trim()) facts.tasks.push({ content: normalized(subject), at: update.ts })
  }

  private task(call: TaskCall, entries: Entry[]) {
    if (call.name === 'TaskCreate' && call.subject) remember(this.creates, call.toolUseId, call.subject)
    if (call.name !== 'TaskUpdate') return
    // A renamed task keeps its new subject for the next update.
    if (call.taskId && call.subject) remember(this.subjects, call.taskId, call.subject)
    // Dated by its call: a task read weeks later stays on its own day.
    const ts = entries.find(entry => entry.kind === 'tool' && entry.toolUseId === call.toolUseId)?.ts
    if (call.status === 'completed' && ts) remember(this.updates, call.toolUseId, { call, ts })
  }
}

/** Version 1's identity: spaces collapsed, so the same task written twice is one task. */
const normalized = (content: string) => content.trim().replace(/\s+/g, ' ')

function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.set(key, value)
  if (map.size > MAX_PENDING) map.delete(map.keys().next().value as string)
}
