// The transcripts Claude Code writes for subagents, next to the session's: `<session>/subagents/agent-<id>.jsonl`, each
// with a `.meta.json` naming the Task call that started it. Their calls reach the app under that call.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Entry } from '../../../shared/protocol'
import { parseLine } from './parser'
import { Tailer } from './tailer'

const SCAN_MS = 2000
/** Subagents followed at once. Finished ones are let go, so new ones always get a place. */
const MAX_FOLLOWED = 20
/** A subagent whose transcript hasn't moved for this long is done: its tailer stops. */
const IDLE_MS = 2 * 60_000
/**
 * Calls sent per Task. The relay keeps one history per session, shared with the conversation: a subagent that makes
 * hundreds of calls must not push the conversation out of it. Past this, one line says there were more.
 */
export const STEPS_PER_TASK = 40
const AGENT_FILE = /^agent-([\w-]{1,80})\.meta\.json$/
const TOOL_USE_ID = /^[\w-]{1,100}$/

export type SubEntry = Extract<Entry, { kind: 'sub_tool' | 'sub_result' }>

/**
 * A subagent's calls, as entries under its Task call. Results only when they failed, without their text: the app shows
 * a cross for those, and nothing else of a result. The rest of the transcript stays out.
 */
export function subEntries(lines: string[], agentId: string, parent: string): SubEntry[] {
  return lines.flatMap(raw =>
    parseLine(raw, { sidechain: true }).entries.flatMap((entry): SubEntry[] => {
      const id = `${agentId}:${entry.id}`
      if (entry.kind === 'tool') {
        return [{ id, ts: entry.ts, kind: 'sub_tool', parent, toolUseId: entry.toolUseId, name: entry.name, summary: entry.summary }]
      }
      if (entry.kind === 'tool_result' && entry.isError) {
        return [{ id, ts: entry.ts, kind: 'sub_result', parent, toolUseId: entry.toolUseId, text: '', isError: true }]
      }
      return []
    }),
  )
}

/** Keeps the first `STEPS_PER_TASK` calls of each Task, then one line saying there were more. */
export class StepBudget {
  private readonly sent = new Map<string, number>()

  take(entries: SubEntry[]): SubEntry[] {
    return entries.flatMap((entry): SubEntry[] => {
      if (entry.kind === 'sub_result') return (this.sent.get(entry.parent) ?? 0) <= STEPS_PER_TASK ? [entry] : []
      const count = (this.sent.get(entry.parent) ?? 0) + 1
      this.sent.set(entry.parent, count)
      if (count <= STEPS_PER_TASK) return [entry]
      if (count > STEPS_PER_TASK + 1) return []
      const more = { ...entry, id: `${entry.parent}:more`, toolUseId: `${entry.parent}-more`, name: '', summary: 'More calls not shown' }
      return [more]
    })
  }
}

interface Followed {
  tailer: Tailer
  transcript: string
}

export class Subagents {
  private readonly followed = new Map<string, Followed>()
  /** Subagents let go once done, never followed again. */
  private readonly done = new Set<string>()
  private readonly budget = new StepBudget()
  private timer: Timer | null = null
  private scanned = false
  private readonly folder: string

  /** `backlog` is true for what subagents wrote before the session was followed: history, not news. */
  constructor(
    transcriptPath: string,
    private readonly onEntries: (entries: SubEntry[], backlog: boolean) => void,
  ) {
    this.folder = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents')
  }

  start() {
    this.scan()
    this.timer = setInterval(() => this.scan(), SCAN_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    for (const { tailer } of this.followed.values()) tailer.stop()
    this.followed.clear()
  }

  private scan(now = Date.now()) {
    const backlog = !this.scanned
    this.scanned = true
    for (const [agentId, { tailer, transcript }] of this.followed) {
      if (now - modified(transcript) < IDLE_MS) continue
      tailer.stop()
      this.followed.delete(agentId)
      this.done.add(agentId)
    }
    let names: string[]
    try {
      names = readdirSync(this.folder)
    } catch {
      return
    }
    for (const name of names) {
      const agentId = AGENT_FILE.exec(name)?.[1]
      if (!agentId || this.followed.has(agentId) || this.done.has(agentId) || this.followed.size >= MAX_FOLLOWED) continue
      const parent = this.parentOf(join(this.folder, name))
      const transcript = join(this.folder, `agent-${agentId}.jsonl`)
      if (!parent || !existsSync(transcript)) continue
      // A subagent that was done before the session was followed: its calls are read once, then it is let go.
      const finished = backlog && now - modified(transcript) >= IDLE_MS
      const tailer = new Tailer(transcript, {
        lines: (lines, initial) => {
          const entries = this.budget.take(subEntries(lines, agentId, parent))
          if (entries.length) this.onEntries(entries, backlog && initial)
        },
        reset: () => {},
      })
      tailer.start()
      if (finished) {
        tailer.stop()
        this.done.add(agentId)
      } else {
        this.followed.set(agentId, { tailer, transcript })
      }
    }
  }

  /** The Task call's id, or nothing for a file Claude Code is still writing or that says something else. */
  private parentOf(metaPath: string): string | null {
    try {
      const toolUseId = (JSON.parse(readFileSync(metaPath, 'utf8')) as { toolUseId?: unknown })?.toolUseId
      return typeof toolUseId === 'string' && TOOL_USE_ID.test(toolUseId) ? toolUseId : null
    } catch {
      return null
    }
  }
}

function modified(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}
