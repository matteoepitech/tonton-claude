// The end of the agent log, sent to the app on request so a machine can be looked at from the Mac (Settings › Machines).
// Sealed on the way like the rest. The log only says what the agent does, never what Claude writes; secrets are taken out
// before it leaves, since a log is made to be pasted into a bug report.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { open, seal } from '../../shared/crypto'
import type { AgentLog, LogRequest } from '../../shared/protocol'
import type { RelayConnection } from './channel/relay-connection'
import { type AgentConfig, paths } from './config'

/** Older requests get no lines, so the relay cannot replay one later. */
const REQUEST_TTL_MS = 10 * 60_000
export const LOG_LINES = 300
/** Read from the end of the file, which is never read whole. */
const TAIL_BYTES = 96 * 1024
/** What the lines may weigh once encoded, well under the relay's cap for the sealed log. */
const MAX_JSON_BYTES = 160 * 1024
const MAX_LINE = 4000

export interface LogTail {
  lines: string[]
  truncated: boolean
  size: number
}

/** The last lines of a log. A line cut by the start of the read is left out. */
export function readLogTail(file: string, maxLines = LOG_LINES, maxBytes = TAIL_BYTES): LogTail {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return { lines: [], truncated: false, size: 0 }
  }
  const length = Math.min(size, maxBytes)
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  let read: number
  try {
    read = readSync(fd, buffer, 0, length, size - length)
  } finally {
    closeSync(fd)
  }
  const all = buffer.subarray(0, read).toString('utf8').split(/\r?\n/)
  const lines = (length < size ? all.slice(1) : all).filter(Boolean)
  return {
    lines: lines.slice(-maxLines).map(line => line.slice(0, MAX_LINE)),
    truncated: length < size || lines.length > maxLines,
    size,
  }
}

/** Takes out the account key, the machine's credential, tokens and proxy passwords, whoever logged them. */
export function redact(line: string, secrets: string[]): string {
  let text = line
  for (const secret of secrets) if (secret.length >= 16) text = text.split(secret).join('[redacted]')
  return text
    .replace(/tonton_[A-Za-z0-9_-]{16,}/g, 'tonton_[redacted]')
    .replace(/\b(t[am]_[A-Za-z0-9_-]{12}_)[A-Za-z0-9_-]{43}/g, '$1[redacted]')
    .replace(/\b(bearer\s+)[^\s"',]+/gi, '$1[redacted]')
    .replace(/(\w+:\/\/[^/\s:@]+):[^@\s/]+@/g, '$1:[redacted]@')
}

/**
 * A request from the app: answers with the end of the log, sealed. Requests that do not open with the account key or
 * name another machine get no answer; an old one gets a reason instead of lines.
 */
export async function handleLogRequest(
  config: AgentConfig,
  requestId: string,
  sealed: string,
  relay: Pick<RelayConnection, 'post'>,
  { file = paths.log, now = Date.now() }: { file?: string; now?: number } = {},
) {
  const request = await open<LogRequest>(config.key, sealed).catch(() => null)
  if (!request || request.requestId !== requestId || request.machineId !== config.machineId) return
  const answer = (body: Pick<AgentLog, 'lines' | 'truncated' | 'size' | 'error'>) => {
    const logs: AgentLog = { requestId, machineId: config.machineId, at: new Date(now).toISOString(), ...body }
    relay.post(async () => ({ t: 'agent_logs', requestId, logs: await seal(config.key, logs) }))
  }
  if (!(Math.abs(now - Date.parse(request.issuedAt)) <= REQUEST_TTL_MS))
    return answer({ lines: [], truncated: false, size: 0, error: 'The request expired. Check the clock of this machine.' })
  try {
    const tail = readLogTail(file)
    const lines = tail.lines.map(line => redact(line, [config.key, config.token]))
    answer({ size: tail.size, ...fitting(lines, tail.truncated) })
  } catch (error) {
    answer({ lines: [], truncated: false, size: 0, error: `Could not read the log: ${error instanceof Error ? error.message : error}` })
  }
}

/** The newest lines that fit in one message. */
function fitting(lines: string[], truncated: boolean): { lines: string[]; truncated: boolean } {
  let kept = lines
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify(kept)) > MAX_JSON_BYTES) kept = kept.slice(Math.ceil(kept.length / 4))
  return { lines: kept, truncated: truncated || kept.length < lines.length }
}
