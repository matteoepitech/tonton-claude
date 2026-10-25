import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { paths } from '../config'

const POLL_MS = 700
/** Before giving up on the hook link and guessing from the working directory. */
const GUESS_AFTER_MS = 4000

export interface SessionLink {
  sessionId: string
  transcriptPath: string | null
  cwd: string | null
}

/**
 * Finds which Claude Code session this channel belongs to. Hooks and the channel are both children of the same
 * claude process, so hooks write `run/<parent pid>.json` and the channel reads its own. If no hook wrote it yet,
 * the newest transcript of the working directory is used.
 */
export class SessionLinkWatcher {
  private current: SessionLink | null = null
  private timer: Timer | null = null
  private readonly startedAt = Date.now()
  private readonly linkFile = join(paths.run, `${process.ppid}.json`)

  constructor(private readonly onChange: (link: SessionLink) => void) {}

  start() {
    this.poll()
    this.timer = setInterval(() => this.poll(), POLL_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  private poll() {
    let next = this.readLinkFile() ?? (this.current || Date.now() - this.startedAt < GUESS_AFTER_MS ? null : this.guessFromCwd())
    if (!next) return
    // Some hook events carry no transcript path: keep the one already known for this session.
    if (next.sessionId === this.current?.sessionId && !next.transcriptPath) next = { ...next, transcriptPath: this.current.transcriptPath }
    if (next.sessionId === this.current?.sessionId && next.transcriptPath === this.current?.transcriptPath) return
    this.current = next
    this.onChange(next)
  }

  private readLinkFile(): SessionLink | null {
    try {
      return JSON.parse(readFileSync(this.linkFile, 'utf8')) as SessionLink
    } catch {
      return null
    }
  }

  private guessFromCwd(): SessionLink | null {
    const cwd = process.cwd()
    const dir = join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    try {
      const newest = readdirSync(dir)
        .filter(file => file.endsWith('.jsonl'))
        .map(file => ({ file, modified: statSync(join(dir, file)).mtimeMs }))
        .sort((a, b) => b.modified - a.modified)[0]
      if (!newest || newest.modified < this.startedAt - 5000) return null
      return { sessionId: newest.file.replace(/\.jsonl$/, ''), transcriptPath: join(dir, newest.file), cwd }
    } catch {
      return null
    }
  }
}
