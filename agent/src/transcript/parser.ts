import type { Entry, FileEdit, ImageData, TodoItem, TokenCounts, TurnTime, UsageLimit } from '../../../shared/protocol'
import { cutText, cutTextEnd } from '../../../shared/text'
import { limit, modelName } from '../usage'
import { entryImages } from './images'

// Claude Code transcripts (.jsonl) are not a public format: anything unexpected is skipped, never thrown.

const MAX_TOOL_RESULT_CHARS = 4000
/** Of a longer result, the end is kept too: it says how a build or a test run ended. */
const TOOL_RESULT_TAIL_CHARS = 1500
const MAX_SUMMARY_CHARS = 300
/** Per side of an edit, and edits per call: enough to read the change, not to resend whole files. */
const MAX_EDIT_CHARS = 4000
const MAX_EDITS = 20
/** A task list longer than this is cut: the checklist is for following along, not for keeping a backlog. */
const MAX_TODOS = 50
const MAX_TODO_CHARS = 300
/** Internal tools that would only add noise to the conversation. */
const HIDDEN_TOOLS = new Set(['ToolSearch', 'SubagentHandback'])
/** Wrapped user content that Claude Code adds and that should not appear as a message. */
const INTERNAL_USER_TAGS = /^\s*<(local-command-stdout|local-command-caveat|command-message|system-reminder)/

/** Which input field describes a tool call best, per tool. */
const SUMMARY_FIELDS: Record<string, string[]> = {
  Bash: ['command'],
  PowerShell: ['command'],
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Agent: ['description', 'prompt'],
  Task: ['description', 'prompt'],
}
const FALLBACK_SUMMARY_FIELDS = ['description', 'command', 'file_path', 'path', 'url', 'query', 'pattern', 'prompt']

export interface ParsedLine {
  entries: Entry[]
  title?: string
  costUSD?: number
  /** Set when the 5-hour limit stopped the session. */
  fiveHourLimit?: UsageLimit
  /** Set when a weekly limit stopped the session. */
  sevenDayLimit?: UsageLimit
  /** Tokens of the API response this line belongs to. Claude Code writes one line per content block, each with the whole
   * response's usage, so they only count once per request. */
  usage?: TokenCounts & { requestId: string }
  /** The model's context window, read from the model the request asked for (`[1m]` for a million tokens). */
  contextWindow?: number
  /** Claude Code compacted the conversation: the context starts over. */
  compacted?: boolean
  /** A turn ended, with how long it took. */
  turn?: TurnTime
  /** The model that wrote this response, such as `claude-opus-4-5-20251101`. */
  model?: string
  /** The whole command of each shell call, by tool use id: a summary is one line and cut. Stays on the machine. */
  commands?: Record<string, string>
  /** Only for the agent's XP (agent/src/transcript/work.ts), never sent: what this line tells about the turns. */
  work?: LineWork
}

/** What a line says about the work of the session. */
export interface LineWork {
  /** A line that can start a turn: by its user (terminal, notch, website), a pool post, or Claude Code itself. */
  start?: { id: string; from: 'user' | 'pool' | 'auto'; queued: boolean }
  /** The user pressed Escape, or an API error ended the turn. */
  broken?: boolean
  /** The id of the line that ended a turn: it names the turn. */
  turnId?: string
  /** The folder the session ran in when it wrote this line. */
  cwd?: string
  /** When the line was written: a turn still going earns its work time as it goes (agent/src/rpg-slices.ts). */
  at?: string
  /** TaskCreate and TaskUpdate calls: their entry has no field for the task. */
  tasks?: TaskCall[]
}

export interface TaskCall {
  toolUseId: string
  name: 'TaskCreate' | 'TaskUpdate'
  taskId?: string
  subject?: string
  status?: string
}

/** The tools that run commands, and the field that holds the command. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

interface Block {
  type: string
  [field: string]: unknown
}

interface TranscriptLine {
  type?: string
  subtype?: string
  uuid?: string
  timestamp?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  isApiErrorMessage?: boolean
  cwd?: string
  origin?: { kind?: string }
  aiTitle?: string
  totalCostUSD?: number
  requestId?: string
  requestedModel?: string
  /** On the line Claude Code writes when a turn ends. */
  durationMs?: unknown
  /** On the error message Claude Code writes when the plan's limit refuses a request. */
  quotaLimits?: { status?: string; rateLimitType?: string; resetsAt?: unknown }
  message?: { id?: string; model?: string; content?: string | Block[]; usage?: Record<string, unknown> }
  attachment?: { type?: string; commandMode?: string; origin?: { kind?: string }; prompt?: string | Block[] }
}

/** `sidechain` reads the lines of a subagent's transcript, which the session's own skips. */
export function parseLine(raw: string, { sidechain = false }: { sidechain?: boolean } = {}): ParsedLine {
  const result: ParsedLine = { entries: [] }
  let line: TranscriptLine
  try {
    line = JSON.parse(raw)
  } catch {
    return result
  }
  if (!line || typeof line !== 'object' || (line.isSidechain && !sidechain)) return result

  if (line.type === 'ai-title' && typeof line.aiTitle === 'string') result.title = line.aiTitle
  if (line.type === 'cost-state' && typeof line.totalCostUSD === 'number') result.costUSD = line.totalCostUSD
  const quota = line.quotaLimits
  if (quota?.status === 'rejected' && quota.rateLimitType === 'five_hour') result.fiveHourLimit = limit(100, quota.resetsAt)
  // The weekly limit, or its Opus or Sonnet share: either way the session waits for that reset.
  if (quota?.status === 'rejected' && quota.rateLimitType?.startsWith('seven_day')) result.sevenDayLimit = limit(100, quota.resetsAt)
  if (line.type === 'assistant') result.usage = responseUsage(line)
  const model = line.type === 'assistant' ? modelName(line.message?.model) : undefined
  if (model) result.model = model
  if (line.type === 'assistant' && typeof line.requestedModel === 'string') {
    result.contextWindow = /\[1m\]$/i.test(line.requestedModel) ? 1_000_000 : 200_000
  }

  const id = line.uuid ?? `${line.type}-${line.timestamp}`
  const ts = line.timestamp ?? new Date().toISOString()
  if (typeof line.timestamp === 'string' && !Number.isNaN(Date.parse(line.timestamp))) addWork(result, { at: line.timestamp })
  if (line.type === 'system' && line.subtype === 'turn_duration') {
    result.turn = turnTime(line)
    if (result.turn) addWork(result, { turnId: id })
  }
  if (line.type === 'system' && line.subtype === 'scheduled_task_fire') addWork(result, { start: { id, from: 'auto', queued: false } })
  if (typeof line.cwd === 'string' && line.cwd) addWork(result, { cwd: line.cwd })
  if (line.type === 'system' && line.subtype === 'compact_boundary') {
    result.compacted = true
    result.entries.push({ id, ts, kind: 'system', text: 'Conversation compacted' })
  }

  // A message sent while Claude is working waits in a queue and is only ever stored as this attachment, never as a user
  // line: from the notch as from the terminal.
  const queued = line.type === 'attachment' ? line.attachment : undefined
  if (queued?.type === 'queued_command' && (queued.commandMode ?? 'prompt') === 'prompt') {
    const entries = userEntries(id, ts, queued.prompt)
    const viaNotch = queued.origin?.kind === 'channel'
    result.entries.push(...entries.map(entry => (viaNotch && entry.kind === 'user' ? { ...entry, viaNotch: true } : entry)))
    addWork(result, { start: { id, from: startedBy(queued.origin?.kind, entries), queued: true } })
    return result
  }
  if (queued?.type === 'queued_command') addWork(result, { start: { id, from: 'auto', queued: true } })

  // Messages sent from the notch arrive through the channel and are stored as meta user messages.
  const fromChannel = line.origin?.kind === 'channel'
  if ((line.type !== 'user' && line.type !== 'assistant') || (line.isMeta && !fromChannel) || !line.message) return result

  const content = line.message.content
  if (line.type === 'user') {
    const entries = userEntries(id, ts, content)
    result.entries.push(...entries)
    lineWork(result, line, id, entries)
  } else if (Array.isArray(content)) {
    result.entries.push(...assistantEntries(id, ts, content))
    const commands = shellCommands(content)
    if (commands) result.commands = commands
    const tasks = taskCalls(content)
    if (tasks.length) addWork(result, { tasks })
    if (line.isApiErrorMessage === true) addWork(result, { broken: true })
  }
  return result
}

function shellCommands(content: Block[]): Record<string, string> | undefined {
  const commands: Record<string, string> = {}
  for (const block of content) {
    const command = (block.input as { command?: unknown } | undefined)?.command
    if (block.type === 'tool_use' && SHELL_TOOLS.has(String(block.name)) && typeof command === 'string')
      commands[String(block.id)] = command
  }
  return Object.keys(commands).length ? commands : undefined
}

function addWork(result: ParsedLine, work: LineWork) {
  result.work = { ...result.work, ...work }
}

/** What a user line says about turns: a prompt, or an interruption. */
function lineWork(result: ParsedLine, line: TranscriptLine, id: string, entries: Entry[]) {
  const content = line.message?.content
  const blocks = Array.isArray(content) ? content : []
  if (entries.some(entry => entry.kind === 'system' && entry.text === 'Interrupted by user')) addWork(result, { broken: true })
  if (line.isCompactSummary || blocks.some(block => block.type === 'tool_result')) return
  const notification = entries.some(entry => entry.kind === 'system') && /^\s*<task-notification>/.test(textOf(content))
  const command = /<command-name>/.test(textOf(content))
  if (notification || command || entries.some(entry => entry.kind === 'user'))
    addWork(result, { start: { id, from: notification ? 'auto' : startedBy(line.origin?.kind, entries), queued: false } })
}

/**
 * Who started a turn. Claude Code names it in `origin`: `human` for a prompt typed in the terminal, `channel` for the
 * notch or a pool, anything else (`task-notification`, `peer`) for Claude Code or another session. Older versions name
 * nothing: a prompt is then its user's. A pool post is its envelope (agent/src/channel/pool-work.ts), wherever it came from.
 */
function startedBy(origin: string | undefined, entries: Entry[]): 'user' | 'pool' | 'auto' {
  if (entries.some(entry => entry.kind === 'user' && isPoolPost(entry.text))) return 'pool'
  if (origin === undefined || origin === 'human' || origin === 'channel') return 'user'
  return 'auto'
}

export const isPoolPost = (text: string) => /^\s*<pool kind="/.test(text)

function textOf(content: string | Block[] | undefined): string {
  if (typeof content === 'string') return content
  return (Array.isArray(content) ? content : [])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

function taskCalls(content: Block[]): TaskCall[] {
  return content.flatMap(block => {
    if (block.type !== 'tool_use' || (block.name !== 'TaskCreate' && block.name !== 'TaskUpdate')) return []
    const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>
    const field = (name: string) => (typeof input[name] === 'string' && input[name] ? (input[name] as string) : undefined)
    const call: TaskCall = { toolUseId: String(block.id), name: block.name }
    const taskId = field('taskId')
    const subject = field('subject')
    const status = field('status')
    return [{ ...call, ...(taskId ? { taskId } : {}), ...(subject ? { subject } : {}), ...(status ? { status } : {}) }]
  })
}

/** A turn's end needs its own time: a made-up one would differ at each read and count the turn again. */
function turnTime(line: TranscriptLine): TurnTime | undefined {
  const { durationMs, timestamp } = line
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return undefined
  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) return undefined
  return { end: timestamp, seconds: Math.round(durationMs / 100) / 10 }
}

/** Messages Claude Code makes up itself, such as API errors, are `<synthetic>` and cost nothing. */
function responseUsage(line: TranscriptLine): ParsedLine['usage'] {
  const usage = line.message?.usage
  const requestId = line.requestId ?? line.message?.id
  if (!usage || typeof requestId !== 'string' || line.message?.model === '<synthetic>') return undefined
  const count = (field: string) => (typeof usage[field] === 'number' && Number.isFinite(usage[field]) ? (usage[field] as number) : 0)
  return {
    requestId,
    input: count('input_tokens'),
    output: count('output_tokens'),
    cacheRead: count('cache_read_input_tokens'),
    cacheWrite: count('cache_creation_input_tokens'),
  }
}

function userEntries(id: string, ts: string, content: string | Block[] | undefined): Entry[] {
  if (typeof content === 'string') return compact([userMessage(id, ts, content, [])])
  if (!Array.isArray(content)) return []

  const entries: Entry[] = []
  const texts: string[] = []
  const images: ImageData[] = []
  content.forEach((block, index) => {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block.type === 'image') addImage(images, block)
    else if (block.type === 'tool_result' && !isToolSchemaResult(block)) entries.push(toolResult(`${id}:${index}`, ts, block))
  })
  return compact([...entries, userMessage(id, ts, texts.join('\n'), images)])
}

function assistantEntries(id: string, ts: string, content: Block[]): Entry[] {
  return compact(
    content.map((block, index): Entry | null => {
      const entryId = `${id}:${index}`
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return { id: entryId, ts, kind: 'assistant', text: block.text }
      }
      if (block.type === 'tool_use' && typeof block.name === 'string' && !HIDDEN_TOOLS.has(block.name)) {
        const edits = fileEdits(block.name, block.input)
        const todos = todoItems(block.name, block.input)
        return {
          id: entryId,
          ts,
          kind: 'tool',
          toolUseId: String(block.id),
          name: block.name,
          summary: toolSummary(block.name, block.input),
          ...(edits.length ? { edits } : {}),
          ...(todos ? { todos } : {}),
        }
      }
      return null
    }),
  )
}

function userMessage(id: string, ts: string, raw: string, images: ImageData[]): Entry | null {
  const channel = /<channel source="[^"]*tonton[^"]*"[^>]*>([\s\S]*?)<\/channel>/.exec(raw)
  if (channel) return { id, ts, kind: 'user', ...entryImages(channel[1].trim(), images), viaNotch: true }
  if (INTERNAL_USER_TAGS.test(raw)) return null
  if (/^\s*<task-notification>/.test(raw)) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(raw)?.[1]?.trim()
    return { id, ts, kind: 'system', text: summary ?? 'Background task finished' }
  }
  if (/^\[Request interrupted by user/.test(raw)) return { id, ts, kind: 'system', text: 'Interrupted by user' }

  const command = /<command-name>([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([^<]*)<\/command-args>)?/.exec(raw)
  if (command) return { id, ts, kind: 'system', text: `${command[1]} ${command[2] ?? ''}`.trim() }

  const text = raw.replace(/<pasted_content[^>]*>|<\/pasted_content>/g, '')
  if (!text.trim() && images.length === 0) return null
  return { id, ts, kind: 'user', ...entryImages(text, images) }
}

/** ToolSearch results only load tool schemas. */
function isToolSchemaResult(block: Block): boolean {
  const content = block.content
  return Array.isArray(content) && content.length > 0 && content.every((part: Block) => part.type === 'tool_reference')
}

function toolResult(id: string, ts: string, block: Block): Entry {
  const images: ImageData[] = []
  let text = ''
  if (typeof block.content === 'string') {
    text = block.content
  } else if (Array.isArray(block.content)) {
    for (const part of block.content as Block[]) {
      if (part.type === 'text' && typeof part.text === 'string') text += (text ? '\n' : '') + part.text
      else if (part.type === 'image') addImage(images, part)
    }
  }
  text = cutToolResult(text)
  const toolUseId = String(block.tool_use_id)
  return { id, ts, kind: 'tool_result', toolUseId, ...entryImages(text, images), isError: block.is_error === true }
}

/** A long tool result keeps its start and its end, for Claude Code's and OpenCode's sessions alike. */
export function cutToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text
  // Never half a character at either cut: the Mac and the iPhone could not decode the entry (shared/text.ts).
  const head = cutText(text, MAX_TOOL_RESULT_CHARS - TOOL_RESULT_TAIL_CHARS)
  const tail = cutTextEnd(text, TOOL_RESULT_TAIL_CHARS)
  return `${head}\n… (${text.length - head.length - tail.length} characters truncated)\n${tail}`
}

/** The entry keeps the ones that fit (./images.ts). */
function addImage(images: ImageData[], block: Block) {
  const source = block.source as { type?: string; data?: unknown; media_type?: string } | undefined
  if (source?.type === 'base64' && typeof source.data === 'string') {
    images.push({ mediaType: source.media_type ?? 'image/png', data: source.data })
  }
}

/** The replacements of an Edit or MultiEdit call, for the app to show as a diff. */
export function fileEdits(name: string, input: unknown): FileEdit[] {
  const fields = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const raw = name === 'Edit' ? [fields] : name === 'MultiEdit' && Array.isArray(fields.edits) ? fields.edits : []
  const cut = (text: string) => (text.length > MAX_EDIT_CHARS ? `${cutText(text, MAX_EDIT_CHARS)}\n…` : text)
  return raw
    .filter(
      (edit): edit is { old_string: string; new_string: string } =>
        typeof edit?.old_string === 'string' && typeof edit?.new_string === 'string',
    )
    .slice(0, MAX_EDITS)
    .map(edit => ({ oldText: cut(edit.old_string), newText: cut(edit.new_string) }))
}

/**
 * The task list a TodoWrite call sets: `{ todos: [{ content, status, activeForm }] }` in Claude Code, `{ todos: [{ content,
 * status, priority, id }] }` in OpenCode. Null for other tools, or when the input has no list.
 */
export function todoItems(name: string, input: unknown): TodoItem[] | null {
  const todos = name === 'TodoWrite' && input && typeof input === 'object' ? (input as Record<string, unknown>).todos : undefined
  if (!Array.isArray(todos)) return null
  const cut = (text: string) => (text.length > MAX_TODO_CHARS ? `${cutText(text, MAX_TODO_CHARS)}…` : text)
  return todos
    .filter((todo): todo is Record<string, unknown> => typeof todo?.content === 'string' && todo.content.trim().length > 0)
    .slice(0, MAX_TODOS)
    .map(todo => {
      const status = TODO_STATUSES.find(known => known === todo.status) ?? 'pending'
      const activeForm = typeof todo.activeForm === 'string' && todo.activeForm.trim() ? cut(todo.activeForm.trim()) : undefined
      return { content: cut(String(todo.content).trim()), status, ...(activeForm ? { activeForm } : {}) }
    })
}

const TODO_STATUSES: readonly TodoItem['status'][] = ['pending', 'in_progress', 'completed', 'cancelled']

export function toolSummary(name: string, input: unknown): string {
  const fields = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const pick = (keys: string[]) => keys.map(key => fields[key]).find((v): v is string => typeof v === 'string' && v.length > 0)

  let summary: string | undefined
  if (name === 'Grep' || name === 'Glob') summary = [pick(['pattern']), pick(['path'])].filter(Boolean).join(' in ')
  else if (name === 'TodoWrite') summary = 'Updated the task list'
  else summary = pick(SUMMARY_FIELDS[name] ?? FALLBACK_SUMMARY_FIELDS) ?? Object.values(fields).find(v => typeof v === 'string')

  const oneLine = (summary ?? '').replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_SUMMARY_CHARS ? `${cutText(oneLine, MAX_SUMMARY_CHARS)}…` : oneLine
}

const compact = <T>(items: (T | null)[]): T[] => items.filter((item): item is T => item !== null)
