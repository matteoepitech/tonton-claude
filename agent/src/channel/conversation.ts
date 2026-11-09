import { statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { seal } from '../../../shared/crypto'
import type { ContextUsage, Entry, PermissionDetail, SealedEntry, TokenCounts, TurnTime } from '../../../shared/protocol'
import { cutText } from '../../../shared/text'
import { latestTodos, taskProgress } from '../../../shared/todos'
import { EventDetector } from '../cluster/detect'
import { homeOfRollout, threadName } from '../codex/home'
import { codexPlanWindows } from '../codex/limits'
import { CODEX_COMMANDS } from '../codex/notch'
import { type CodexLine, type CodexRateLimits, CodexRollout } from '../codex/rollout'
import { type AgentConfig, paths } from '../config'
import { gitBranch } from '../git'
import { postHook } from '../hook'
import { log } from '../log'
import type { AgentRPG } from '../rpg'
import { setPoolMode, setPoolRules } from '../rules'
import { backlogImages, forgetOldImages } from '../transcript/images'
import { type ParsedLine, parseLine } from '../transcript/parser'
import { Subagents } from '../transcript/subagents'
import { Tailer } from '../transcript/tailer'
import { TranscriptWork, type WorkFacts } from '../transcript/work'
import { modelName, newerLimit, readUsageFile, type SessionUsage } from '../usage'
import { deferClusterPost, forgetClusterPosts } from './cluster-digest'
import { ClusterAutoJoin } from './cluster-joins'
import { type ClusterHooks, ClusterWork, CODEX_MAX_WAIT_MINUTES, relayFiles } from './cluster-work'
import { SessionClusters } from './clusters'
import { PoolSafety } from './pool-safety'
import { poolUsage } from './pool-usage'
import { PoolWork } from './pool-work'
import { SessionPools } from './pools'
import { entriesMessages, type Outgoing } from './relay-connection'
import { hookState, type SessionLink } from './session-link'
import { SessionShares } from './shares'
import { COMMANDS, runCommand } from './terminal'

const BACKLOG_SIZE = 400
/** Subagents' calls are kept apart, so a busy one can't push the conversation itself out of the backlog. */
const SUBAGENT_BACKLOG_SIZE = 300
/** Turns that ended while the Mac was away: more than this many before it comes back, and the oldest go uncounted. */
const KEPT_TURNS = 20
/** How often the usage left by the status line is checked. */
const USAGE_POLL_MS = 1000

type Post = (build: () => Promise<Outgoing>) => void

interface PendingPermission extends PermissionDetail {
  ts: string
}

/** How the session's tool takes cluster posts, from the channel. */
export interface ClusterIntake {
  live: ClusterHooks['live']
  toolsChanged(): void
  /** Claude is in a turn, as the tool says it: missing, as its hooks last wrote it. */
  busy?(): boolean
  /** False when nothing can hand Claude a post before its next prompt (a plain `codex`). Missing: it takes them. */
  takesLive?: boolean
}

/** State of the session this channel serves, and the messages that keep the relay in sync with it. */
export class Conversation {
  /** A Codex session: its rollout is read instead of a Claude Code transcript (agent/src/codex/rollout.ts). */
  private readonly codex: boolean
  /** Codex's rollouts are read with what came before in them: calls are matched to their output. */
  private rollout: CodexRollout | null
  /** The name a Codex user gave the thread, and when its index was last read. */
  private codexName: { name?: string; read: number } = { read: 0 }
  /** The plan's usage Codex last reported, for its limits (#373). */
  codexLimits: CodexRateLimits | undefined
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
  /** Turns, tasks and pushes, for XP. Read again from the start with the transcript. */
  private workLog = new TranscriptWork()
  private pushes = new EventDetector()
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
  /** The clusters this session is in, with their keys: apart from its pools, they never mix. */
  readonly clusters: SessionClusters
  /** Claude's cluster tools, and the posts the clusters send it. */
  readonly cluster: ClusterWork
  /** The clusters the machine owner put this session's folder in, with `tonton cluster join`. */
  private readonly autoJoin: ClusterAutoJoin | null
  /** Reads the session's shell calls as they come, for its clusters. Made at the first live lines, in the session's folder. */
  private detector: EventDetector | null = null

  constructor(
    readonly link: SessionLink,
    private readonly machine: string,
    private readonly key: string,
    private readonly canChat: boolean,
    private readonly post: Post,
    /**
     * Hands Claude what its pools send it, and tells Claude Code the pool tools changed. A Codex session's turn is
     * stopped through `interrupt`, on its app-server: none for a plain codex.
     */
    pool: { deliver(text: string): void; toolsChanged(): void; interrupt?(): Promise<string | null> } = {
      deliver: () => {},
      toolsChanged: () => {},
    },
    /** This machine: a pool machine's mode applies to the sessions it started here only. */
    private readonly machineId = '',
    private readonly rpg?: AgentRPG,
    /** Hands Claude what its clusters send it, and tells Claude Code the cluster tools changed. */
    cluster: ClusterIntake = { live: () => {}, toolsChanged: () => {} },
    /** The machine's setup, for the clusters its owner put this session's folder in; none in the tests. */
    private readonly config?: AgentConfig,
  ) {
    this.codex = link.tool === 'codex'
    this.rollout = this.codex ? new CodexRollout() : null
    this.shares = new SessionShares(
      () => link.sessionId,
      key,
      post,
      () => backlogImages(this.entries),
    )
    this.pools = new SessionPools(() => link.sessionId, key, post)
    this.work = new PoolWork(
      this.pools,
      () => link.sessionId,
      post,
      text => pool.deliver(text),
      () => {
        // The plan's windows: Claude Code's from the status line, Codex's (its ChatGPT plan) from the rollout. The pool
        // plans around them, each tool's apart (agent/src/channel/pool-limits.ts).
        const windows = this.codex ? codexPlanWindows(this.codexLimits) : {}
        const plan = this.codex
          ? { fiveHour: windows.codexFiveHourLimit, sevenDay: windows.codexSevenDayLimit }
          : { fiveHour: this.usage.fiveHourLimit, sevenDay: this.usage.sevenDayLimit }
        return {
          tool: this.codex ? 'codex' : 'claude',
          model: this.model,
          usage: poolUsage({ tokens: this.tokens, fiveHourLimit: plan.fiveHour, sevenDayLimit: plan.sevenDay }),
          plan,
        }
      },
      () => pool.toolsChanged(),
    )
    this.safety = new PoolSafety(
      this.pools,
      () => link.sessionId,
      post,
      () => ({ costUSD: this.costUSD, turns: this.turns }),
      {
        interrupt: () => {
          if (this.codex) return pool.interrupt?.() ?? 'this Codex session takes nothing from Tonton.'
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
        // The PermissionRequest hook runs in its own process: it reads them, and the mode, from the session's files.
        rulesChanged: rules => {
          setPoolRules(link.sessionId, rules)
          const mode = this.pools.workerMode(this.machineId)
          setPoolMode(link.sessionId, mode ? { mode, root: this.cwd() } : null)
        },
      },
    )
    this.work.useSafety(this.safety)
    this.work.useRepository(() => this.cwd())
    this.work.useRewards((id, state) => this.rpg?.pool(id, state, this.link.sessionId, this.pools.vault(id)?.keyring))
    this.clusters = new SessionClusters(() => link.sessionId, key, post)
    this.cluster = new ClusterWork(
      this.clusters,
      () => link.sessionId,
      post,
      {
        live: text => cluster.live(text),
        // The UserPromptSubmit hook hands them to Claude with the next prompt (agent/src/channel/cluster-digest.ts), Codex's
        // too (agent/src/codex/hook.ts).
        defer: (clusterId, text) => deferClusterPost(link.sessionId, clusterId, text),
        forget: clusterId => forgetClusterPosts(link.sessionId, clusterId),
        busy: () => cluster.busy?.() ?? hookState().busy,
        skipsPrompts: () => hookState().skipsPrompts,
        takesLive: () => cluster.takesLive !== false,
        cwd: () => this.cwd(),
        ...(config ? { files: relayFiles(config) } : {}),
        ...(this.codex ? { maxWaitMinutes: CODEX_MAX_WAIT_MINUTES } : {}),
      },
      () => this.clusterSelf(),
      () => cluster.toolsChanged(),
    )
    this.autoJoin = config
      ? new ClusterAutoJoin(
          config,
          () => link.sessionId,
          () => this.cwd(),
          this.clusters,
          post,
          order => this.cluster.joinProfile(order),
        )
      : null
    this.tailer = link.transcriptPath
      ? new Tailer(link.transcriptPath, {
          lines: (lines, initial) => this.onLines(lines, initial),
          reset: () => {
            this.entries = []
            this.rollout = this.codex ? new CodexRollout() : null
            this.workLog = new TranscriptWork()
            this.pushes = new EventDetector()
            this.tokens = undefined
            this.countedRequests.clear()
            this.context = undefined
          },
        })
      : null
    // Codex's subagents write rollouts of their own, which their parent's does not name.
    this.subagents =
      link.transcriptPath && !this.codex
        ? new Subagents(link.transcriptPath, (entries, backlog) => this.onSubEntries(entries, backlog))
        : null
  }

  start() {
    // Subagents first: what they wrote before goes out with the session's backlog, not as news.
    this.subagents?.start()
    if (this.tailer) this.tailer.start()
    else this.announce()
    // Codex has no status line: its usage is in the rollout.
    if (!this.codex) this.usageTimer = setInterval(() => this.readUsage(), USAGE_POLL_MS)
    this.autoJoin?.start()
  }

  stop() {
    this.tailer?.stop()
    this.subagents?.stop()
    if (this.usageTimer) clearInterval(this.usageTimer)
    this.work.stop()
    this.autoJoin?.stop()
  }

  /** The hooks wrote the session's link again, or may have: its clusters see how it takes posts now. */
  hooksRead() {
    this.cluster.followHooks()
  }

  /** How this session shows in its clusters: the folder's name, never its path. */
  private clusterSelf() {
    const cwd = this.cwd()
    const tool = this.codex ? ('codex' as const) : ('claude' as const)
    return { tool, model: this.model, project: projectOf(cwd), machine: this.machine, ...branchOf(cwd) }
  }

  /** Everything the relay needs after a (re)connection. */
  announce() {
    const { sessionId } = this.link
    const cwd = this.cwd()
    const backlog = [...backlogImages(this.entries), ...this.subEntries]
    const tool = this.codex ? { tool: 'codex' as const } : {}
    const info = { machine: this.machine, platform: process.platform, cwd, project: projectOf(cwd), ...tool }
    this.post(async () => ({ t: 'hello', sessionId, info: await seal(this.key, info), channel: this.canChat }))
    this.postEntries(backlog, true)
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
    this.postEntries(fresh, false)
  }

  /** A line from the agent in the conversation, such as why a command from the notch was not typed. */
  notice(text: string) {
    const entry: Entry = { id: `notice-${crypto.randomUUID()}`, ts: new Date().toISOString(), kind: 'system', text }
    this.remember([entry])
    this.postEntries([entry], false)
    this.shares.entries([entry])
  }

  addPermission(requestId: string, detail: PermissionDetail) {
    this.pending.set(requestId, { ...detail, ts: new Date().toISOString() })
    this.postPermission(requestId)
  }

  /** No longer asked: answered in the terminal, or its turn ended. The notch, the website and the phone take it away. */
  closePermission(requestId: string) {
    if (!this.pending.has(requestId)) return
    this.resolvePermission(requestId)
    this.post(async () => ({ t: 'permission_closed', sessionId: this.link.sessionId, requestId }))
  }

  /** Answered from the notch, the website or the phone: from the request to the answer, the turn waited and did not work. */
  resolvePermission(requestId: string) {
    const asked = this.pending.get(requestId)
    if (asked) this.workLog.waited(Date.now() - Date.parse(asked.ts))
    this.pending.delete(requestId)
  }

  private onLines(lines: string[], initial: boolean) {
    const fresh: Entry[] = []
    const commands: Record<string, string> = {}
    const work: WorkFacts = { turns: [], tasks: [] }
    let metaChanged = false
    let status: 'working' | 'idle' | undefined
    for (const line of lines) {
      const parsed: CodexLine = this.rollout ? this.rollout.line(line) : parseLine(line)
      if (parsed.rateLimits) {
        const before = JSON.stringify(codexPlanWindows(this.codexLimits))
        this.codexLimits = parsed.rateLimits
        if (JSON.stringify(codexPlanWindows(this.codexLimits)) !== before) metaChanged = true
      }
      if (parsed.status) status = parsed.status
      fresh.push(...parsed.entries)
      Object.assign(commands, parsed.commands)
      const facts = this.workLog.line(parsed)
      work.turns.push(...facts.turns)
      work.tasks.push(...facts.tasks)
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
    this.remember(fresh)
    // The first read is the past: it tells the trackers where the session is, and the welcome backfill paid it once.
    const vcs = this.pushes.work(fresh, id => this.workLog.command(id))
    const inPool = this.pools.ids().length > 0 || this.workLog.pool
    if (!initial) this.rpg?.work(this.link.sessionId, { ...work, vcs, cwd: this.workLog.cwd ?? this.cwd() }, inPool)
    if (initial) return this.announce()
    // What its shell calls tell its clusters: commits, pushes, submits, builds, files opened (agent/src/cluster/detect.ts).
    this.detector ??= new EventDetector(this.cwd())
    this.cluster.observe(this.detector.read(fresh, id => commands[id]))

    const { sessionId } = this.link
    if (status) this.postStatus(status)
    if (fresh.length) this.postEntries(fresh, false)
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
    const title = (this.codex ? this.threadName() : undefined) ?? this.title
    const meta = {
      title,
      costUSD: this.costUSD,
      tokens: this.tokens,
      context: this.context,
      lastMessage: last && 'text' in last ? cutText(last.text, 200) : undefined,
      ...this.usage,
      // Codex's windows, apart from Claude's (shared/protocol.ts, SessionMeta).
      ...(this.codex ? codexPlanWindows(this.codexLimits) : {}),
      // Without tmux nothing can be typed: the notch offers no command. Codex takes its commands from its app-server,
      // when `tonton codex` runs it (canChat), and nothing is ever typed in it.
      terminal: Boolean(this.link.tmux) && !this.codex,
      commands: this.codex ? (this.canChat ? [...CODEX_COMMANDS] : []) : this.link.tmux ? [...COMMANDS] : [],
      model: this.model,
      ...branchOf(this.cwd()),
      tasks: taskProgress(latestTodos(this.entries)) ?? undefined,
      turns: this.turns.length ? this.turns : undefined,
    }
    this.post(async () => ({ t: 'meta', sessionId: this.link.sessionId, meta: await seal(this.key, meta) }))
    this.shares.setInfo({ project: projectOf(this.cwd()), title, ...(this.codex ? { tool: 'codex' as const } : {}) })
    this.work.descriptionChanged()
    this.cluster.descriptionChanged()
    this.safety.usageChanged()
  }

  private cwd(): string {
    return this.link.cwd ?? process.cwd()
  }

  /**
   * A turn of Codex started or ended, as its rollout says. Its hooks say so too once its user trusted them; until then,
   * and when a turn fails or is interrupted, which run no Stop hook, the rollout is all there is.
   */
  private postStatus(status: 'working' | 'idle') {
    if (!this.codex || !this.config) return
    const event = { hook_event_name: status === 'working' ? 'UserPromptSubmit' : 'Stop', session_id: this.link.sessionId }
    void postHook(this.config, event).catch(error => log('codex status failed', String(error)))
  }

  /** The name a Codex user gave the thread with /rename, read again when Codex's index of names changes. */
  private threadName(): string | undefined {
    const home = this.link.transcriptPath ? homeOfRollout(this.link.transcriptPath) : undefined
    if (!home) return undefined
    const modified = statSync(join(home, 'session_index.jsonl'), { throwIfNoEntry: false })?.mtimeMs ?? 0
    if (modified !== this.codexName.read) this.codexName = { name: threadName(home, this.link.sessionId), read: modified }
    return this.codexName.name
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

  /** Adds to the backlog. Past its latest entries, images are never sent again: they are let go as entries get there. */
  private remember(fresh: Entry[]) {
    this.entries = forgetOldImages([...this.entries, ...fresh].slice(-BACKLOG_SIZE))
  }

  /** Several messages when they would be too big for one. */
  private postEntries(entries: Entry[], reset: boolean) {
    this.post(async () => entriesMessages(this.link.sessionId, await this.sealEntries(entries), reset))
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
