// Where Codex keeps its sessions on this machine, read as Codex lays them out: `$CODEX_HOME` (by default ~/.codex), with
// one rollout per thread under `sessions/YYYY/MM/DD/`, compressed to `.jsonl.zst` once a week old, and the names a user
// gave threads in `session_index.jsonl`. Codex starts its MCP servers with a cleared environment, so a channel may not
// see CODEX_HOME: it finds the folder from the rollout a hook named instead.

import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const DAY_MS = 86_400_000
/** A rollout's first line, its session_meta, holds the session's instructions: tens of kilobytes. */
const FIRST_LINE_BYTES = 512 * 1024
const ROLLOUT = /^rollout-.+\.jsonl(\.zst)?$/

export const codexHome = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string => env.CODEX_HOME || join(home, '.codex')

/** `<home>/sessions/YYYY/MM/DD/rollout-….jsonl` gives `<home>`, or nothing for a file elsewhere. */
export function homeOfRollout(file: string): string | undefined {
  const sessions = dirname(dirname(dirname(dirname(file))))
  return basename(sessions) === 'sessions' ? dirname(sessions) : undefined
}

/** The rollouts written to since `since`, compressed or not, oldest folder first. */
export function rolloutFiles(sessions: string, since: number, now = Date.now()): string[] {
  const files: string[] = []
  for (const day of dayFolders(sessions, since, now)) {
    for (const name of list(day)) {
      const path = join(day, name)
      try {
        if (ROLLOUT.test(name) && statSync(path).mtimeMs >= since) files.push(path)
      } catch {}
    }
  }
  return files
}

/** The day folders from `since` to now, in local time as Codex names them, plus one either side for time zones. */
function dayFolders(sessions: string, since: number, now: number): string[] {
  const folders: string[] = []
  for (let at = since - DAY_MS; at <= now + DAY_MS; at += DAY_MS) {
    const day = new Date(at)
    const folder = join(
      sessions,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0'),
    )
    if (!folders.includes(folder)) folders.push(folder)
  }
  return folders
}

/** A rollout's lines, from a plain or a compressed file. */
export function rolloutLines(file: string): string[] {
  const data = readFileSync(file)
  const plain = file.endsWith('.zst') ? Bun.zstdDecompressSync(data) : data
  return Buffer.from(plain).toString('utf8').split('\n')
}

/** The session_meta of a plain rollout, read from its first line only. */
export function rolloutMeta(file: string): { id?: string; sessionId?: string; cwd?: string; subagent: boolean } | null {
  try {
    const fd = openSync(file, 'r')
    let first: string
    try {
      const buffer = Buffer.alloc(FIRST_LINE_BYTES)
      const read = readSync(fd, buffer, 0, FIRST_LINE_BYTES, 0)
      first = buffer.subarray(0, read).toString('utf8').split('\n')[0]
    } finally {
      closeSync(fd)
    }
    const line = JSON.parse(first) as { type?: unknown; payload?: Record<string, unknown> }
    if (line.type !== 'session_meta' || !line.payload) return null
    const { id, session_id, cwd, parent_thread_id, source } = line.payload
    return {
      ...(typeof id === 'string' ? { id } : {}),
      ...(typeof session_id === 'string' ? { sessionId: session_id } : typeof id === 'string' ? { sessionId: id } : {}),
      ...(typeof cwd === 'string' ? { cwd } : {}),
      subagent: typeof parent_thread_id === 'string' || Boolean(source && typeof source === 'object' && 'subagent' in source),
    }
  } catch {
    return null
  }
}

/**
 * The newest rollout of a session in `cwd` written to since `since`: what a channel follows while no hook told it its
 * session, because Codex runs hooks only once its user trusted them. Subagents' rollouts are left out.
 */
export function newestRollout(
  cwd: string,
  since: number,
  sessions = join(codexHome(), 'sessions'),
  now = Date.now(),
): { sessionId: string; file: string; modified: number } | null {
  let newest: { sessionId: string; file: string; modified: number } | null = null
  const folder = real(cwd)
  for (const file of rolloutFiles(sessions, since, now)) {
    if (file.endsWith('.zst')) continue
    try {
      const modified = statSync(file).mtimeMs
      if (newest && modified <= newest.modified) continue
      const meta = rolloutMeta(file)
      if (!meta?.sessionId || meta.subagent || !meta.cwd || real(meta.cwd) !== folder) continue
      newest = { sessionId: meta.sessionId, file, modified }
    } catch {}
  }
  return newest
}

/** The name a user gave a thread (`/rename`), the newest entry winning, or nothing. */
export function threadName(home: string, threadId: string): string | undefined {
  let name: string | undefined
  try {
    for (const line of readFileSync(join(home, 'session_index.jsonl'), 'utf8').split('\n')) {
      if (!line.includes(threadId)) continue
      try {
        const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown }
        if (entry.id === threadId && typeof entry.thread_name === 'string' && entry.thread_name.trim()) name = entry.thread_name.trim()
      } catch {}
    }
  } catch {}
  return name
}

/** The same folder whichever way it is written: macOS's /tmp and /var are links to /private. */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function list(folder: string): string[] {
  try {
    return readdirSync(folder)
  } catch {
    return []
  }
}
