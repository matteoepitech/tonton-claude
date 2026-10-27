import { basename } from 'node:path'
import { seal } from '../../../shared/crypto'
import type { AgentMessage, ContextUsage, Entry, PermissionDetail, SealedEntry, TokenCounts } from '../../../shared/protocol'
import { latestTodos, taskProgress } from '../../../shared/todos'
import { gitBranch } from '../git'
import { type ParsedLine, parseLine } from '../transcript/parser'
import { Tailer } from '../transcript/tailer'
import { modelName, newerLimit, readUsageFile, type SessionUsage } from '../usage'
import type { SessionLink } from './session-link'
import { SessionShares } from './shares'
import { COMMANDS } from './terminal'

const BACKLOG_SIZE = 400
/** On reconnect only the latest entries keep their images, the rest is sent as text. */
const BACKLOG_IMAGES = 40
/** How often the usage left by the status line is checked. */
const USAGE_POLL_MS = 1000

type Post = (build: () => Promise<AgentMessage | null>) => void

interface PendingPermission extends PermissionDetail {
  ts: string
}

/** State of the session this channel serves, and the messages that keep the relay in sync with it. */
export class Conversation {
  private entries: Entry[] = []
  private title: string | undefined
  private costUSD: number | undefined
  private tokens: TokenCounts | undefined
  /** API responses already in `tokens`. */
  private readonly countedRequests = new Set<string>()
  private context: ContextUsage | undefined
  /** The status line knows the window for sure; the transcript only gives the model's name. */
  private windowFromStatusLine = false
  private usage: SessionUsage = {}
  private model: string | undefined
  /** Only a change of the status line's model counts, so a reading it left earlier never hides a newer response. */
  private statusLineModel: string | undefined
  private lastUsage: string | null = null
  private usageTimer: Timer | null = null
  private readonly pending = new Map<string, PendingPermission>()
  private readonly tailer: Tailer | null
  /** Read-only shares of this session: each gets its own sealed copy. */
  readonly shares: SessionShares

  constructor(
    readonly link: SessionLink,
    private readonly machine: string,
    private readonly key: string,
    private readonly canChat: boolean,
    private readonly post: Post,
  ) {
    this.shares = new SessionShares(
      () => link.sessionId,
      key,
      post,
      () => withoutOldImages(this.entries),
    )
    this.tailer = link.transcriptPath
      ? new Tailer(link.transcriptPath, {
          lines: (lines, initial) => this.onLines(lines, initial),
          reset: () => {
            this.entries = []
            this.tokens = undefined
            this.countedRequests.clear()
            this.context = undefined
          },
        })
      : null
  }

  start() {
    if (this.tailer) this.tailer.start()
    else this.announce()
    this.usageTimer = setInterval(() => this.readUsage(), USAGE_POLL_MS)
  }

  stop() {
    this.tailer?.stop()
    if (this.usageTimer) clearInterval(this.usageTimer)
  }

  /** Everything the relay needs after a (re)connection. */
  announce() {
    const { sessionId } = this.link
    const cwd = this.cwd()
    const backlog = withoutOldImages(this.entries)
    const info = { machine: this.machine, platform: process.platform, cwd, project: projectOf(cwd) }
    this.post(async () => ({ t: 'hello', sessionId, info: await seal(this.key, info), channel: this.canChat }))
    this.post(async () => ({ t: 'entries', sessionId, entries: await this.sealEntries(backlog), reset: true }))
    this.postMeta()
    for (const requestId of this.pending.keys()) this.postPermission(requestId)
  }

  /** A line from the agent in the conversation, such as why a command from the notch was not typed. */
  notice(text: string) {
    const entry: Entry = { id: `notice-${crypto.randomUUID()}`, ts: new Date().toISOString(), kind: 'system', text }
    this.entries.push(entry)
    this.post(async () => ({ t: 'entries', sessionId: this.link.sessionId, entries: await this.sealEntries([entry]), reset: false }))
    this.shares.entries([entry])
  }

  addPermission(requestId: string, detail: PermissionDetail) {
    this.pending.set(requestId, { ...detail, ts: new Date().toISOString() })
    this.postPermission(requestId)
  }

  resolvePermission(requestId: string) {
    this.pending.delete(requestId)
  }

  private onLines(lines: string[], initial: boolean) {
    const fresh: Entry[] = []
    let metaChanged = false
    for (const line of lines) {
      const parsed = parseLine(line)
      fresh.push(...parsed.entries)
      if (parsed.title !== undefined && parsed.title !== this.title) {
        this.title = parsed.title
        metaChanged = true
      }
      if (parsed.costUSD !== undefined && parsed.costUSD !== this.costUSD) {
        this.costUSD = parsed.costUSD
        metaChanged = true
      }
      if (this.updateUsage(parsed)) metaChanged = true
      if (this.updateContext(parsed)) metaChanged = true
      if (parsed.model && parsed.model !== this.model) {
        this.model = parsed.model
        metaChanged = true
      }
      if (parsed.usage && !this.countedRequests.has(parsed.usage.requestId)) {
        this.countedRequests.add(parsed.usage.requestId)
        this.tokens = addTokens(this.tokens, parsed.usage)
        metaChanged = true
      }
    }
    this.entries = [...this.entries, ...fresh].slice(-BACKLOG_SIZE)
    if (initial) return this.announce()

    const { sessionId } = this.link
    if (fresh.length) this.post(async () => ({ t: 'entries', sessionId, entries: await this.sealEntries(fresh), reset: false }))
    this.shares.entries(fresh)
    if (metaChanged || fresh.some(e => e.kind === 'assistant' || e.kind === 'user' || isTodoWrite(e))) this.postMeta()

    // Once the tool ran or the turn moved on, a relayed prompt was answered (here or in the terminal).
    if (this.pending.size && fresh.some(e => e.kind === 'tool_result' || e.kind === 'user')) {
      for (const requestId of this.pending.keys()) this.post(async () => ({ t: 'permission_closed', sessionId, requestId }))
      this.pending.clear()
    }
  }

  /** Picks up what the status line of this session last wrote. */
  private readUsage() {
    const raw = readUsageFile(this.link.sessionId)
    if (raw === null || raw === this.lastUsage) return
    this.lastUsage = raw
    try {
      const reading = JSON.parse(raw) as SessionUsage
      const costChanged = reading.costUSD !== undefined && reading.costUSD !== this.costUSD
      if (costChanged) this.costUSD = reading.costUSD
      const windowChanged = reading.contextWindow !== undefined && this.setWindow(reading.contextWindow, true)
      // Right after a switch, before the next response says it.
      const model = modelName(reading.model)
      const modelChanged = model !== undefined && model !== this.statusLineModel && model !== this.model
      if (model !== undefined) this.statusLineModel = model
      if (modelChanged) this.model = model
      if (this.updateUsage(reading) || costChanged || windowChanged || modelChanged) this.postMeta()
    } catch {
      // The status line replaces the file in one step: something else wrote this one.
    }
  }

  /**
   * The context is the input of the last API response, as Claude Code counts it, and starts over at a compaction.
   * Returns true when it changed.
   */
  private updateContext(parsed: ParsedLine): boolean {
    let changed = false
    if (parsed.contextWindow !== undefined && !this.windowFromStatusLine) changed = this.setWindow(parsed.contextWindow, false)
    const used = parsed.compacted ? 0 : parsed.usage ? parsed.usage.input + parsed.usage.cacheRead + parsed.usage.cacheWrite : undefined
    if (used === undefined || used === this.context?.usedTokens) return changed
    this.context = { ...this.context, usedTokens: used }
    return true
  }

  private setWindow(windowTokens: number, fromStatusLine: boolean): boolean {
    this.windowFromStatusLine ||= fromStatusLine
    if (windowTokens === this.context?.windowTokens) return false
    this.context = { usedTokens: this.context?.usedTokens ?? 0, windowTokens }
    return true
  }

  /** Keeps the newest reading of each window. Returns true when one changed. */
  private updateUsage(reading: SessionUsage): boolean {
    const next = {
      fiveHourLimit: newerLimit(this.usage.fiveHourLimit, reading.fiveHourLimit),
      sevenDayLimit: newerLimit(this.usage.sevenDayLimit, reading.sevenDayLimit),
    }
    if (next.fiveHourLimit === this.usage.fiveHourLimit && next.sevenDayLimit === this.usage.sevenDayLimit) return false
    this.usage = next
    return true
  }

  private postMeta() {
    const last = this.entries.findLast(e => e.kind === 'assistant' || e.kind === 'user')
    const meta = {
      title: this.title,
      costUSD: this.costUSD,
      tokens: this.tokens,
      context: this.context,
      lastMessage: last && 'text' in last ? last.text.slice(0, 200) : undefined,
      ...this.usage,
      terminal: Boolean(this.link.tmux),
      // Without tmux nothing can be typed: the notch offers no command.
      commands: this.link.tmux ? [...COMMANDS] : [],
      model: this.model,
      ...branchOf(this.cwd()),
      tasks: taskProgress(latestTodos(this.entries)) ?? undefined,
    }
    this.post(async () => ({ t: 'meta', sessionId: this.link.sessionId, meta: await seal(this.key, meta) }))
    this.shares.setInfo({ project: projectOf(this.cwd()), title: this.title })
  }

  private cwd(): string {
    return this.link.cwd ?? process.cwd()
  }

  private postPermission(requestId: string) {
    const permission = this.pending.get(requestId)
    if (!permission) return
    const { ts, ...detail } = permission
    this.post(async () => ({
      t: 'permission',
      sessionId: this.link.sessionId,
      request: { requestId, ts, blob: await seal(this.key, detail) },
    }))
  }

  private sealEntries(entries: Entry[]): Promise<SealedEntry[]> {
    return Promise.all(entries.map(async entry => ({ id: entry.id, ts: entry.ts, blob: await seal(this.key, entry) })))
  }
}

/** Read again with each meta: the branch can change in the terminal at any time. */
export function branchOf(cwd: string): { branch?: string } {
  const branch = gitBranch(cwd)
  return branch ? { branch } : {}
}
/** A new task list changes the progress in the meta. */
export const isTodoWrite = (entry: Entry) => entry.kind === 'tool' && entry.name === 'TodoWrite'

export const projectOf = (cwd: string) => basename(cwd.replace(/\\/g, '/').replace(/\/+$/, '')) || cwd

function addTokens(total: TokenCounts | undefined, response: TokenCounts): TokenCounts {
  return {
    input: (total?.input ?? 0) + response.input,
    output: (total?.output ?? 0) + response.output,
    cacheRead: (total?.cacheRead ?? 0) + response.cacheRead,
    cacheWrite: (total?.cacheWrite ?? 0) + response.cacheWrite,
  }
}

function withoutOldImages(entries: Entry[]): Entry[] {
  const keepFrom = entries.length - BACKLOG_IMAGES
  return entries.map((entry, index) => {
    if (index >= keepFrom || !('images' in entry) || !entry.images?.length) return entry
    const { images, ...rest } = entry
    return { ...rest, text: `${rest.text}\n[${images.length} image${images.length === 1 ? '' : 's'} not loaded]` } as Entry
  })
}
