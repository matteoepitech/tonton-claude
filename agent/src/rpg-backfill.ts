// The welcome backfill of XP version 2: the last two weeks of this machine's Claude Code transcripts, OpenCode history and
// Codex rollouts, read by the same code as the live agent (transcript/work.ts, cluster/detect.ts, opencode/events.ts,
// codex/rollout.ts), so every reward has the id the live agent gives it. Run again, it finds the same ids, and the hero
// counts each once. No format is public: what isn't recognized is skipped, never thrown.

import { createReadStream, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { RPGReward } from '../../shared/rpg'
import { EventDetector, type VcsWork } from './cluster/detect'
import { codexHome, rolloutFiles, rolloutLines } from './codex/home'
import { CodexRollout } from './codex/rollout'
import { OpenCodeTracker } from './opencode/events'
import { BACKFILL_DAYS, workRewards } from './rpg-work'
import { isPoolPost, parseLine } from './transcript/parser'
import { type TaskFact, TranscriptWork, type TurnFact } from './transcript/work'

const DAY_MS = 86_400_000
/** A session's id names its transcript: `<id>.jsonl`. */
const TRANSCRIPT = /^[0-9a-f-]{8,64}\.jsonl$/i
/** And ends the name of a Codex rollout: `rollout-<time>-<id>.jsonl`. */
const ROLLOUT_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/i

export interface BackfillSources {
  /** Claude Code's `projects` folder, one folder per project with a transcript per session. */
  claude: string
  /** OpenCode 1's database. */
  opencode: string
  /** Codex's `sessions` folder, one folder per day with a rollout per thread. */
  codex?: string
}

/** Where Claude Code, OpenCode and Codex keep their history on this machine, as they find it themselves. */
export function backfillSources(env: NodeJS.ProcessEnv = process.env, home = homedir()): BackfillSources {
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share')
  return {
    claude: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects'),
    opencode: join(data, 'opencode', 'opencode.db'),
    codex: join(codexHome(env, home), 'sessions'),
  }
}

/** Everything the tools did since `days` ago on this machine, as rewards: only Codex's when the others are left out. */
export async function backfillRewards(sources: Partial<BackfillSources>, now = Date.now(), days = BACKFILL_DAYS): Promise<RPGReward[]> {
  const since = now - days * DAY_MS
  return [
    ...(sources.claude ? await claudeRewards(sources.claude, since) : []),
    ...(sources.opencode ? await openCodeRewards(sources.opencode, since) : []),
    ...(sources.codex ? await codexRewards(sources.codex, since, now) : []),
  ]
}

async function claudeRewards(projects: string, since: number): Promise<RPGReward[]> {
  const rewards: RPGReward[] = []
  for (const file of transcripts(projects, since)) {
    try {
      rewards.push(...(await transcriptRewards(file, since)))
    } catch {
      // Unreadable or removed meanwhile: the other sessions still count.
    }
  }
  return rewards
}

/** Transcripts written to since `since`. Subagents' are in folders of their own: their work is in their parent's turn. */
function transcripts(projects: string, since: number): string[] {
  const files: string[] = []
  for (const project of list(projects)) {
    for (const name of list(join(projects, project))) {
      const path = join(projects, project, name)
      try {
        if (TRANSCRIPT.test(name) && statSync(path).mtimeMs >= since) files.push(path)
      } catch {}
    }
  }
  return files
}

/** One transcript, line by line as the live agent reads it: a file can be hundreds of megabytes. */
export async function transcriptRewards(file: string, since: number): Promise<RPGReward[]> {
  const work = new TranscriptWork()
  const pushes = new EventDetector()
  const turns: TurnFact[] = []
  const tasks: TaskFact[] = []
  const vcs: VcsWork[] = []
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    const parsed = parseLine(line)
    const facts = work.line(parsed)
    turns.push(...facts.turns)
    tasks.push(...facts.tasks)
    vcs.push(...pushes.work(parsed.entries, id => work.command(id)))
  }
  return workRewards(basename(file, '.jsonl'), { turns, tasks, vcs, cwd: work.cwd }, work.pool, since)
}

async function codexRewards(sessions: string, since: number, now: number): Promise<RPGReward[]> {
  const rewards: RPGReward[] = []
  for (const file of rolloutFiles(sessions, since, now)) {
    try {
      rewards.push(...(await rolloutRewards(file, since)))
    } catch {
      // Unreadable, or compressed meanwhile: the other sessions still count.
    }
  }
  return rewards
}

/**
 * One Codex rollout, line by line as the live channel reads it, under the session id its hooks give: the one its
 * session_meta names. A week-old rollout is compressed (`.jsonl.zst`), and read whole. A subagent's thread earns
 * nothing of its own: its work is in its parent's turn.
 */
export async function rolloutRewards(file: string, since: number): Promise<RPGReward[]> {
  const rollout = new CodexRollout()
  const work = new TranscriptWork()
  const pushes = new EventDetector()
  const turns: TurnFact[] = []
  const tasks: TaskFact[] = []
  const vcs: VcsWork[] = []
  let session = ROLLOUT_ID.exec(file)?.[1]
  let named = false
  const lines = file.endsWith('.zst')
    ? rolloutLines(file)
    : createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    if (!line.trim()) continue
    const parsed = rollout.line(line)
    // The first session_meta is the rollout's own: a forked thread may hold its parent's further on.
    if (parsed.session && !named) {
      if (parsed.session.subagent) return []
      session = parsed.session.sessionId
      named = true
    }
    const facts = work.line(parsed)
    turns.push(...facts.turns)
    tasks.push(...facts.tasks)
    vcs.push(...pushes.work(parsed.entries, id => work.command(id)))
  }
  return session ? workRewards(session, { turns, tasks, vcs, cwd: work.cwd }, work.pool, since) : []
}

interface Row {
  id: string
  data: string
}

/**
 * OpenCode 1 keeps its sessions in SQLite. Each message and part goes through the tracker as its event would, so a turn,
 * a task or a push has the id the bridge gives it live. Subagent sessions are left out, as live.
 */
async function openCodeRewards(path: string, since: number): Promise<RPGReward[]> {
  let database: import('bun:sqlite').Database
  try {
    statSync(path)
    const { Database } = await import('bun:sqlite')
    database = new Database(path, { readonly: true })
  } catch {
    return []
  }
  const rewards: RPGReward[] = []
  try {
    const sessions = database
      .query<{ id: string; directory: string }, [number]>('SELECT id, directory FROM session WHERE parent_id IS NULL AND time_updated >= ?')
      .all(since)
    const messages = database.query<Row, [string]>('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id')
    const parts = database.query<Row & { message_id: string }, [string]>(
      'SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id',
    )
    for (const session of sessions) {
      try {
        rewards.push(...(await openCodeSession(session.id, session.directory, messages.all(session.id), parts.all(session.id), since)))
      } catch {
        // A session OpenCode wrote in a shape the tracker doesn't know: the others still count.
      }
    }
  } catch {
    // Another version of OpenCode's schema: nothing to read from it.
  } finally {
    database.close()
  }
  return rewards
}

/** One OpenCode session from its rows, through the tracker as the bridge reads it. */
export async function openCodeSession(
  sessionID: string,
  cwd: string,
  messages: readonly Row[],
  parts: readonly (Row & { message_id: string })[],
  since: number,
): Promise<RPGReward[]> {
  const tracker = new OpenCodeTracker()
  const work = new TranscriptWork()
  const pushes = new EventDetector()
  const tasks: TaskFact[] = []
  const vcs: VcsWork[] = []
  const read = (event: unknown) => {
    for (const update of tracker.handle(event)) {
      tasks.push(...work.line({ entries: update.entries }).tasks)
      vcs.push(...pushes.work(update.entries, id => tracker.command(sessionID, id)))
    }
  }
  read({ type: 'session.updated', properties: { info: { id: sessionID, directory: cwd } } })
  for (const message of messages)
    read({ type: 'message.updated', properties: { info: { ...json(message.data), id: message.id, sessionID } } })
  for (const part of parts)
    read({ type: 'message.part.updated', properties: { part: { ...json(part.data), id: part.id, messageID: part.message_id, sessionID } } })
  const pool = parts.some(part => {
    const fields = json(part.data)
    return fields.type === 'text' && typeof fields.text === 'string' && isPoolPost(fields.text)
  })
  return workRewards(sessionID, { turns: tracker.finishedTurns(sessionID), tasks, vcs, cwd }, pool, since)
}

function json(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function list(folder: string): string[] {
  try {
    return readdirSync(folder)
  } catch {
    return []
  }
}
