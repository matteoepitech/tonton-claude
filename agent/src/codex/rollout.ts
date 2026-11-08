// Codex's rollouts (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`) turned into Tonton's entries, as
// agent/src/transcript/parser.ts does for Claude Code's transcripts: each line is `{ timestamp, type, payload }`, with
// `type` one of session_meta, turn_context, response_item, event_msg or compacted (RolloutItem in
// codex-rs/protocol/src/protocol.rs). It is not a public format either: anything unexpected is skipped, never thrown.
// The Mac reads the rollouts of the sessions no agent reports the same way, with the same entry ids
// (app/Sources/TontonCore/CodexRollout.swift): keep the two in step.
//
// A prompt is in the rollout twice, as the model's input (a `message` response item) and as the user's (a `user_message`
// event): the event is the one shown, the model's input only lends it its images. An answer is a `message` response item;
// its `agent_message` event is the same text again. Codex's tools come under Claude Code's names (./tools.ts), so what
// reads a Claude Code session reads a Codex one: changed files, task lists, the cluster detector, the XP.

import type { Entry, ImageData } from '../../../shared/protocol'
import { cutText } from '../../../shared/text'
import { entryImages } from '../transcript/images'
import { cutToolResult, isPoolPost, type LineWork, type ParsedLine, todoItems, toolSummary } from '../transcript/parser'
import { modelName } from '../usage'
import { appliedFile, type PatchFile, patchFiles } from './patch'
import { CODEX_SHELL_TOOLS, codexToolName, shellCommand } from './tools'

/** Calls waiting for their output, and commands still running: a session that never ends them must not fill memory. */
const MAX_PENDING = 500
const MAX_TITLE_CHARS = 80
const MAX_REASONING_CHARS = 160
const MAX_ERROR_CHARS = 300
/** What Codex adds to a conversation as the user's and that nobody typed. */
const INTERNAL_USER_TEXT =
  /^\s*<(environment_context|user_instructions|permissions instructions|turn_aborted|user_shell_command|skill|collaboration_mode)\b/

/** One window of a plan's usage, as Codex reports it after each response. */
export interface CodexRateWindow {
  /** 0 to 100. */
  usedPercent: number
  windowMinutes?: number
  resetsAt?: string
}

/** The plan's windows from a `token_count` event (`RateLimitSnapshot`): the 5-hour one is `primary`, the week `secondary`. */
export interface CodexRateLimits {
  limitId?: string
  planType?: string
  primary?: CodexRateWindow
  secondary?: CodexRateWindow
  /** Set when Codex was refused for a limit, such as `rate_limit_reached`. */
  reached?: string
}

/** Who the rollout belongs to, from its `session_meta` line. */
export interface CodexSession {
  /** What Codex's hooks call `session_id`, the same for a thread and its subagents. */
  sessionId: string
  threadId: string
  cwd?: string
  branch?: string
  cliVersion?: string
  /** A subagent's thread: its work is in its parent's turn. */
  subagent: boolean
}

export interface CodexLine extends ParsedLine {
  /** The plan's usage, for its limits (#373): not sent yet. */
  rateLimits?: CodexRateLimits
  session?: CodexSession
  /** A turn started or ended: the status to show when Codex's hooks do not run (not trusted yet), or did not say it. */
  status?: 'working' | 'idle'
}

interface Call {
  kind: 'shell' | 'patch' | 'hidden' | 'other'
  /** The whole command of a shell call. */
  command?: string
}

type Fields = Record<string, unknown>

/** Reads one rollout from the start, or from anywhere in it: calls are matched to their output by id. */
export class CodexRollout {
  private cwd: string | undefined
  private readonly calls = new Map<string, Call>()
  /** Commands still running after their call returned, by the session id `write_stdin` names. */
  private readonly running = new Map<string, string>()
  /** apply_patch calls already shown as their files, and those Codex could not apply. */
  private readonly patched = new Set<string>()
  private readonly failedPatches = new Set<string>()
  /** The images of the prompt the model got, for the `user_message` event that follows. */
  private images: ImageData[] = []
  private titled = false
  /** The turn going on: Codex's id, or `user:` and the line of a prompt that came before Codex said a turn started. */
  private turn: { id: string; startedAt?: number; since?: string } | undefined

  line(raw: string): CodexLine {
    const result: CodexLine = { entries: [] }
    try {
      const line = JSON.parse(raw) as { timestamp?: unknown; type?: unknown; payload?: unknown }
      if (!line || typeof line !== 'object' || !line.payload || typeof line.payload !== 'object') return result
      const stamp = typeof line.timestamp === 'string' && !Number.isNaN(Date.parse(line.timestamp)) ? line.timestamp : undefined
      const ts = stamp ?? new Date().toISOString()
      const id = `cx-${Bun.hash(raw).toString(36)}`
      if (stamp) addWork(result, { at: stamp })
      const payload = line.payload as Fields
      if (line.type === 'session_meta') this.sessionMeta(payload, result)
      else if (line.type === 'turn_context') this.turnContext(payload, result)
      else if (line.type === 'response_item') this.responseItem(payload, id, ts, result)
      else if (line.type === 'event_msg') this.event(payload, id, ts, stamp, result)
      else if (line.type === 'compacted') result.compacted = true
    } catch {
      return { entries: [] }
    }
    return result
  }

  private sessionMeta(payload: Fields, result: CodexLine) {
    const threadId = text(payload.id)
    if (!threadId) return
    const cwd = text(payload.cwd)
    if (cwd) {
      this.cwd = cwd
      addWork(result, { cwd })
    }
    const source = payload.source
    const branch = text((payload.git as Fields | undefined)?.branch)
    const cliVersion = text(payload.cli_version)
    result.session = {
      sessionId: text(payload.session_id) ?? threadId,
      threadId,
      ...(cwd ? { cwd } : {}),
      ...(branch ? { branch } : {}),
      ...(cliVersion ? { cliVersion } : {}),
      subagent: Boolean(text(payload.parent_thread_id)) || Boolean(source && typeof source === 'object' && 'subagent' in source),
    }
  }

  private turnContext(payload: Fields, result: CodexLine) {
    const cwd = text(payload.cwd)
    if (cwd) {
      this.cwd = cwd
      addWork(result, { cwd })
    }
    const model = modelName(payload.model)
    if (model) result.model = model
  }

  private responseItem(item: Fields, id: string, ts: string, result: CodexLine) {
    switch (item.type) {
      case 'message':
        return this.message(item, id, ts, result)
      case 'reasoning': {
        const summary = (Array.isArray(item.summary) ? item.summary : [])
          .map(part => text((part as Fields | null)?.text))
          .filter((part): part is string => part !== undefined)
        const heading = summary.length ? reasoningHeading(summary[0]) : undefined
        if (heading) result.entries.push({ id, ts, kind: 'system', text: heading })
        return
      }
      case 'function_call': {
        const callId = text(item.call_id)
        const name = text(item.name)
        if (callId && name) this.call(callId, name, text(item.namespace), args(item.arguments), id, ts, result)
        return
      }
      case 'custom_tool_call': {
        const callId = text(item.call_id)
        const name = text(item.name)
        const input = typeof item.input === 'string' ? item.input : ''
        if (callId && name) this.call(callId, name, undefined, { input }, id, ts, result)
        return
      }
      case 'local_shell_call': {
        const callId = text(item.call_id) ?? text(item.id)
        const action = (item.action ?? {}) as Fields
        if (callId) this.call(callId, 'local_shell', undefined, { command: action.command }, id, ts, result)
        return
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = text(item.call_id)
        if (callId) this.output(callId, item.output, id, ts, result)
        return
      }
      case 'image_generation_call': {
        const image = text(item.result)
        if (!image) return
        const callId = text(item.id) ?? id
        const summary = toolSummary('image_generation', { prompt: text(item.revised_prompt) ?? '' })
        result.entries.push({ id, ts, kind: 'tool', toolUseId: callId, name: 'image_generation', summary })
        const images = [{ mediaType: 'image/png', data: image }]
        result.entries.push({ id: `${id}:result`, ts, kind: 'tool_result', toolUseId: callId, ...entryImages('', images), isError: false })
        return
      }
    }
  }

  /** An answer is shown; a prompt only lends its images to the event that shows it. */
  private message(item: Fields, id: string, ts: string, result: CodexLine) {
    const content = Array.isArray(item.content) ? (item.content as Fields[]) : []
    if (item.role === 'assistant') {
      const body = content
        .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
        .map(part => part.text as string)
        .join('\n')
      if (body.trim()) result.entries.push({ id, ts, kind: 'assistant', text: body })
    } else if (item.role === 'user') {
      const images = content.flatMap(part => (part?.type === 'input_image' ? dataImages([part.image_url]) : []))
      if (images.length) this.images = images
    }
  }

  private call(callId: string, name: string, namespace: string | undefined, input: Fields, id: string, ts: string, result: CodexLine) {
    const tool = codexToolName(name, namespace)
    const entry = (toolName: string, summary: string, extra: Partial<Extract<Entry, { kind: 'tool' }>> = {}): Entry => ({
      id,
      ts,
      kind: 'tool',
      toolUseId: callId,
      name: toolName,
      summary,
      ...extra,
    })
    if (!namespace && name === 'apply_patch') {
      const files = patchFiles(typeof input.input === 'string' ? input.input : '', this.cwd)
      this.remember(callId, { kind: 'patch' })
      if (!files.length) {
        result.entries.push(entry('apply_patch', ''))
        return
      }
      this.patched.add(callId)
      result.entries.push(...fileEntries(files, id, ts, callId))
      return
    }
    if (tool === 'ToolSearch') return this.remember(callId, { kind: 'hidden' })
    if (!namespace && CODEX_SHELL_TOOLS.has(name)) {
      const command = shellCommand(input) ?? ''
      this.remember(callId, { kind: 'shell', command })
      if (command) result.commands = { ...result.commands, [callId]: command }
      result.entries.push(entry('Bash', toolSummary('Bash', { command })))
      return
    }
    if (!namespace && name === 'write_stdin') {
      // Polling a command that is still running reads as that command again: its output, and how it ended, are its own.
      const command = this.running.get(String(input.session_id ?? ''))
      if (command) {
        this.remember(callId, { kind: 'shell', command })
        result.commands = { ...result.commands, [callId]: command }
        result.entries.push(entry('Bash', toolSummary('Bash', { command })))
      } else {
        this.remember(callId, { kind: 'other' })
        result.entries.push(entry(name, toolSummary(name, { chars: text(input.chars) ?? '' })))
      }
      return
    }
    this.remember(callId, { kind: 'other' })
    if (tool === 'TodoWrite') {
      const plan = Array.isArray(input.plan) ? (input.plan as Fields[]) : []
      const todos = todoItems('TodoWrite', { todos: plan.map(step => ({ content: step?.step, status: step?.status })) })
      result.entries.push(entry('TodoWrite', toolSummary('TodoWrite', {}), todos ? { todos } : {}))
    } else if (tool === 'Read') {
      result.entries.push(entry('Read', toolSummary('Read', { file_path: text(input.path) ?? '' })))
    } else if (tool === 'Task') {
      result.entries.push(entry('Task', toolSummary('Task', { description: text(input.task_name), prompt: text(input.message) })))
    } else if (tool === 'AskUserQuestion') {
      const first = Array.isArray(input.questions) ? (input.questions[0] as Fields | undefined) : undefined
      result.entries.push(entry(tool, toolSummary(tool, { question: text(first?.question) ?? '' })))
    } else {
      result.entries.push(entry(tool, toolSummary(tool, input)))
    }
  }

  private output(callId: string, output: unknown, id: string, ts: string, result: CodexLine) {
    const call = this.calls.get(callId)
    if (call?.kind === 'hidden') return
    const body = outputBody(output)
    let shown = body.text
    let isError = false
    if (call?.kind === 'shell') {
      const run = execResult(body.text)
      if (run.session !== undefined && call.command) remember(this.running, run.session, call.command)
      shown = run.text
      isError = run.isError
    } else if (call?.kind === 'patch') {
      // Codex applies a patch itself, or through its shell runtime, whose output has the shell's header.
      const run = execResult(body.text)
      shown = run.text
      isError = run.isError || this.failedPatches.has(callId) || /^(apply_patch verification failed|failed to apply)/i.test(shown.trim())
    }
    result.entries.push({ id, ts, kind: 'tool_result', toolUseId: callId, ...entryImages(cutToolResult(shown), body.images), isError })
  }

  private event(event: Fields, id: string, ts: string, stamp: string | undefined, result: CodexLine) {
    switch (event.type) {
      case 'user_message':
        return this.prompt(event, id, ts, stamp, result)
      case 'task_started':
      case 'turn_started': {
        const turnId = text(event.turn_id) ?? id
        const window = positive(event.model_context_window)
        if (window) result.contextWindow = window
        result.status = 'working'
        // A prompt that came first already started it.
        if (this.turn?.id.startsWith('user:')) this.turn = { ...this.turn, id: turnId }
        else {
          this.turn = { id: turnId, ...(positive(event.started_at) ? { startedAt: positive(event.started_at) } : {}), since: stamp }
          addWork(result, { start: { id: turnId, from: 'auto', queued: false } })
        }
        return
      }
      case 'task_complete':
      case 'turn_complete':
        return this.endTurn(event, id, stamp, result)
      case 'turn_aborted':
        if (event.reason === 'interrupted') result.entries.push({ id, ts, kind: 'system', text: 'Interrupted by user' })
        addWork(result, { broken: true })
        return this.endTurn(event, id, stamp, result)
      case 'token_count':
        return tokenCount(event, result)
      case 'context_compacted':
        result.compacted = true
        result.entries.push({ id, ts, kind: 'system', text: 'Conversation compacted' })
        return
      case 'patch_apply_end': {
        const callId = text(event.call_id)
        if (!callId) return
        if (event.success === false) this.failedPatches.add(callId)
        if (this.patched.has(callId)) return
        this.patched.add(callId)
        const changes = (event.changes && typeof event.changes === 'object' ? event.changes : {}) as Fields
        const files = Object.entries(changes).flatMap(([path, change]) => appliedFile(path, change) ?? [])
        result.entries.push(...fileEntries(files, id, ts, callId))
        bound(this.patched)
        bound(this.failedPatches)
        return
      }
      case 'web_search_end': {
        const callId = text(event.call_id) ?? id
        const action = (event.action ?? {}) as Fields
        const query = text(event.query) ?? text(action.query) ?? text(action.url) ?? ''
        result.entries.push({ id, ts, kind: 'tool', toolUseId: callId, name: 'WebSearch', summary: toolSummary('WebSearch', { query }) })
        result.entries.push({ id: `${id}:result`, ts, kind: 'tool_result', toolUseId: callId, text: '', isError: false })
        return
      }
      case 'error': {
        const message = text(event.message)
        if (message) result.entries.push({ id, ts, kind: 'system', text: cutText(message, MAX_ERROR_CHARS) })
        addWork(result, { broken: true })
        return
      }
    }
  }

  private prompt(event: Fields, id: string, ts: string, stamp: string | undefined, result: CodexLine) {
    const body = typeof event.message === 'string' ? event.message : ''
    const shown = dataImages(Array.isArray(event.images) ? event.images : [])
    const images = shown.length ? shown : this.images
    this.images = []
    if ((!body.trim() && !images.length) || INTERNAL_USER_TEXT.test(body)) return
    result.entries.push({ id, ts, kind: 'user', ...entryImages(body, images) })
    const oneLine = body.replace(/\s+/g, ' ').trim()
    if (!this.titled && oneLine) {
      this.titled = true
      result.title = oneLine.length > MAX_TITLE_CHARS ? `${cutText(oneLine, MAX_TITLE_CHARS)}…` : oneLine
    }
    const from = isPoolPost(body) ? 'pool' : 'user'
    if (this.turn) addWork(result, { start: { id, from, queued: true } })
    else {
      this.turn = { id: `user:${id}`, since: stamp }
      addWork(result, { start: { id, from, queued: false } })
    }
  }

  /** A turn's end needs Codex's own time: a made-up one would differ at each read and count the turn again. */
  private endTurn(event: Fields, id: string, stamp: string | undefined, result: CodexLine) {
    const turnId = text(event.turn_id) ?? (this.turn && !this.turn.id.startsWith('user:') ? this.turn.id : id)
    const started = this.turn
    this.turn = undefined
    result.status = 'idle'
    if (!stamp) return
    const ms = positive(event.duration_ms)
    const completed = positive(event.completed_at)
    const seconds =
      ms !== undefined
        ? ms / 1000
        : completed !== undefined && started?.startedAt !== undefined
          ? completed - started.startedAt
          : started?.since
            ? (Date.parse(stamp) - Date.parse(started.since)) / 1000
            : undefined
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return
    result.turn = { end: stamp, seconds: Math.round(seconds * 10) / 10 }
    addWork(result, { turnId })
  }

  private remember(callId: string, call: Call) {
    remember(this.calls, callId, call)
  }
}

/** Every line of a rollout, read from its start. */
export function parseRollout(lines: Iterable<string>): CodexLine[] {
  const rollout = new CodexRollout()
  return [...lines].filter(line => line.trim()).map(line => rollout.line(line))
}

/** One entry per file a patch changes, each under the patch's call id: its output says whether they all went in. */
function fileEntries(files: PatchFile[], id: string, ts: string, callId: string): Entry[] {
  return files.map((file, index) => ({
    id: `${id}:${index}`,
    ts,
    kind: 'tool',
    toolUseId: callId,
    name: file.tool,
    summary: toolSummary(file.tool, { file_path: file.path }),
    ...(file.edits.length ? { edits: file.edits } : {}),
  }))
}

/** The tokens of the response a `token_count` event follows, the window, and the plan's usage. */
function tokenCount(event: Fields, result: CodexLine) {
  const info = (event.info ?? undefined) as Fields | undefined
  const last = (info?.last_token_usage ?? undefined) as Fields | undefined
  const total = positive((info?.total_token_usage as Fields | undefined)?.total_tokens)
  if (last && total !== undefined) {
    const input = count(last.input_tokens)
    const cached = Math.min(input, count(last.cached_input_tokens))
    // Reasoning is in the output already: `reasoning_output_tokens` is its share.
    result.usage = {
      requestId: `codex-total-${total}`,
      input: input - cached,
      output: count(last.output_tokens),
      cacheRead: cached,
      cacheWrite: 0,
    }
  }
  const window = positive(info?.model_context_window)
  if (window) result.contextWindow = window
  const limits = rateLimits(event.rate_limits)
  if (limits) result.rateLimits = limits
}

function rateLimits(value: unknown): CodexRateLimits | undefined {
  if (!value || typeof value !== 'object') return undefined
  const fields = value as Fields
  const window = (raw: unknown): CodexRateWindow | undefined => {
    const part = (raw ?? undefined) as Fields | undefined
    if (typeof part?.used_percent !== 'number' || !Number.isFinite(part.used_percent)) return undefined
    const minutes = positive(part.window_minutes)
    const resets = positive(part.resets_at)
    return {
      usedPercent: Math.min(100, Math.max(0, part.used_percent)),
      ...(minutes ? { windowMinutes: minutes } : {}),
      ...(resets ? { resetsAt: new Date(resets * 1000).toISOString() } : {}),
    }
  }
  const primary = window(fields.primary)
  const secondary = window(fields.secondary)
  const limitId = text(fields.limit_id)
  const planType = text(fields.plan_type)
  const reached = text(fields.rate_limit_reached_type)
  if (!primary && !secondary && !reached) return undefined
  return {
    ...(limitId ? { limitId } : {}),
    ...(planType ? { planType } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(reached ? { reached } : {}),
  }
}

/**
 * A shell call's output as Claude Code's Bash shows it, which the cluster detector reads: the output alone, after `Exit
 * code N` when the command failed, and `Command running in background` while it still runs. Codex writes a header
 * before `Output:` (`Exit code: N` for shell_command, `Process exited with code N` or `Process running with session ID
 * N` for exec_command), or, in older versions, `{ output, metadata: { exit_code } }`.
 */
export function execResult(raw: string): { text: string; isError: boolean; session?: string } {
  const json = jsonExit(raw)
  if (json) return { text: json.code ? `Exit code ${json.code}\n${json.output}` : json.output, isError: json.code !== 0 }
  const marker = /(^|\n)Output:\n?/.exec(raw)
  if (!marker) {
    // No header: Codex refused the call (rejected, sandbox denied) before it ran.
    const refused = /^(exec command rejected|.*\brejected by user|execution error|failed to (spawn|execute|run))/i.test(raw.trim())
    return { text: raw, isError: refused }
  }
  const header = raw.slice(0, marker.index)
  const output = raw.slice(marker.index + marker[0].length)
  const running = /^Process running with session ID (\S+)/m.exec(header)
  if (running) return { text: `Command running in background\n${output}`, isError: false, session: running[1] }
  const exit = /^(?:Exit code:|Process exited with code) (-?\d+)/m.exec(header)
  const code = exit ? Number(exit[1]) : 0
  return { text: code ? `Exit code ${code}\n${output}` : output, isError: code !== 0 }
}

function jsonExit(raw: string): { output: string; code: number } | undefined {
  if (!raw.startsWith('{')) return undefined
  try {
    const value = JSON.parse(raw) as { output?: unknown; metadata?: { exit_code?: unknown } }
    if (typeof value?.output !== 'string' || typeof value.metadata?.exit_code !== 'number') return undefined
    return { output: value.output, code: value.metadata.exit_code }
  } catch {
    return undefined
  }
}

/** A call's output is text, or content items: `input_text`, and `input_image` with a data URL, as view_image returns. */
function outputBody(output: unknown): { text: string; images: ImageData[] } {
  if (typeof output === 'string') return { text: output, images: [] }
  const items = Array.isArray(output) ? (output as Fields[]) : []
  const texts = items.filter(item => item?.type === 'input_text' && typeof item.text === 'string').map(item => item.text as string)
  return { text: texts.join('\n'), images: dataImages(items.filter(item => item?.type === 'input_image').map(item => item.image_url)) }
}

/** Images given as data URLs; Codex passes pasted and viewed images to the model that way. */
function dataImages(urls: unknown[]): ImageData[] {
  return urls.flatMap(url => {
    const match = typeof url === 'string' ? /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url) : null
    return match ? [{ mediaType: match[1], data: match[2] }] : []
  })
}

/** A reasoning summary as one short line: its bold heading, as Codex's own UI shows it, or its first sentence. */
function reasoningHeading(summary: string): string | undefined {
  const bold = /^\s*\*\*(.+?)\*\*/.exec(summary)?.[1]
  const line = (bold ?? summary.split('\n').find(part => part.trim()) ?? '').replace(/\s+/g, ' ').trim()
  if (!line) return undefined
  return line.length > MAX_REASONING_CHARS ? `${cutText(line, MAX_REASONING_CHARS)}…` : line
}

function args(raw: unknown): Fields {
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? (raw as Fields) : {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function addWork(result: ParsedLine, work: LineWork) {
  result.work = { ...result.work, ...work }
}

function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.set(key, value)
  if (map.size > MAX_PENDING) map.delete(map.keys().next().value as string)
}

function bound(set: Set<string>) {
  if (set.size > MAX_PENDING) set.delete(set.values().next().value as string)
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
