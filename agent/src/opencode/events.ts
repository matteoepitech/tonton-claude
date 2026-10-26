import type { Entry, SessionMeta, TokenCounts } from '../../../shared/protocol'
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
  'session.step.ended',
  'session.step.failed',
]

const MAX_TOOL_RESULT_CHARS = 4000
const MAX_LAST_MESSAGE_CHARS = 200
/** Event ids already handled: OpenCode 2 hands each event to every plugin instance of the process. */
const SEEN_EVENTS = 4000

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
/** OpenCode's input fields under the names the Claude Code parser reads. */
const INPUT_FIELDS: Record<string, string> = { filePath: 'file_path', oldString: 'old_string', newString: 'new_string' }

/** A status change, sent to the relay as the Claude Code hook event that means the same. */
export interface StatusChange {
  hook: 'UserPromptSubmit' | 'Stop' | 'StopFailure' | 'SessionEnd' | 'Notification'
  notificationType?: 'permission_prompt'
  text?: string
}

export interface SessionUpdate {
  sessionId: string
  entries: Entry[]
  status?: StatusChange
  /** The title, cost, tokens or last message changed. */
  metaChanged: boolean
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
  state?: { status?: string; input?: Fields; output?: string; error?: string; time?: { start?: number } }
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
  lastMessage: string | undefined
  lastStatus: string | undefined

  constructor(readonly id: string) {}
}

/** Every session one OpenCode process reports, from its events. */
export class OpenCodeTracker {
  private readonly sessions = new Map<string, TrackedSession>()
  private readonly seen = new Set<string>()
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

  meta(sessionId: string): SessionMeta {
    const session = this.sessions.get(sessionId)
    if (!session) return {}
    const usage = [...session.usage.values()]
    const costUSD = usage.reduce((sum, step) => sum + step.cost, 0)
    const tokens = usage.reduce(addTokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    return {
      title: session.title,
      ...(usage.length ? { costUSD, tokens } : {}),
      lastMessage: session.lastMessage,
      terminal: false,
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
      case 'permission.asked': {
        const tool = text(props.action) ?? text(props.permission) ?? text(props.type) ?? 'a tool'
        return this.status(props.sessionID, {
          hook: 'Notification',
          notificationType: 'permission_prompt',
          text: `OpenCode needs your permission to use ${TOOL_NAMES[tool] ?? tool}`,
        })
      }
      case 'permission.replied':
        return this.status(props.sessionID, { hook: 'UserPromptSubmit' })
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
    const item = props.item as { type?: unknown; payload?: { text?: unknown } } | undefined
    const id = text(props.inboxID)
    const body = text(item?.payload?.text)
    if (!session || !id || item?.type !== 'user' || !body) return []
    return this.add(session, { id, ts: this.time(), kind: 'user', text: body })
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
    return this.add(session, resultEntry(`${call}:result`, call, this.time(props.timestamp), output, failed))
  }

  private step(props: Fields): SessionUpdate[] {
    const session = this.session(props.sessionID)
    const message = text(props.assistantMessageID)
    if (!session || !message) return []
    // Each step is its own assistant message.
    session.usage.set(message, usageOf(props.cost, props.tokens))
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
    } else if (part.type === 'tool' && typeof part.tool === 'string' && part.state) {
      const { status } = part.state
      if (status !== 'running' && status !== 'completed' && status !== 'error') return []
      const call = part.callID ?? part.id
      entries.push(toolEntry(part.id, call, ts, part.tool, part.state.input ?? {}))
      if (status !== 'running') {
        const output = status === 'error' ? (part.state.error ?? '') : (part.state.output ?? '')
        entries.push(resultEntry(`${part.id}:result`, call, ts, output, status === 'error'))
      }
    }
    return entries.filter(entry => this.markSent(session, entry))
  }

  private add(session: TrackedSession, entry: Entry): SessionUpdate[] {
    return this.markSent(session, entry) ? this.update(session, [entry], undefined, false) : []
  }

  /** True the first time: the relay keeps an entry once, so each goes once. */
  private markSent(session: TrackedSession, entry: Entry): boolean {
    if (session.sent.has(entry.id)) return false
    session.sent.add(entry.id)
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

function resultEntry(id: string, call: string, ts: string, output: string, isError: boolean): Entry {
  const cut =
    output.length > MAX_TOOL_RESULT_CHARS
      ? `${output.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (${output.length - MAX_TOOL_RESULT_CHARS} characters truncated)`
      : output
  return { id, ts, kind: 'tool_result', toolUseId: call, text: cut, isError }
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
