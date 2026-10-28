import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { open, seal } from '../../../shared/crypto'
import type {
  Entry,
  PermissionRule,
  PromptPayload,
  RelayToAgent,
  SealedEntry,
  SessionCommand,
  SessionInfo,
  TurnTime,
} from '../../../shared/protocol'
import { latestTodos, taskProgress } from '../../../shared/todos'
import { withAttachments } from '../channel'
import { branchOf, isTodoWrite, projectOf } from '../channel/conversation'
import { PoolSafety } from '../channel/pool-safety'
import { poolUsage } from '../channel/pool-usage'
import { PoolWork } from '../channel/pool-work'
import { SessionPools } from '../channel/pools'
import { RelayConnection } from '../channel/relay-connection'
import { SessionShares } from '../channel/shares'
import { claimCommand, whyInvalid } from '../channel/terminal'
import { type AgentConfig, loadConfig, paths } from '../config'
import { receiveDiagnoseRequest } from '../diagnose'
import { postHook } from '../hook'
import { openCodeStarts } from '../launch'
import { log } from '../log'
import { handleLogRequest } from '../logs'
import { AgentRPG } from '../rpg'
import { matchingRule, modeAllows, openSessionRules, readRules, receiveRules } from '../rules'
import { OPENCODE_COMMANDS, type OpenCodePermission, OpenCodeTracker, type SessionUpdate } from './events'

const BACKLOG_SIZE = 400
/** How often the bridge looks for sessions started from the notch. */
const STARTS_POLL_MS = 1000
/** The relay takes request ids of 32 characters at most. */
const MAX_REQUEST_ID = 32

/** What the bridge asks the plugin to do in OpenCode, one JSON line on its stdout each. */
export type PluginCommand =
  | { op: 'prompt'; sessionID: string; directory?: string; text: string; providerID?: string; modelID?: string }
  | { op: 'model'; sessionID: string; directory?: string; providerID: string; modelID: string }
  | { op: 'reply'; sessionID: string; directory?: string; requestID: string; decision: 'once' | 'reject' }
  | { op: 'compact'; sessionID: string; directory?: string; providerID?: string; modelID?: string }
  | { op: 'interrupt'; sessionID: string; directory?: string }
  | { op: 'history'; sessionID: string; directory?: string }
  | { op: 'models' }
  /** The answer to a pool tool OpenCode called (`tonton.tool`). */
  | { op: 'tool_result'; callID: string; output: string }

type Send = (command: PluginCommand) => void

/** One OpenCode session as the relay sees it: its own connection, like the channel of a Claude Code session. */
class Link {
  private readonly rpg: AgentRPG
  private entries: Entry[] = []
  private readonly relay: RelayConnection
  private readonly pending = new Map<string, OpenCodePermission & { ts: string }>()
  /** Messages sent from the notch, waiting to show up in the conversation. */
  private readonly fromNotch: string[] = []
  /** OpenCode 1 takes the model with each message: the one the notch switched to, if it did. */
  private chosenModel: { providerID: string; modelID: string } | undefined
  /** What "Allow for this session" allowed: gone with the bridge, when OpenCode exits. */
  private readonly sessionRules: PermissionRule[] = []
  /** Read-only shares of this session, as for Claude Code. */
  private readonly shares: SessionShares
  /** The pools this session works for, as for Claude Code. */
  readonly pools: SessionPools
  /** Claude's pool tools for this session, and what the pool sends it, as for Claude Code. */
  readonly work: PoolWork
  /** Budgets, stops and the pool rules its owner accepted, as for Claude Code. */
  readonly safety: PoolSafety
  /** Turns that ended, from the statuses OpenCode reports, for the time budgets: OpenCode writes no turn times. */
  private turns: TurnTime[] = []
  private turnStarted: number | null = null

  constructor(
    readonly sessionId: string,
    private readonly config: AgentConfig,
    private readonly tracker: OpenCodeTracker,
    private readonly send: Send,
  ) {
    this.rpg = new AgentRPG(config)
    this.relay = new RelayConnection(config, 'channel', {
      connected: () => this.announce(),
      message: message => this.onRelay(message),
      pool: update => this.pools.apply(update),
    })
    this.shares = new SessionShares(
      () => sessionId,
      config.key,
      build => this.relay.post(build),
      () => this.entries,
    )
    this.pools = new SessionPools(
      () => sessionId,
      config.key,
      build => this.relay.post(build),
    )
    // A task or a message from the pool goes in like a message from the notch. OpenCode's tool list is the plugin's: it
    // does not change while OpenCode runs.
    this.work = new PoolWork(
      this.pools,
      () => sessionId,
      build => this.relay.post(build),
      text => this.send({ op: 'prompt', sessionID: sessionId, directory: this.cwd(), text, ...this.chosenModel }),
      () => {
        const meta = this.tracker.meta(sessionId)
        return { tool: 'opencode', model: meta.model, usage: poolUsage(meta) }
      },
    )
    this.safety = new PoolSafety(
      this.pools,
      () => sessionId,
      build => this.relay.post(build),
      () => ({ costUSD: this.tracker.meta(sessionId).costUSD, turns: this.turns }),
      {
        interrupt: () => {
          this.send({ op: 'interrupt', sessionID: sessionId, directory: this.cwd() })
          return null
        },
        notice: text => this.add([{ id: `notice-${crypto.randomUUID()}`, ts: new Date().toISOString(), kind: 'system', text }]),
        // OpenCode's permissions are answered here, in the bridge: the rules stay in memory.
        rulesChanged: () => {},
      },
    )
    this.work.useSafety(this.safety)
    this.work.useRepository(() => this.cwd())
    this.work.useRewards((id, state) => this.rpg.pool(id, state, this.sessionId))
    this.relay.connect()
  }

  add(entries: Entry[]) {
    const marked = entries.map(entry => this.markFromNotch(entry))
    this.entries = [...this.entries, ...marked].slice(-BACKLOG_SIZE)
    this.rpg.observe(this.sessionId, this.entries, this.pools.ids().length > 0, marked)
    if (marked.length)
      this.relay.post(async () => ({ t: 'entries', sessionId: this.sessionId, entries: await this.seal(marked), reset: false }))
    this.shares.entries(marked)
    if (marked.some(isTodoWrite)) this.postMeta()
  }

  /** OpenCode's own history arrived: it replaces what the relay holds. */
  reset(history: Entry[]) {
    const known = new Map(this.entries.map(entry => [entry.id, entry]))
    this.entries = history.map(entry => known.get(entry.id) ?? entry).slice(-BACKLOG_SIZE)
    const entries = this.entries
    this.relay.post(async () => ({ t: 'entries', sessionId: this.sessionId, entries: await this.seal(entries), reset: true }))
    this.shares.entries(entries, true)
    if (entries.some(isTodoWrite)) this.postMeta()
  }

  postMeta() {
    const meta = {
      ...this.tracker.meta(this.sessionId),
      ...branchOf(this.cwd() ?? process.cwd()),
      tasks: taskProgress(latestTodos(this.entries)) ?? undefined,
    }
    this.relay.post(async () => ({ t: 'meta', sessionId: this.sessionId, meta: await seal(this.config.key, meta) }))
    this.shares.setInfo({ project: projectOf(this.cwd() ?? process.cwd()), title: meta.title, tool: 'opencode' })
    this.work.descriptionChanged()
    this.safety.usageChanged()
  }

  /** A status from OpenCode: a turn starts with the prompt and ends when OpenCode is done or fails. */
  turn(hook: string) {
    if (hook === 'UserPromptSubmit') this.turnStarted ??= Date.now()
    else if ((hook === 'Stop' || hook === 'StopFailure' || hook === 'SessionEnd') && this.turnStarted !== null) {
      const seconds = Math.round((Date.now() - this.turnStarted) / 1000)
      this.turns = [...this.turns, { end: new Date().toISOString(), seconds }].slice(-20)
      this.turnStarted = null
      this.safety.usageChanged()
    }
  }

  /** Shows a request in the notch, unless an auto-approve rule from the app answers it. */
  ask(permission: OpenCodePermission) {
    const rules = [...(readRules()?.rules ?? []), ...this.sessionRules, ...this.pools.acceptedRules()]
    const rule = matchingRule(rules, permission.detail.toolName, permission.input)
    // A pool machine's session: the mode its owner chose, sealed with the account key in its order, in its own folder.
    const mode = this.pools.workerMode(this.config.machineId)
    const root = this.cwd()
    if (rule || (mode && root && modeAllows({ mode, root }, permission.detail.toolName, permission.input))) {
      log(rule ? 'approved by an auto-approve rule' : 'approved by the pool machine’s mode', {
        tool: rule?.tool ?? permission.detail.toolName,
      })
      this.send({ op: 'reply', sessionID: this.sessionId, directory: this.cwd(), requestID: permission.requestId, decision: 'once' })
      return
    }
    this.pending.set(permission.requestId, { ...permission, ts: new Date().toISOString() })
    this.postPermission(permission.requestId)
  }

  close(requestId: string) {
    if (!this.pending.delete(requestId)) return
    this.relay.post(async () => ({ t: 'permission_closed', sessionId: this.sessionId, requestId: shortId(requestId) }))
  }

  stop() {
    this.rpg.stop()
    this.relay.stop()
    this.work.stop()
  }

  flushed(): Promise<void> {
    return this.relay.flushed()
  }

  private cwd(): string | undefined {
    return this.tracker.cwd(this.sessionId)
  }

  /** Everything the relay needs after a (re)connection. */
  private announce() {
    const cwd = this.cwd() ?? process.cwd()
    const info: SessionInfo = { machine: this.config.machine, platform: process.platform, cwd, project: projectOf(cwd), tool: 'opencode' }
    const { sessionId, entries } = this
    this.relay.post(async () => ({ t: 'hello', sessionId, info: await seal(this.config.key, info), channel: true }))
    this.relay.post(async () => ({ t: 'entries', sessionId, entries: await this.seal(entries), reset: true }))
    this.postMeta()
    for (const requestId of this.pending.keys()) this.postPermission(requestId)
  }

  private onRelay(message: RelayToAgent) {
    if (message.t === 'rules') void receiveRules(this.config.key, message.rules)
    // Without a background service, the relay may ask any connection of the machine for its log.
    if (message.t === 'agent_logs') void handleLogRequest(this.config, message.requestId, message.request, this.relay)
    if (message.t === 'diagnose') void receiveDiagnoseRequest(this.config, message.requestId, message.request, this.relay, 'channel')
    if (!('sessionId' in message) || message.sessionId !== this.sessionId) return
    if (message.t === 'share') this.shares.receive(message.shareId, message.order)
    else if (message.t === 'unshare') this.shares.remove(message.shareId)
    else if (message.t === 'pool_join') this.pools.receive(message.poolId, message.order, message.acceptance)
    else if (message.t === 'pool_left') this.pools.remove(message.poolId)
    else if (message.t === 'pool_stop') this.pools.stop(message.poolId)
    else if (message.t === 'pool_accept') this.pools.accept(message.poolId, message.acceptance)
    else if (message.t === 'verdict') {
      const permission = [...this.pending.values()].find(item => shortId(item.requestId) === message.requestId)
      if (!permission) return
      if (message.behavior === 'allow' && message.rule) void this.allowForSession(message.rule, message.requestId)
      const decision = message.behavior === 'allow' ? 'once' : 'reject'
      this.send({ op: 'reply', sessionID: this.sessionId, directory: this.cwd(), requestID: permission.requestId, decision })
      this.close(permission.requestId)
    } else if (message.t === 'prompt') {
      void this.prompt(message.payload)
    }
  }

  private async allowForSession(sealed: string, requestId: string) {
    this.sessionRules.push(...(await openSessionRules(this.config.key, sealed, this.sessionId, requestId)))
  }

  private async prompt(sealed: string) {
    let prompt: PromptPayload
    try {
      prompt = await open<PromptPayload>(this.config.key, sealed)
    } catch {
      log('dropped a prompt that does not decrypt with the account key')
      return
    }
    if (prompt.command) return this.command(prompt.command)
    const text = withAttachments(prompt)
    this.fromNotch.push(text)
    this.send({ op: 'prompt', sessionID: this.sessionId, directory: this.cwd(), text, ...this.chosenModel })
  }

  private command(command: SessionCommand) {
    const refuse = (why: string) =>
      this.add([{ id: `notice-${crypto.randomUUID()}`, ts: new Date().toISOString(), kind: 'system', text: why }])
    const invalid = whyInvalid(command, this.sessionId)
    if (invalid) return refuse(invalid)
    if (!OPENCODE_COMMANDS.includes(command.name)) return refuse(`/${command.name} was not run: OpenCode has no such command.`)
    const claimed = claimCommand(command, paths.run)
    if (claimed !== true) return claimed.why ? refuse(claimed.why) : undefined
    log('command from the notch', { name: command.name, tool: 'opencode' })
    if (command.name === 'interrupt') this.send({ op: 'interrupt', sessionID: this.sessionId, directory: this.cwd() })
    else if (command.name === 'model') this.switchModel(command.model ?? '')
    else this.send({ op: 'compact', sessionID: this.sessionId, directory: this.cwd(), ...this.tracker.model(this.sessionId) })
  }

  /** `/model opus` in Claude Code: the latest Opus OpenCode has, for this session and the next messages. */
  private switchModel(family: string) {
    const model = this.tracker.familyModel(this.sessionId, family)
    if (!model) {
      const why = `/model ${family} was not run: OpenCode has no ${family} model.`
      this.add([{ id: `notice-${crypto.randomUUID()}`, ts: new Date().toISOString(), kind: 'system', text: why }])
      return
    }
    const { providerID, modelID } = model
    this.chosenModel = { providerID, modelID }
    this.send({ op: 'model', sessionID: this.sessionId, directory: this.cwd(), providerID, modelID })
    // OpenCode 1 has nothing to switch: the next message carries the model. Either way the notch shows it now.
    for (const update of this.tracker.switched(this.sessionId, { providerID, modelID })) if (update.metaChanged) this.postMeta()
  }

  /** The conversation says when a message came from the notch, as for Claude Code: the app takes its "sending…" off. */
  private markFromNotch(entry: Entry): Entry {
    if (entry.kind !== 'user') return entry
    const index = this.fromNotch.indexOf(entry.text)
    if (index < 0) return entry
    this.fromNotch.splice(index, 1)
    return { ...entry, viaNotch: true }
  }

  private postPermission(requestId: string) {
    const permission = this.pending.get(requestId)
    if (!permission) return
    const { ts, detail } = permission
    this.relay.post(async () => ({
      t: 'permission',
      sessionId: this.sessionId,
      request: { requestId: shortId(requestId), ts, blob: await seal(this.config.key, detail) },
    }))
  }

  private seal(entries: Entry[]): Promise<SealedEntry[]> {
    return Promise.all(entries.map(async entry => ({ id: entry.id, ts: entry.ts, blob: await seal(this.config.key, entry) })))
  }
}

const shortId = (id: string) => (id.length > MAX_REQUEST_ID ? id.slice(-MAX_REQUEST_ID) : id)

/**
 * Started by Tonton's OpenCode plugin, one per OpenCode process: reads its events as JSON lines on stdin, keeps the relay
 * in sync with each of its sessions, and writes on stdout what the notch asks OpenCode to do. Ends with OpenCode, when
 * stdin closes.
 */
export async function runOpenCode() {
  const config = loadConfig()
  if (!config) {
    log('opencode: not enrolled, staying idle')
    for await (const _ of Bun.stdin.stream());
    return
  }
  log('opencode bridge started', { parent: process.ppid, cwd: process.cwd() })
  const send: Send = command => process.stdout.write(`${JSON.stringify(command)}\n`)
  const tracker = new OpenCodeTracker()
  const links = new Map<string, Link>()
  // Status changes go out in order, each after the previous one.
  let statuses: Promise<void> = Promise.resolve()
  send({ op: 'models' })

  const apply = (update: SessionUpdate) => {
    let link = links.get(update.sessionId)
    if (!link) {
      link = new Link(update.sessionId, config, tracker, send)
      links.set(update.sessionId, link)
      // A session met halfway, after a restart of OpenCode or of the bridge: its history comes from OpenCode.
      send({ op: 'history', sessionID: update.sessionId, directory: tracker.cwd(update.sessionId) })
    }
    if (update.history) link.reset(update.history)
    link.add(update.entries)
    if (update.metaChanged) link.postMeta()
    if (update.permission) link.ask(update.permission)
    if (update.permissionClosed) link.close(update.permissionClosed)
    const { status } = update
    if (status) link.turn(status.hook)
    if (status) {
      const event = { hook_event_name: status.hook, session_id: update.sessionId, notification_type: status.notificationType }
      statuses = statuses.then(() => postHook(config, event, status.text)).catch(error => log('opencode: status failed', String(error)))
    }
  }

  // Sessions started from the notch: made in OpenCode's service, which says nothing about them until they are written to.
  const starts = setInterval(() => {
    for (const start of takeStarts(paths.run)) {
      const event = { type: 'session.created', data: { sessionID: start.sessionId, location: { directory: start.cwd } } }
      for (const update of tracker.handle(event)) apply(update)
      // The tracker says nothing new about a session it knows: it gets a link all the same.
      if (!links.has(start.sessionId)) apply({ sessionId: start.sessionId, entries: [], metaChanged: true })
    }
  }, STARTS_POLL_MS)

  for await (const line of lines(Bun.stdin.stream())) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const tool = poolToolCall(event)
    if (tool) {
      const link = links.get(tool.sessionID)
      void (link ? link.work.call(tool.name, tool.args) : Promise.resolve('This session is not in a pool.')).then(output =>
        send({ op: 'tool_result', callID: tool.callID, output }),
      )
      continue
    }
    for (const update of tracker.handle(event)) apply(update)
  }

  // OpenCode exited: its sessions end with it.
  clearInterval(starts)
  log('opencode bridge: OpenCode exited')
  await statuses
  await Promise.all(
    [...links.values()].map(async link => {
      await postHook(config, { hook_event_name: 'SessionEnd', session_id: link.sessionId }).catch(() => {})
      await link.flushed()
      link.stop()
    }),
  )
  process.exit(0)
}

/** A pool tool OpenCode called through the plugin: `{ type: 'tonton.tool', data: { callID, sessionID, name, args } }`. */
export function poolToolCall(event: unknown): { callID: string; sessionID: string; name: string; args: Record<string, unknown> } | null {
  const fields = event as { type?: unknown; data?: Record<string, unknown> } | null
  if (fields?.type !== 'tonton.tool' || !fields.data) return null
  const { callID, sessionID, name, args } = fields.data
  if (typeof callID !== 'string' || typeof sessionID !== 'string' || typeof name !== 'string') return null
  const plain = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
  return { callID, sessionID, name, args: plain }
}

/** The sessions the launcher left for a bridge, each taken once. */
export function takeStarts(run: string): { sessionId: string; cwd: string }[] {
  const folder = openCodeStarts(run)
  let files: string[]
  try {
    files = readdirSync(folder).filter(file => /^ses_[A-Za-z0-9]+\.json$/.test(file))
  } catch {
    return []
  }
  return files.flatMap(file => {
    const path = join(folder, file)
    try {
      const start = JSON.parse(readFileSync(path, 'utf8')) as { sessionId?: unknown; cwd?: unknown }
      rmSync(path, { force: true })
      return typeof start.sessionId === 'string' && typeof start.cwd === 'string' ? [{ sessionId: start.sessionId, cwd: start.cwd }] : []
    } catch {
      return []
    }
  })
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) yield line
      newline = buffer.indexOf('\n')
    }
  }
  if (buffer.trim()) yield buffer.trim()
}
