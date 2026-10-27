// The transcripts Claude Code writes for subagents, next to the session's: `<session>/subagents/agent-<id>.jsonl`, each
// with a `.meta.json` naming the Task call that started it. Their calls reach the app under that call.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Entry } from '../../../shared/protocol'
import { parseLine } from './parser'
import { Tailer } from './tailer'

const SCAN_MS = 2000
/** A session that starts more subagents than this keeps the calls of its first ones only. */
const MAX_SUBAGENTS = 50
const AGENT_FILE = /^agent-([\w-]{1,80})\.meta\.json$/
const TOOL_USE_ID = /^[\w-]{1,100}$/

type SubEntry = Extract<Entry, { kind: 'sub_tool' | 'sub_result' }>

/** A subagent's calls and results, as entries under its Task call. The rest of its transcript stays out. */
export function subEntries(lines: string[], agentId: string, parent: string): SubEntry[] {
  return lines.flatMap(raw =>
    parseLine(raw, { sidechain: true }).entries.flatMap((entry): SubEntry[] => {
      const id = `${agentId}:${entry.id}`
      if (entry.kind === 'tool')
        return [{ id, ts: entry.ts, kind: 'sub_tool', parent, toolUseId: entry.toolUseId, name: entry.name, summary: entry.summary }]
      if (entry.kind === 'tool_result') {
        return [{ id, ts: entry.ts, kind: 'sub_result', parent, toolUseId: entry.toolUseId, text: entry.text, isError: entry.isError }]
      }
      return []
    }),
  )
}

export class Subagents {
  private readonly tailers = new Map<string, Tailer>()
  private timer: Timer | null = null
  private readonly folder: string

  constructor(
    transcriptPath: string,
    private readonly onEntries: (entries: SubEntry[]) => void,
  ) {
    this.folder = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents')
  }

  start() {
    this.scan()
    this.timer = setInterval(() => this.scan(), SCAN_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    for (const tailer of this.tailers.values()) tailer.stop()
    this.tailers.clear()
  }

  private scan() {
    let names: string[]
    try {
      names = readdirSync(this.folder)
    } catch {
      return
    }
    for (const name of names) {
      const agentId = AGENT_FILE.exec(name)?.[1]
      if (!agentId || this.tailers.has(agentId) || this.tailers.size >= MAX_SUBAGENTS) continue
      const parent = this.parentOf(join(this.folder, name))
      const transcript = join(this.folder, `agent-${agentId}.jsonl`)
      if (!parent || !existsSync(transcript)) continue
      const tailer = new Tailer(transcript, {
        lines: lines => {
          const entries = subEntries(lines, agentId, parent)
          if (entries.length) this.onEntries(entries)
        },
        reset: () => {},
      })
      this.tailers.set(agentId, tailer)
      tailer.start()
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
