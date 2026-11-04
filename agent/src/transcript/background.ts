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
/** What a line says when it can start or end a task: the other lines, screenshots included, are never parsed for it. */
const MARKERS = /notified when|<task-id>|stopped task/i
/** A task that never reported back after this long no longer counts: Monitors run an hour at most. */
export const BACKGROUND_TTL_MS = 2 * 3600_000
/**
 * The transcript is read backwards until its lines are older than that. One screenshot or long result can weigh more
 * than a fixed tail, so the start of a task would fall out of it; this bounds what a giant transcript costs.
 */
const MAX_READ_BYTES = 32 * 1024 * 1024
const CHUNK_BYTES = 1024 * 1024
/** Lines longer than this are not parsed only to be dated: a smaller one next to them dates the read. */
const DATED_CHARS = 64 * 1024

/** Ids of the background tasks still running, from the lines of a transcript. */
export function runningTasks(lines: string[], now = Date.now()): string[] {
  const running = new Map<string, number>()
  for (const line of lines) {
    if (!MARKERS.test(line)) continue
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
    return runningTasks(recentLines(fd, now - BACKGROUND_TTL_MS), now)
  } catch {
    return []
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * The lines that can start or end a task, oldest first: the transcript is read backwards from its end, until a line is
 * older than `since`, its start, or `MAX_READ_BYTES`.
 */
function recentLines(fd: number, since: number): string[] {
  const found: string[] = []
  /** Whether lines before this one can still matter. */
  const take = (bytes: Buffer): boolean => {
    if (!bytes.length) return true
    const line = bytes.toString('utf8')
    if (MARKERS.test(line)) found.push(line)
    const at = lineTime(line)
    return at === null || at >= since
  }
  let position = fstatSync(fd).size
  const floor = Math.max(0, position - MAX_READ_BYTES)
  // The line being put together from its end, in the chunks read so far, in the order of the file.
  let rest: Buffer[] = []
  while (position > floor) {
    const length = Math.min(CHUNK_BYTES, position - floor)
    position -= length
    const chunk = Buffer.alloc(length)
    readSync(fd, chunk, 0, length, position)
    let end = length
    for (let newline = chunk.lastIndexOf(0x0a, end - 1); newline !== -1; newline = end > 0 ? chunk.lastIndexOf(0x0a, end - 1) : -1) {
      const line = rest.length ? Buffer.concat([chunk.subarray(newline + 1, end), ...rest]) : chunk.subarray(newline + 1, end)
      rest = []
      if (!take(line)) return found.reverse()
      end = newline
    }
    if (end > 0) rest.unshift(chunk.subarray(0, end))
  }
  // The first line of the file is whole; a line the cap cuts is not.
  if (position === 0) take(Buffer.concat(rest))
  return found.reverse()
}

/** When a line was written, or null for a line too long to parse only for that, or without a date. */
function lineTime(line: string): number | null {
  if (line.length > DATED_CHARS) return null
  try {
    const timestamp = (JSON.parse(line) as { timestamp?: unknown } | null)?.timestamp
    return typeof timestamp === 'string' ? Date.parse(timestamp) || null : null
  } catch {
    return null
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
