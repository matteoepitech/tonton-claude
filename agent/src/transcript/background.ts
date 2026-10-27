// The background tasks of a Claude Code session that have not reported back yet: shells run in the background, monitors,
// background agents. Claude Code ends its turn and later says "waiting for your input" while it only waits for them.
// Transcripts are not a public format: anything unexpected is skipped, never thrown.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

/** What a tool says when it started something that will report back. */
const STARTED = /You will be notified when/i
const STARTED_ID = /\b(?:with ID|agentId|task ?id)[:\s]+([A-Za-z0-9_-]{5,64})/i
/** A task-notification, whose status says the task is over. */
const NOTIFICATION = /<task-id>\s*([A-Za-z0-9_-]+)\s*<\/task-id>[\s\S]*?<status>\s*(\w+)\s*<\/status>/g
const OVER = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error', 'timeout'])
const STOPPED = /stopped task:\s*([A-Za-z0-9_-]+)/i
/** A task that never reported back after this long no longer counts: Monitors run an hour at most. */
export const BACKGROUND_TTL_MS = 2 * 3600_000
/** The end of a long transcript is enough: background tasks are recent. */
const TAIL_BYTES = 4 * 1024 * 1024

/** Ids of the background tasks still running, from the lines of a transcript. */
export function runningTasks(lines: string[], now = Date.now()): string[] {
  const running = new Map<string, number>()
  for (const line of lines) {
    let parsed: LineFields
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const at = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) || now : now
    for (const text of lineTexts(parsed)) {
      const started = STARTED.test(text) ? STARTED_ID.exec(text) : null
      if (started) running.set(started[1], at)
      const stopped = STOPPED.exec(text)
      if (stopped) running.delete(stopped[1])
      for (const [, id, status] of text.matchAll(NOTIFICATION)) if (OVER.has(status.toLowerCase())) running.delete(id)
    }
  }
  return [...running].filter(([, at]) => now - at < BACKGROUND_TTL_MS).map(([id]) => id)
}

/** The background tasks still running in the session of this transcript. */
export function runningTasksIn(transcript: string, now = Date.now()): string[] {
  let fd: number | null = null
  try {
    fd = openSync(transcript, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8').split('\n')
    // The first line of a cut tail is only the end of one.
    return runningTasks(start > 0 ? lines.slice(1) : lines, now)
  } catch {
    return []
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

interface LineFields {
  type?: unknown
  timestamp?: unknown
  message?: { content?: unknown }
  attachment?: { type?: unknown; prompt?: unknown }
  content?: unknown
}

/**
 * Where a line can say a task started or ended. A notification that arrives while Claude works is not a message: Claude
 * Code queues it as an attachment, and writes the queue's own line too.
 */
function lineTexts(line: LineFields): string[] {
  return [
    ...texts(line.message?.content),
    ...(line.attachment?.type === 'queued_command' ? texts(line.attachment.prompt) : []),
    ...(line.type === 'queue-operation' ? texts(line.content) : []),
  ]
}

/** The text of a message: a string, or its text blocks and tool results. */
function texts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap(block => {
    if (!block || typeof block !== 'object') return []
    const { type, text, content: inner } = block as { type?: unknown; text?: unknown; content?: unknown }
    if (type === 'text' && typeof text === 'string') return [text]
    if (type === 'tool_result') return texts(inner)
    return []
  })
}
