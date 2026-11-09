import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { newestRollout } from '../codex/home'
import { readServerRecord } from '../codex/wrapper'
import { claudeConfigDir, paths } from '../config'
import type { TerminalPane } from './terminal'

const POLL_MS = 700
/** Before giving up on the hook link and guessing from the working directory. */
const GUESS_AFTER_MS = 4000
/** Claude Code cuts longer project folder names, and ends them with a hash of the path. */
const PROJECT_NAME_MAX = 200

export interface SessionLink {
  sessionId: string
  transcriptPath: string | null
  cwd: string | null
  /** Where Claude Code runs, when it runs in tmux. Missing from links written by older hooks. */
  tmux?: TerminalPane | null
  /** The last hook event, `Notification:<type>` for notifications. Missing from links written by older hooks. */
  event?: string
  /** Claude Code's permission mode, as the last hook said it. */
  permissionMode?: string
  /** A Codex session, linked by Codex's hooks (agent/src/codex/hook.ts). Missing for Claude Code. */
  tool?: 'codex'
}

/** Hook events after which Claude is in a turn: it took a prompt, or waits on a permission prompt within one. */
const IN_TURN = ['UserPromptSubmit', 'PermissionRequest', 'Notification:permission_prompt']

/**
 * What the hooks last wrote of this channel's session, read again each time: whether Claude is in a turn, and whether it
 * skips permission prompts. Cluster delivery asks (agent/src/channel/cluster-work.ts).
 */
export function hookState(file = join(paths.run, `${process.ppid}.json`)): { busy: boolean; skipsPrompts: boolean } {
  try {
    const link = JSON.parse(readFileSync(file, 'utf8')) as SessionLink
    return { busy: IN_TURN.includes(link.event ?? ''), skipsPrompts: link.permissionMode === 'bypassPermissions' }
  } catch {
    return { busy: false, skipsPrompts: false }
  }
}

/**
 * Finds which Claude Code or Codex session this channel belongs to. Hooks and the channel are both children of the same
 * claude or codex process, so hooks write `run/<parent pid>.json` and the channel reads its own. If no hook wrote it yet,
 * a Codex run by `tonton codex` is the first thread its server started, as `tonton codex` records it: Codex runs no
 * hook its user has not trusted, and writes no rollout before the first prompt, which for a pool machine's session is
 * the task the channel hands it. Otherwise the newest transcript or rollout of the working directory is used.
 */
export class SessionLinkWatcher {
  private current: SessionLink | null = null
  private timer: Timer | null = null
  private readonly startedAt = Date.now()
  private readonly linkFile = join(paths.run, `${process.ppid}.json`)

  constructor(
    private readonly onChange: (link: SessionLink) => void,
    private readonly tool: 'claude' | 'codex' = 'claude',
  ) {}

  start() {
    this.poll()
    this.timer = setInterval(() => this.poll(), POLL_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  private poll() {
    let next =
      this.readLinkFile() ??
      this.fromServer() ??
      (this.current || Date.now() - this.startedAt < GUESS_AFTER_MS ? null : this.guessFromCwd())
    if (!next) return
    // Some hook events carry no transcript path: keep the one already known for this session.
    if (next.sessionId === this.current?.sessionId && !next.transcriptPath) next = { ...next, transcriptPath: this.current.transcriptPath }
    const sameTerminal = JSON.stringify(next.tmux ?? null) === JSON.stringify(this.current?.tmux ?? null)
    if (next.sessionId === this.current?.sessionId && next.transcriptPath === this.current?.transcriptPath && sameTerminal) return
    this.current = next
    this.onChange(next)
  }

  private readLinkFile(): SessionLink | null {
    try {
      const link = JSON.parse(readFileSync(this.linkFile, 'utf8')) as SessionLink
      return this.tool === 'codex' ? { ...link, tool: 'codex' } : link
    } catch {
      return null
    }
  }

  /** The thread `tonton codex` started for this codex: the session the notch or a pool machine started. */
  private fromServer(): SessionLink | null {
    if (this.tool !== 'codex') return null
    const thread = readServerRecord(process.ppid)?.threads[0]
    if (!thread) return null
    return { sessionId: thread.id, transcriptPath: thread.path ?? null, cwd: thread.cwd ?? process.cwd(), tool: 'codex' }
  }

  private guessFromCwd(): SessionLink | null {
    const cwd = process.cwd()
    if (this.tool === 'codex') {
      // Codex starts its MCP servers in the session's folder, and writes the rollout at the first prompt.
      const rollout = newestRollout(cwd, this.startedAt - 5000)
      return rollout ? { sessionId: rollout.sessionId, transcriptPath: rollout.file, cwd, tool: 'codex' } : null
    }
    const newest = newestTranscript(cwd)
    if (!newest || newest.modified < this.startedAt - 5000) return null
    return { sessionId: newest.sessionId, transcriptPath: newest.file, cwd }
  }
}

/**
 * The newest transcript Claude Code keeps for `cwd`. Its folder is the path with every character but letters and digits
 * as `-`; past 200 characters, the name is cut and followed by a hash this agent can't compute, so any folder that starts
 * the same way may be it.
 */
export function newestTranscript(
  cwd: string,
  projects = join(claudeConfigDir(), 'projects'),
): { sessionId: string; file: string; modified: number } | null {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const prefix = `${name.slice(0, PROJECT_NAME_MAX)}-`
  let folders = [name]
  try {
    if (name.length > PROJECT_NAME_MAX) folders = readdirSync(projects).filter(folder => folder.startsWith(prefix))
  } catch {
    return null
  }
  let newest: { sessionId: string; file: string; modified: number } | null = null
  for (const folder of folders) {
    try {
      for (const file of readdirSync(join(projects, folder))) {
        if (!file.endsWith('.jsonl')) continue
        const path = join(projects, folder, file)
        const modified = statSync(path).mtimeMs
        if (!newest || modified > newest.modified) newest = { sessionId: file.slice(0, -'.jsonl'.length), file: path, modified }
      }
    } catch {
      // No transcript for this folder yet.
    }
  }
  return newest
}
