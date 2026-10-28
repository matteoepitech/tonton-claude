import { basename } from 'node:path'
import { seal } from '../../../shared/crypto'
import type { AgentMessage, ContextUsage, Entry, PermissionDetail, SealedEntry, TokenCounts, TurnTime } from '../../../shared/protocol'
import { latestTodos, taskProgress } from '../../../shared/todos'
import { paths } from '../config'
import { gitBranch } from '../git'
import { setPoolRules } from '../rules'
import { type ParsedLine, parseLine } from '../transcript/parser'
import { Subagents } from '../transcript/subagents'
import { Tailer } from '../transcript/tailer'
import { modelName, newerLimit, readUsageFile, type SessionUsage } from '../usage'
import { PoolSafety } from './pool-safety'
import { poolUsage } from './pool-usage'
import { PoolWork } from './pool-work'
import { SessionPools } from './pools'
import type { SessionLink } from './session-link'
import { SessionShares } from './shares'
import { COMMANDS, runCommand } from './terminal'

const BACKLOG_SIZE = 400
/** Subagents' calls are kept apart, so a busy one can't push the conversation itself out of the backlog. */
const SUBAGENT_BACKLOG_SIZE = 300
/** Turns that ended while the Mac was away: more than this many before it comes back, and the oldest go uncounted. */
const KEPT_TURNS = 20
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
  private turns: TurnTime[] = []
  /** Only a change of the status line's model counts, so a reading it left earlier never hides a newer response. */
  private statusLineModel: string | undefined
  private lastUsage: string | null = null
  private usageTimer: Timer | null = null
  private readonly pending = new Map<string, PendingPermission>()
  private readonly tailer: Tailer | null
  private readonly subagents: Subagents | null
  private subEntries: Entry[] = []
  /** Every subagent entry sent, so a transcript read again doesn't send one twice, even after it left the backlog. */
  private readonly sentSubIds = new Set<string>()
  /** Read-only shares of this session: each gets its own sealed copy. */
  readonly shares: SessionShares
  /** The pools this session works for, with their keys. */
  readonly pools: SessionPools
  /** Claude's pool tools, and the tasks and messages the pool sends it. */
  readonly work: PoolWork
  /** Budgets, stops and the pool rules its owner accepted. */
  readonly safety: PoolSafety

  constructor(
    readonly link: SessionLink,
    private readonly machine: string,
    private readonly key: string,
    private readonly canChat: boolean,
    private readonly post: Post,
    /** Hands Claude what its pools send it, and tells Claude Code the pool tools changed. */
    pool: { deliver(text: string): void; toolsChanged(): void } = { deliver: () => {}, toolsChanged: () => {} },
  ) {
    this.shares = new SessionShares(
      () => link.sessionId,
      key,
      post,
      () => withoutOldImages(this.entries),
    )
    this.pools = new SessionPools(() => link.sessionId, key, post)
    this.work = new PoolWork(
      this.pools,
      () => link.sessionId,
      post,
      text => pool.deliver(text),
      () => ({
        tool: 'claude',
        model: this.model,
        usage: poolUsage({ tokens: this.tokens, ...this.usage }),
        // The plan's windows from the status line: the pool plans around them (agent/src/channel/pool-limits.ts).
        plan: { fiveHour: this.usage.fiveHourLimit, sevenDay: this.usage.sevenDayLimit },
      }),
      () => pool.toolsChanged(),
    )
    this.safety = new PoolSafety(
      this.pools,
      () => link.sessionId,
      post,
      () => ({ costUSD: this.costUSD, turns: this.turns }),
      {
        interrupt: () => {
          const command = {
            name: 'interrupt' as const,
            sessionId: link.sessionId,
            id: crypto.randomUUID(),
            issuedAt: new Date().toISOString(),
          }
          const result = runCommand(command, link.sessionId, link.tmux ?? null, { run: paths.run })
          return result.typed ? null : (result.why ?? 'it could not be typed in the terminal.')
        },
        notice: text => this.notice(text),
        // The PermissionRequest hook runs in its own process: it reads them from the session's file.
        rulesChanged: rules => setPoolRules(link.sessionId, rules),
      },
    )
    this.work.useSafety(this.safety)
    this.work.useRepository(() => this.cwd())
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
    this.subagents = link.transcriptPath
      ? new Subagents(link.transcriptPath, (entries, backlog) => this.onSubEntries(entries, backlog))
      : null
  }

  start() {
    // Subagents first: what they wrote before goes out with the session's backlog, not as news.
    this.subagents?.start()
    if (this.tailer) this.tailer.start()
    else this.announce()
    this.usageTimer = setInterval(() => this.readUsage(), USAGE_POLL_MS)
  }

  stop() {
    this.tailer?.stop()
    this.subagents?.stop()
    if (this.usageTimer) clearInterval(this.usageTimer)
    this.work.stop()
  }

  /** Everything the relay needs after a (re)connection. */
  announce() {
    const { sessionId } = this.link
    const cwd = this.cwd()
    const backlog = [...withoutOldImages(this.entries), ...this.subEntries]
    const info = { machine: this.machine, platform: process.platform, cwd, project: projectOf(cwd) }
    this.post(async () => ({ t: 'hello', sessionId, info: await seal(this.key, info), channel: this.canChat }))
    this.post(async () => ({ t: 'entries', sessionId, entries: await this.sealEntries(backlog), reset: true }))
    this.postMeta()
    for (const requestId of this.pending.keys()) this.postPermission(requestId)
  }

  /**
   * Calls of a subagent, under the Task call that started it. The backlog, written before the session was followed,
   * waits for the announce: sent as news, it would evict the conversation from the relay and mark an idle session as
   * working.
   */
  private onSubEntries(entries: Entry[], backlog: boolean) {
    const fresh = entries.filter(entry => !this.sentSubIds.has(entry.id))
    if (!fresh.length) return
    for (const entry of fresh) this.sentSubIds.add(entry.id)
    this.subEntries = [...this.subEntries, ...fresh].slice(-SUBAGENT_BACKLOG_SIZE)
    if (backlog) return
    this.post(async () => ({ t: 'entries', sessionId: this.link.sessionId, entries: await this.sealEntries(fresh), reset: false }))
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
      // A transcript read again (replaced, or after a reset) brings back turns already kept.
      const turn = parsed.turn
      if (turn && !this.turns.some(kept => kept.end === turn.end)) {
        this.turns = [...this.turns, turn].slice(-KEPT_TURNS)
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
      turns: this.turns.length ? this.turns : undefined,
    }
    this.post(async () => ({ t: 'meta', sessionId: this.link.sessionId, meta: await seal(this.key, meta) }))
    this.shares.setInfo({ project: projectOf(this.cwd()), title: this.title })
    this.work.descriptionChanged()
    this.safety.usageChanged()
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
