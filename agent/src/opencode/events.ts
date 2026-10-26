import type { Entry, ImageData, PermissionDetail, SessionCommand, SessionMeta, TokenCounts } from '../../../shared/protocol'
import { fileEdits, toolSummary } from '../transcript/parser'

// OpenCode's plugin events, turned into what the notch shows for a Claude Code session: entries, a status and the meta.
// They are not a format Tonton controls either: anything unexpected is skipped, never thrown. Two families exist:
// OpenCode 1 sends `{ type, properties }` with messages and their parts; OpenCode 2 sends `{ id, type, data }` with one
// event per step of a session (agent/test/fixtures has a real run).

/** The events the plugin forwards: the rest (text deltas, LSP, file watcher…) stays in OpenCode. */
export const FORWARDED_EVENTS = [
  // Both
  'session.created',
  'session.updated',
  'session.deleted',
  'session.error',
  'permission.asked',
  'permission.replied',
  // OpenCode 1
  'session.status',
  'session.idle',
  'message.updated',
  'message.part.updated',
  'message.part.delta',
  'permission.updated',
  // OpenCode 2
  'session.renamed',
  'session.inbox.enqueued',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.execution.cancelled',
  'session.text.ended',
  'session.tool.input.started',
  'session.tool.called',
  'session.tool.success',
  'session.tool.failed',
  'session.step.started',
  'session.model.switched',
  'session.step.ended',
  'session.step.failed',
  'session.compaction.ended',
  'session.compaction.succeeded',
  'session.compaction.failed',
  'session.compacted',
]

/** What the notch can ask an OpenCode session: there is no `/clear` for a session that runs, only a new session. */
export const OPENCODE_COMMANDS: SessionCommand['name'][] = ['compact', 'interrupt', 'model']

/** One model of OpenCode's catalog. */
export interface CatalogModel {
  providerID: string
  modelID: string
  /** Its context window, when OpenCode knows it. */
  context?: number
  /** When it came out, to pick the latest of a family. */
  released?: number
}

const MAX_TOOL_RESULT_CHARS = 4000
/** As for Claude Code: larger images stay out of the conversation. */
const MAX_IMAGE_BASE64 = 4 * 1024 * 1024
const MAX_LAST_MESSAGE_CHARS = 200
/** Event ids already handled: OpenCode 2 hands each event to every plugin instance of the process. */
const SEEN_EVENTS = 4000
/** Entries kept per session for a reconnection, like a Claude Code channel. */
const BACKLOG_SIZE = 400

/** The Claude Code names of OpenCode's built-in tools, so the notch shows them with the same icons and summaries. */
const TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  shell: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  multiedit: 'MultiEdit',
  patch: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  list: 'LS',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead',
  task: 'Task',
  subagent: 'Task',
}
/** The field an auto-approve rule reads for each tool, as in a Claude Code tool call (agent/src/rules.ts). */
const RULE_FIELDS: Record<string, string> = {
  Bash: 'command',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  WebFetch: 'url',
  Glob: 'pattern',
  Grep: 'pattern',
}
/** What a failed command from the notch was meant to do. */
const FAILED_ACTIONS: Record<string, string> = {
  prompt: 'take the message',
  reply: 'take the answer to its request',
  compact: 'compact the conversation',
  interrupt: 'stop',
}
/** OpenCode's input fields under the names the Claude Code parser reads. */
const INPUT_FIELDS: Record<string, string> = { filePath: 'file_path', oldString: 'old_string', newString: 'new_string' }

/** A status change, sent to the relay as the Claude Code hook event that means the same. */
export interface StatusChange {
  hook: 'UserPromptSubmit' | 'Stop' | 'StopFailure' | 'SessionEnd' | 'Notification'
  notificationType?: 'permission_prompt'
  text?: string
}

/** A permission request, and what an auto-approve rule reads of it: the same fields as a Claude Code tool call. */
export interface OpenCodePermission {
  requestId: string
  detail: PermissionDetail
  input: Record<string, string>
}

export interface SessionUpdate {
  sessionId: string
  entries: Entry[]
  status?: StatusChange
  /** The title, cost, tokens, context or last message changed. */
  metaChanged: boolean
  permission?: OpenCodePermission
  /** A request was answered, in the notch or in OpenCode. */
  permissionClosed?: string
  /** The whole conversation, from OpenCode's own history: it replaces what the relay holds. */
  history?: Entry[]
}

type Fields = Record<string, unknown>

interface Part {
  id: string
  messageID: string
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  time?: { start?: number; end?: number }
  callID?: string
  tool?: string
  state?: { status?: string; input?: Fields; output?: string; error?: string; time?: { start?: number }; attachments?: unknown }
  mime?: string
  url?: string
  filename?: string
}

interface MessageInfo {
  role: 'user' | 'assistant'
  created: number
  completed: boolean
}

interface Usage {
  cost: number
  tokens: TokenCounts
}

class TrackedSession {
  cwd: string | undefined
  title: string | undefined
  /** Subagent sessions belong to the task that started them, not to the list. */
  child = false
  /** OpenCode 1. */
  readonly messages = new Map<string, MessageInfo>()
  readonly parts = new Map<string, Part>()
  readonly deltas = new Map<string, string>()
  /** OpenCode 2 names a tool when its input starts, and calls it later by id. */
  readonly toolNames = new Map<string, string>()
  /** Cost and tokens per assistant message. */
  readonly usage = new Map<string, Usage>()
  readonly sent = new Set<string>()
  /** Every entry sent, in order, for the history to add to. */
  order: Entry[] = []
  lastMessage: string | undefined
  lastStatus: string | undefined
  model: { providerID: string; modelID: string } | undefined
  /** The input of the last API call, as the context gauge counts it. */
  contextUsed: number | undefined

  constructor(readonly id: string) {}
}

/** Every session one OpenCode process reports, from its events. */
export class OpenCodeTracker {
  private readonly sessions = new Map<string, TrackedSession>()
  private readonly seen = new Set<string>()
  /** OpenCode's models, for their context window and to switch a session to a family. */
  private catalog: CatalogModel[] = []
  /** When the event being handled happened: OpenCode 2 dates the event, not its data. */
  private eventTime = Date.now()

  /** What changed, per session. */
  handle(event: unknown): SessionUpdate[] {
    if (!event || typeof event !== 'object') return []
    const { id, type, properties, data, created } = event as {
      id?: unknown
      type?: unknown
      properties?: unknown
      data?: unknown
      created?: unknown
    }
    const fields = properties ?? data
    if (typeof type !== 'string' || !fields || typeof fields !== 'object') return []
    if (typeof id === 'string') {
      if (this.seen.has(id)) return []
      this.seen.add(id)
      if (this.seen.size > SEEN_EVENTS) this.seen.delete(this.seen.values().next().value as string)
    }
    this.eventTime = typeof created === 'number' ? created : Date.now()
    // The SDK of OpenCode 2 names its session events `session.next.*`; the events themselves drop the `next`.
    return this.dispatch(type.replace(/^session\.next\./, 'session.'), fields as Fields)
  }

  cwd(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd
  }

  /** The model the session last answered with, which OpenCode 1 needs to compact it. */
  model(sessionId: string): { providerID: string; modelID: string } | undefined {
    return this.sessions.get(sessionId)?.model
  }

  /**
   * The latest model of a family (`opus`, `sonnet`, `haiku`, as the notch's model menu offers them) that the session can
   * switch to: from its own provider first, then from Anthropic, then from any provider that has one.
   */
  familyModel(sessionId: string, family: string): CatalogModel | undefined {
    const matching = this.catalog.filter(model => model.modelID.toLowerCase().includes(family))
    const provider = this.sessions.get(sessionId)?.model?.providerID
    const latest = (models: CatalogModel[]) =>
      [...models].sort((a, b) => (b.released ?? 0) - (a.released ?? 0) || b.modelID.localeCompare(a.modelID))[0]
    return (
      latest(matching.filter(model => model.providerID === provider)) ??
      latest(matching.filter(model => model.providerID === 'anthropic')) ??
      latest(matching)
    )
  }

  /** The session now answers with this model, as the notch asked. */
  switched(sessionId: string, model: { providerID: string; modelID: string }): SessionUpdate[] {
    const session = this.session(sessionId)
    if (!session) return []
    session.model = model
    return this.update(session, [], undefined, true)
  }

  meta(sessionId: string): SessionMeta {
    const session = this.sessions.get(sessionId)
    if (!session) return {}
    const usage = [...session.usage.values()]
    const costUSD = usage.reduce((sum, step) => sum + step.cost, 0)
    const tokens = usage.reduce(addTokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    const current = session.model
    const window = current
      ? this.catalog.find(model => model.providerID === current.providerID && model.modelID === current.modelID)?.context
      : undefined
    return {
      title: session.title,
      ...(usage.length ? { costUSD, tokens } : {}),
      ...(session.contextUsed !== undefined ? { context: { usedTokens: session.contextUsed, windowTokens: window } } : {}),
      lastMessage: session.lastMessage,
      terminal: false,
      commands: OPENCODE_COMMANDS,
      ...(current ? { model: current.modelID } : {}),
    }
  }

  private dispatch(type: string, props: Fields): SessionUpdate[] {
    switch (type) {
      case 'session.created':
      case 'session.updated':
        return this.sessionInfo(props)
      case 'session.renamed':
        return this.title(props.sessionID, props.title)
      case 'session.deleted':
        return this.status(props.sessionID ?? idOf(props.info), { hook: 'SessionEnd' })
      case 'session.status': {
        const status = (props.status as { type?: unknown } | undefined)?.type
        if (status === 'busy') return this.status(props.sessionID, { hook: 'UserPromptSubmit' })
        if (status === 'idle') return this.status(props.sessionID, { hook: 'Stop' })
        return []
      }
      case 'session.execution.started':
        return this.status(props.sessionID, { hook: 'UserPromptSubmit' })
      case 'session.idle':
      case 'session.execution.succeeded':
        return this.status(props.sessionID, { hook: 'Stop' })
      case 'session.execution.interrupted':
      case 'session.execution.cancelled':
        return this.interrupted(props.sessionID)
      case 'session.error':
      case 'session.execution.failed':
      case 'session.step.failed':
        return this.error(props.sessionID, props.error)
      case 'permission.updated':
      case 'permission.asked':
        return this.permission(props)
      case 'permission.replied': {
        const closed = text(props.requestID) ?? text(props.permissionID)
        const updates = this.status(props.sessionID, { hook: 'UserPromptSubmit' })
        const session = this.sessions.get(text(props.sessionID) ?? '')
        if (!closed || !session || session.child) return updates
        return updates.length ? updates.map(update => ({ ...update, permissionClosed: closed })) : this.withClosed(session, closed)
      }
      case 'session.step.started': {
        const session = this.session(props.sessionID)
        const model = props.model as { id?: unknown; providerID?: unknown } | undefined
        const modelID = text(model?.id)
        const providerID = text(model?.providerID)
        if (session && modelID && providerID) session.model = { providerID, modelID }
        return []
      }
      case 'session.model.switched': {
        const model = props.model as { id?: unknown; modelID?: unknown; providerID?: unknown } | undefined
        const modelID = text(model?.id) ?? text(model?.modelID)
        const providerID = text(model?.providerID)
        return modelID && providerID ? this.switched(text(props.sessionID) ?? '', { providerID, modelID }) : []
      }
      case 'session.compaction.ended':
      case 'session.compaction.succeeded':
      case 'session.compacted':
        return this.compacted(props.sessionID)
      case 'session.compaction.failed': {
        const error = props.error as { type?: unknown; message?: unknown } | undefined
        // Cancelled by an interruption or a shutdown: nothing to say.
        if (error?.type === 'aborted') return []
        return this.failed({ sessionID: props.sessionID, op: 'compact', message: text(error?.message) })
      }
      case 'tonton.models':
        return this.models(props.models)
      case 'tonton.history':
        return this.history(props)
      case 'tonton.failed':
        return this.failed(props)
      case 'message.updated':
        return this.message(props.info)
      case 'message.part.updated':
        return this.part(props.part)
      case 'message.part.delta':
        return this.delta(props)
      case 'session.inbox.enqueued':
        return this.prompt(props)
      case 'session.text.ended':
        return this.text(props)
      case 'session.tool.input.started': {
        const session = this.session(props.sessionID)
        const call = text(props.callID) ?? text(props.id)
        const name = text(props.name) ?? text(props.tool)
        if (session && call && name) session.toolNames.set(call, name)
        return []
      }
      case 'session.tool.called':
        return this.toolCalled(props)
      case 'session.tool.success':
      case 'session.tool.failed':
        return this.toolEnded(props, type === 'session.tool.failed')
      case 'session.step.ended':
        return this.step(props)
      default:
        return []
    }
  }

  private time(value?: unknown): string {
    return new Date(typeof value === 'number' ? value : this.eventTime).toISOString()
  }

  private session(id: unknown): TrackedSession | null {
    if (typeof id !== 'string' || !id) return null
    let session = this.sessions.get(id)
    if (!session) {
      session = new TrackedSession(id)
      this.sessions.set(id, session)
    }
    return session
  }

  /** `info` is a whole session in OpenCode 1; OpenCode 2 sends the fields themselves, its folder under `location`. */
  private sessionInfo(props: Fields): SessionUpdate[] {
    const info = (props.info && typeof props.info === 'object' ? props.info : props) as Fields
    const session = this.session(info.id ?? props.sessionID)
    if (!session) return []
    if (typeof info.parentID === 'string' && info.parentID !== '') session.child = true
    const location = info.location as { directory?: unknown } | undefined
    session.cwd = text(info.directory) ?? text(location?.directory) ?? session.cwd
    return this.title(session.id, info.title)
  }

  private title(sessionId: unknown, title: unknown): SessionUpdate[] {
    const session = this.session(sessionId)
    const value = text(title)
    if (!session || value === undefined || value === session.title) return []
    session.title = value
    return this.update(session, [], undefined, true)
  }

  private status(sessionId: unknown, status: StatusChange): SessionUpdate[] {
    const session = this.session(sessionId)
    if (!session) return []
    // OpenCode 1 sends both `session.status` idle and `session.idle`: say it once.
    const key = `${status.hook}:${status.text ?? ''}`
    if (key === session.lastStatus && status.hook !== 'Notification') return []
    // An error is followed by idle: the error stays until the next prompt.
    if (status.hook === 'Stop' && session.lastStatus?.startsWith('StopFailure:')) return []
    session.lastStatus = key
    return this.update(session, [], status, false)
  }

  /** Escape in OpenCode stops the turn: the session waits for the next prompt, like an interrupted Claude Code. */
  private interrupted(sessionId: unknown): SessionUpdate[] {
    const session = this.session(sessionId)
    if (!session) return []
    const entry: Entry = { id: `interrupted-${this.eventTime}`, ts: this.time(), kind: 'system', text: 'Interrupted by user' }
    session.lastStatus = 'Stop:'
    return this.update(session, [entry], { hook: 'Stop' }, false)
  }

  private error(sessionId: unknown, error: unknown): SessionUpdate[] {
    const fields = (error && typeof error === 'object' ? error : {}) as { name?: unknown; message?: unknown; data?: { message?: unknown } }
    if (fields.name === 'MessageAbortedError') return this.interrupted(sessionId)
    const session = this.session(sessionId)
    if (!session) return []
    const message = text(fields.data?.message) ?? text(fields.message) ?? text(fields.name) ?? 'OpenCode stopped with an error'
    session.lastStatus = `StopFailure:${message}`
    return this.update(session, [], { hook: 'StopFailure', text: message }, false)
  }

  // OpenCode 2

  private prompt(props: Fields): SessionUpdate[] {
    const session = this.session(props.sessionID)
    const item = props.item as { type?: unknown; payload?: { text?: unknown; files?: unknown } } | undefined
    const id = text(props.inboxID)
    const body = text(item?.payload?.text) ?? ''
    const images = imagesOf(item?.payload?.files)
    if (!session || !id || item?.type !== 'user' || (!body && !images.length)) return []
    return this.add(session, { id, ts: this.time(), kind: 'user', text: body, ...(images.length ? { images } : {}) })
  }

  private text(props: Fields): SessionUpdate[] {
    const session = this.session(props.sessionID)
    const message = text(props.assistantMessageID)
    const body = text(props.text)
    if (!session || !message || !body) return []
    const id = text(props.textID) ?? `${message}:${typeof props.ordinal === 'number' ? props.ordinal : 0}`
    return this.add(session, { id, ts: this.time(props.timestamp), kind: 'assistant', text: body })
  }

  private toolCalled(props: Fields): SessionUpdate[] {
    const session = this.session(props.sessionID)
    const call = text(props.callID) ?? text(props.id)
    if (!session || !call) return []
    const raw = text(props.tool) ?? text(props.name) ?? session.toolNames.get(call) ?? 'tool'
    const input = (props.input && typeof props.input === 'object' ? props.input : {}) as Fields
    return this.add(session, toolEntry(call, call, this.time(props.timestamp), raw, input))
  }

  private toolEnded(props: Fields, failed: boolean): SessionUpdate[] {
    const session = this.session(props.sessionID)
    const call = text(props.callID) ?? text(props.id)
    if (!session || !call) return []
    const content = Array.isArray(props.content) ? (props.content as { type?: unknown; text?: unknown }[]) : []
    const output = failed
      ? (text((props.error as { message?: unknown } | undefined)?.message) ?? 'The tool failed')
      : content.flatMap(item => (item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [])).join('\n')
    const images = imagesOf(content.filter(item => item?.type === 'file'))
    return this.add(session, resultEntry(`${call}:result`, call, this.time(props.timestamp), output, failed, images))
  }

  private step(props: Fields): SessionUpdate[] {
    const session = this.session(props.sessionID)
    const message = text(props.assistantMessageID)
    if (!session || !message) return []
    // Each step is its own assistant message.
    const usage = usageOf(props.cost, props.tokens)
    session.usage.set(message, usage)
    session.contextUsed = contextOf(usage)
    return this.update(session, [], undefined, true)
  }

  // OpenCode 1

  private message(info: unknown): SessionUpdate[] {
    if (!info || typeof info !== 'object') return []
    const fields = info as Fields
    const session = this.session(fields.sessionID)
    const id = text(fields.id)
    if (!session || !id || (fields.role !== 'user' && fields.role !== 'assistant')) return []
    const time = (fields.time ?? {}) as { created?: unknown; completed?: unknown }
    session.messages.set(id, {
      role: fields.role,
      created: number(time.created) || Date.now(),
      completed: typeof time.completed === 'number',
    })
    let usageChanged = false
    if (fields.role === 'assistant') {
      const usage = usageOf(fields.cost, fields.tokens)
      const previous = session.usage.get(id)
      usageChanged = usage.cost !== previous?.cost || usage.tokens.output !== previous?.tokens.output
      session.usage.set(id, usage)
      const providerID = text(fields.providerID)
      const modelID = text(fields.modelID)
      if (providerID && modelID) session.model = { providerID, modelID }
      if (contextOf(usage) > 0) session.contextUsed = contextOf(usage)
    }
    // Parts can arrive before their message: they wait for its role.
    const entries = [...session.parts.values()].filter(part => part.messageID === id).flatMap(part => this.partEntries(session, part))
    return this.update(session, entries, undefined, usageChanged)
  }

  private part(raw: unknown): SessionUpdate[] {
    if (!raw || typeof raw !== 'object') return []
    const part = raw as Part & { sessionID?: unknown }
    const session = this.session(part.sessionID)
    if (!session || typeof part.id !== 'string' || typeof part.messageID !== 'string') return []
    session.parts.set(part.id, part)
    return this.update(session, this.partEntries(session, part), undefined, false)
  }

  private delta(props: Fields): SessionUpdate[] {
    const partId = text(props.partID)
    const session = this.sessions.get(text(props.sessionID) ?? '')
    if (!session || !partId || props.field !== 'text' || typeof props.delta !== 'string') return []
    session.deltas.set(partId, (session.deltas.get(partId) ?? '') + props.delta)
    return []
  }

  /** The entries a part makes once there is enough of it. */
  private partEntries(session: TrackedSession, part: Part): Entry[] {
    const message = session.messages.get(part.messageID)
    if (!message) return []
    const ts = new Date(part.time?.start ?? part.state?.time?.start ?? message.created).toISOString()
    const entries: Entry[] = []
    if (part.type === 'text' && !part.synthetic && !part.ignored) {
      const done = message.role === 'user' || part.time?.end !== undefined || message.completed
      const body = part.text || session.deltas.get(part.id) || ''
      if (!done || !body.trim()) return []
      session.deltas.delete(part.id)
      entries.push(
        message.role === 'user' ? { id: part.id, ts, kind: 'user', text: body } : { id: part.id, ts, kind: 'assistant', text: body },
      )
    } else if (part.type === 'file' && message.role === 'user') {
      const images = imagesOf([part])
      if (images.length) entries.push({ id: part.id, ts, kind: 'user', text: part.filename ?? '', images })
    } else if (part.type === 'tool' && typeof part.tool === 'string' && part.state) {
      const { status } = part.state
      if (status !== 'running' && status !== 'completed' && status !== 'error') return []
      const call = part.callID ?? part.id
      entries.push(toolEntry(part.id, call, ts, part.tool, part.state.input ?? {}))
      if (status !== 'running') {
        const output = status === 'error' ? (part.state.error ?? '') : (part.state.output ?? '')
        entries.push(resultEntry(`${part.id}:result`, call, ts, output, status === 'error', imagesOf(part.state.attachments)))
      }
    }
    return entries.filter(entry => this.markSent(session, entry))
  }

  // Requests, commands and history

  private permission(props: Fields): SessionUpdate[] {
    const raw = text(props.action) ?? text(props.permission) ?? text(props.type) ?? 'tool'
    const toolName = TOOL_NAMES[raw] ?? raw
    const updates = this.status(props.sessionID, {
      hook: 'Notification',
      notificationType: 'permission_prompt',
      text: `OpenCode needs your permission to use ${toolName}`,
    })
    const requestId = text(props.id)
    if (!requestId) return updates
    // OpenCode 2 names what the call touches in `resources` (or `patterns`), OpenCode 1 in `pattern` and its metadata.
    const metadata = (props.metadata && typeof props.metadata === 'object' ? props.metadata : {}) as Fields
    const listed = [props.resources, props.patterns, props.pattern].flatMap(value =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : [],
    )
    const subject =
      listed.join(' ') || text(metadata.command) || text(metadata.filePath) || text(metadata.url) || text(metadata.pattern) || ''
    const field = RULE_FIELDS[toolName] ?? 'command'
    const input = subject ? { [field]: subject } : {}
    const permission: OpenCodePermission = {
      requestId,
      detail: { toolName, description: text(props.title) ?? subject ?? toolName, inputPreview: JSON.stringify(input) },
      input,
    }
    return updates.map(update => ({ ...update, permission }))
  }

  private withClosed(session: TrackedSession, requestId: string): SessionUpdate[] {
    return [{ sessionId: session.id, entries: [], metaChanged: false, permissionClosed: requestId }]
  }

  private compacted(sessionId: unknown): SessionUpdate[] {
    const session = this.session(sessionId)
    if (!session) return []
    session.contextUsed = 0
    const entry: Entry = { id: `compacted-${this.eventTime}`, ts: this.time(), kind: 'system', text: 'Conversation compacted' }
    return this.markSent(session, entry) ? this.update(session, [entry], undefined, true) : []
  }

  private models(list: unknown): SessionUpdate[] {
    if (!Array.isArray(list)) return []
    this.catalog = (list as { providerID?: unknown; modelID?: unknown; context?: unknown; released?: unknown }[]).flatMap(model => {
      const providerID = text(model?.providerID)
      const modelID = text(model?.modelID)
      if (!providerID || !modelID) return []
      return [
        {
          providerID,
          modelID,
          ...(number(model.context) > 0 ? { context: number(model.context) } : {}),
          ...(number(model.released) > 0 ? { released: number(model.released) } : {}),
        },
      ]
    })
    return [...this.sessions.values()].flatMap(session => (session.model ? this.update(session, [], undefined, true) : []))
  }

  /** Why a command from the notch did not run, as a line in the conversation. */
  private failed(props: Fields): SessionUpdate[] {
    const session = this.session(props.sessionID)
    const action = FAILED_ACTIONS[text(props.op) ?? '']
    if (!session || !action) return []
    const entry: Entry = {
      id: `failed-${this.eventTime}-${session.order.length}`,
      ts: this.time(),
      kind: 'system',
      text: `OpenCode did not ${action}: ${text(props.message) ?? 'unknown error'}`,
    }
    return this.add(session, entry)
  }

  /**
   * The conversation OpenCode keeps, for a session the bridge starts following halfway: OpenCode 2's `session.context`, or
   * OpenCode 1's messages with their parts. Entries already sent keep their place; the result replaces the relay's copy.
   */
  private history(props: Fields): SessionUpdate[] {
    const session = this.session(props.sessionID)
    if (!session) return []
    if (props.info && typeof props.info === 'object') this.sessionInfo({ info: props.info })
    const messages = Array.isArray(props.messages) ? (props.messages as Fields[]) : []
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      if (message.info && typeof message.info === 'object') {
        // OpenCode 1: a message and its parts, as its events would bring them.
        this.message({ ...(message.info as Fields), sessionID: session.id })
        for (const part of Array.isArray(message.parts) ? message.parts : []) this.part({ ...(part as Fields), sessionID: session.id })
      } else {
        this.contextMessage(session, message)
      }
    }
    if (session.child) return []
    const history = [...session.order].sort((a, b) => a.ts.localeCompare(b.ts))
    return [{ sessionId: session.id, entries: [], metaChanged: true, history }]
  }

  /** One message of OpenCode 2's `session.context`. */
  private contextMessage(session: TrackedSession, message: Fields) {
    const id = text(message.id)
    const time = (message.time ?? {}) as { created?: unknown }
    const ts = this.time(time.created)
    if (!id) return
    if (message.type === 'user' && text(message.text)) {
      this.markSent(session, { id, ts, kind: 'user', text: message.text as string })
      return
    }
    if (message.type !== 'assistant') return
    const usage = usageOf(message.cost, message.tokens)
    session.usage.set(id, usage)
    session.contextUsed = contextOf(usage)
    const model = message.model as { id?: unknown; providerID?: unknown } | undefined
    if (text(model?.id) && text(model?.providerID))
      session.model = { providerID: model?.providerID as string, modelID: model?.id as string }
    let ordinal = 0
    for (const content of Array.isArray(message.content) ? (message.content as Fields[]) : []) {
      if (content?.type === 'text' && text(content.text)) {
        this.markSent(session, { id: `${id}:${ordinal++}`, ts, kind: 'assistant', text: content.text as string })
      } else if (content?.type === 'tool' && text(content.id)) {
        const call = content.id as string
        const state = (content.state ?? {}) as { status?: unknown; input?: unknown; content?: unknown; error?: { message?: unknown } }
        const input = (state.input && typeof state.input === 'object' ? state.input : {}) as Fields
        this.markSent(session, toolEntry(call, call, ts, text(content.name) ?? 'tool', input))
        if (state.status === 'completed' || state.status === 'error') {
          const output =
            state.status === 'error'
              ? (text(state.error?.message) ?? 'The tool failed')
              : (Array.isArray(state.content) ? (state.content as { type?: unknown; text?: unknown }[]) : [])
                  .flatMap(item => (item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []))
                  .join('\n')
          this.markSent(session, resultEntry(`${call}:result`, call, ts, output, state.status === 'error'))
        }
      }
    }
  }

  private add(session: TrackedSession, entry: Entry): SessionUpdate[] {
    return this.markSent(session, entry) ? this.update(session, [entry], undefined, false) : []
  }

  /** True the first time: the relay keeps an entry once, so each goes once. */
  private markSent(session: TrackedSession, entry: Entry): boolean {
    if (session.sent.has(entry.id)) return false
    session.sent.add(entry.id)
    session.order.push(entry)
    if (session.order.length > BACKLOG_SIZE) session.order = session.order.slice(-BACKLOG_SIZE)
    if (entry.kind === 'user' || entry.kind === 'assistant') session.lastMessage = entry.text.slice(0, MAX_LAST_MESSAGE_CHARS)
    return true
  }

  private update(session: TrackedSession, entries: Entry[], status: StatusChange | undefined, metaChanged: boolean): SessionUpdate[] {
    if (session.child) return []
    if (!entries.length && !status && !metaChanged) return []
    const textual = entries.some(entry => entry.kind === 'user' || entry.kind === 'assistant')
    return [{ sessionId: session.id, entries, status, metaChanged: metaChanged || textual }]
  }
}

function toolEntry(id: string, call: string, ts: string, tool: string, input: Fields): Entry {
  const name = TOOL_NAMES[tool] ?? tool
  const claudeInput = Object.fromEntries(Object.entries(input).map(([key, value]) => [INPUT_FIELDS[key] ?? key, value]))
  const edits = fileEdits(name, claudeInput)
  return { id, ts, kind: 'tool', toolUseId: call, name, summary: toolSummary(name, claudeInput), ...(edits.length ? { edits } : {}) }
}

function resultEntry(id: string, call: string, ts: string, output: string, isError: boolean, images: ImageData[] = []): Entry {
  const cut =
    output.length > MAX_TOOL_RESULT_CHARS
      ? `${output.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (${output.length - MAX_TOOL_RESULT_CHARS} characters truncated)`
      : output
  return { id, ts, kind: 'tool_result', toolUseId: call, text: cut, isError, ...(images.length ? { images } : {}) }
}

/** The images among OpenCode's files: it passes them as data URLs. */
function imagesOf(files: unknown): ImageData[] {
  if (!Array.isArray(files)) return []
  return files.flatMap(file => {
    const url = file && typeof file === 'object' ? (file as { url?: unknown }).url : undefined
    const match = typeof url === 'string' ? /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url) : null
    return match && match[2].length <= MAX_IMAGE_BASE64 ? [{ mediaType: match[1], data: match[2] }] : []
  })
}

function usageOf(cost: unknown, raw: unknown): Usage {
  const tokens = (raw ?? {}) as { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } }
  return {
    cost: number(cost),
    tokens: {
      input: number(tokens.input),
      // Reasoning is billed as output.
      output: number(tokens.output) + number(tokens.reasoning),
      cacheRead: number(tokens.cache?.read),
      cacheWrite: number(tokens.cache?.write),
    },
  }
}

/** What the next call sends again: the input of this one, cached or not. */
function contextOf(usage: Usage): number {
  return usage.tokens.input + usage.tokens.cacheRead + usage.tokens.cacheWrite
}

function addTokens(total: TokenCounts, step: Usage): TokenCounts {
  return {
    input: total.input + step.tokens.input,
    output: total.output + step.tokens.output,
    cacheRead: total.cacheRead + step.tokens.cacheRead,
    cacheWrite: total.cacheWrite + step.tokens.cacheWrite,
  }
}

const idOf = (info: unknown): unknown => (info && typeof info === 'object' ? (info as { id?: unknown }).id : undefined)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)
const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
