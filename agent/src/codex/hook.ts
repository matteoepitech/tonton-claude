// `tonton hook codex`: what Codex runs for each hook event (codex-rs/hooks/src/schema.rs). Like Claude Code's hooks
// (agent/src/hook.ts), it links the session to the channel of the same codex process and tells the relay its status.
// Codex runs a hook's command through a shell: `$SHELL -c` on macOS and Linux, where the command starts with `exec` so
// the shell hands its pid over and the hook's parent is codex, as the channel's is; PowerShell or `cmd /C` on Windows,
// which cannot, so the hook asks Windows for its shell's parent once per session.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HookPost } from '../../../shared/protocol'
import { takePoolPosts } from '../channel/pool-held'
import { terminalOf } from '../channel/terminal'
import { loadConfig, paths } from '../config'
import { postHook, pruneLinks } from '../hook'
import { log } from '../log'
import { codexModeAllows, matchingRule, poolMode, poolRules, readRules, sessionRules } from '../rules'
import { patchFiles } from './patch'
import { codexToolName, shellCommand } from './tools'

/** Codex's hook input: the fields every event has, and those of some. */
export interface CodexHookInput {
  hook_event_name: string
  session_id: string
  turn_id?: string
  transcript_path?: string | null
  cwd?: string
  model?: string
  permission_mode?: string
  /** SessionStart: `startup`, `resume`, `clear` or `compact`. */
  source?: string
  /** UserPromptSubmit: what the user typed. Never logged, never sent. */
  prompt?: string
  tool_name?: string
  tool_input?: unknown
  /** PostToolUse. */
  tool_response?: unknown
  /** Set when a subagent's call runs the hook: `session_id` is then its parent's, `transcript_path` its own. */
  agent_id?: string
  stop_hook_active?: boolean
}

/** What the link says of the session, as the channel and cluster delivery read it (agent/src/channel/session-link.ts). */
interface CodexLink {
  sessionId: string
  transcriptPath: string | null
  cwd: string | null
  tool: 'codex'
  tmux?: unknown
  event: string
  permissionMode?: string
}

/** The events that say where the session is; the others leave the link's as it was. */
const STATE_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop'])
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse'])

/**
 * Called by Codex for each hook event it was told to run Tonton for. It must never get in the way of the session:
 * failures are logged, it prints nothing but an approval by an auto-approve rule or the pool posts that waited for a
 * prompt, and it always exits 0.
 */
export async function runCodexHook() {
  const event = await readInput()
  if (!event) return log('codex hook: unreadable input')
  try {
    if (!event.session_id || !event.hook_event_name) return
    const file = join(paths.run, `${codexPid(event.session_id)}.json`)
    const previous = readLink(file)
    writeLink(file, link(event, previous))
    if (event.hook_event_name === 'SessionStart') pruneLinks(paths.run)
    if (event.hook_event_name === 'PermissionRequest' && approveByRule(event)) return
    if (event.hook_event_name === 'UserPromptSubmit') handHeldPosts(event.session_id)
    const config = loadConfig()
    const status = codexStatus(event, previous?.event)
    if (config && status) await postHook(config, status.event, status.text)
  } catch (error) {
    log('codex hook failed', String(error))
  }
}

/**
 * What waited for this prompt, added to it as context Codex reads with it: the pool posts its channel could not hand
 * Codex as they came (agent/src/channel/pool-held.ts).
 */
function handHeldPosts(sessionId: string) {
  const context = [takePoolPosts(sessionId)].filter(Boolean).join('\n\n')
  if (!context) return
  log('pool posts handed to the prompt')
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }))
}

/**
 * The status change an event makes, as the Claude Code hook event that means the same (relay/src/sessions.ts):
 * SessionStart is idle, a prompt is working, a permission request waits for the user, the turn's end is idle. Codex has
 * no event for an answered request: the next tool hook of the turn says it goes on. Null when nothing changes.
 */
export function codexStatus(event: CodexHookInput, previous?: string): { event: HookPost['event']; text?: string } | null {
  const { hook_event_name: name, session_id } = event
  if (name === 'SessionStart') return event.source === 'compact' ? null : { event: { hook_event_name: 'SessionStart', session_id } }
  if (name === 'UserPromptSubmit') return { event: { hook_event_name: 'UserPromptSubmit', session_id } }
  if (name === 'Stop') return { event: { hook_event_name: 'Stop', session_id } }
  if (name === 'PermissionRequest') {
    const tool = toolName(event.tool_name)
    return {
      event: { hook_event_name: 'Notification', session_id, notification_type: 'permission_prompt' },
      text: `Codex needs your permission to use ${tool}`,
    }
  }
  if ((name === 'PreToolUse' || name === 'PostToolUse') && previous === 'PermissionRequest')
    return { event: { hook_event_name: 'UserPromptSubmit', session_id } }
  return null
}

/**
 * The link this event leaves. A subagent's calls run the hooks too, with their own rollout: the link keeps its session's.
 * Tool hooks are part of the turn the prompt started, and the link says so, as cluster delivery asks whether Codex is
 * in a turn (`hookState`).
 */
export function link(event: CodexHookInput, previous: CodexLink | null): CodexLink {
  const own = !event.agent_id && typeof event.transcript_path === 'string' && event.transcript_path
  const same = previous?.sessionId === event.session_id
  return {
    sessionId: event.session_id,
    transcriptPath: own ? (event.transcript_path as string) : same ? previous.transcriptPath : null,
    cwd: event.agent_id && same ? previous.cwd : (event.cwd ?? (same ? previous.cwd : null)),
    tool: 'codex',
    // Hooks get Codex's environment, so they know whether it runs in tmux; its MCP server's is cleared.
    tmux: terminalOf(),
    event: linkEvent(event, previous?.event),
    ...(event.permission_mode ? { permissionMode: event.permission_mode } : {}),
  }
}

/**
 * A tool hook is part of a turn: the session's own calls say it goes on, after a permission request too. A subagent's
 * may run while its parent waits for the user, and only end a request.
 */
function linkEvent(event: CodexHookInput, previous: string | undefined): string {
  const name = event.hook_event_name
  if (STATE_EVENTS.has(name)) return name
  if (TOOL_EVENTS.has(name) && (!event.agent_id || previous === 'PermissionRequest')) return 'UserPromptSubmit'
  return previous ?? name
}

/**
 * The pid of the codex process that runs this hook, which its channel knows as its parent. With `exec`, the shell
 * hands its pid over: the hook's parent is codex. Windows has no `exec`: the parent is the shell, and codex is its
 * parent, which Windows only tells another process. That takes a PowerShell, so it is asked once per session and kept,
 * for as long as that codex runs.
 */
export function codexPid(
  sessionId: string,
  { platform = process.platform, ppid = process.ppid, parentOf = windowsParent, run = paths.run } = {},
): number {
  if (platform !== 'win32') return ppid
  const cache = join(run, `codex-${sessionId.replace(/[^\w-]/g, '_')}.pid`)
  try {
    const kept = Number(readFileSync(cache, 'utf8'))
    if (Number.isInteger(kept) && kept > 0 && alive(kept)) return kept
  } catch {}
  const parent = parentOf(ppid)
  if (!parent) return ppid
  try {
    mkdirSync(run, { recursive: true, mode: 0o700 })
    writeFileSync(cache, String(parent), { mode: 0o600 })
  } catch {}
  return parent
}

/** The parent of a process, on Windows. */
function windowsParent(pid: number): number | null {
  const query = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  })
  const parent = Number(String(result.stdout ?? '').trim())
  return Number.isInteger(parent) && parent > 0 ? parent : null
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** apply_patch edits files; any other tool under the name the notch knows it by (./tools.ts). */
/**
 * Codex asks before this call: approve it when an auto-approve rule from the app, one allowed for this session, or a
 * pool rule its owner accepted matches, or when a pool machine's mode lets it pass, as Claude Code's hook does. True
 * when it printed the approval; otherwise the user is asked, in the terminal or the notch. A session run by
 * `tonton codex` gets the same from its channel (agent/src/codex/notch.ts).
 */
export function approveByRule(
  event: CodexHookInput,
  rules = [...(readRules()?.rules ?? []), ...sessionRules(event.session_id), ...poolRules(event.session_id)],
  mode = poolMode(event.session_id),
): boolean {
  if (!event.tool_name) return false
  const tool = toolName(event.tool_name)
  const input = (event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {}) as Record<string, unknown>
  const command = tool === 'Bash' ? shellCommand(input) : undefined
  const rule = matchingRule(rules, tool, tool === 'Bash' ? { command } : input)
  const byRule = Boolean(rule) && !(tool === 'Bash' && !command)
  // A patch comes as its text, in Codex's format: its files, from the session's folder.
  const patch = typeof input.command === 'string' ? input.command : typeof input.input === 'string' ? input.input : ''
  const files = tool === 'Edit' ? patchFiles(patch, event.cwd).map(file => file.path) : []
  if (!byRule && !codexModeAllows(mode, tool, files)) return false
  log(byRule ? 'approved by an auto-approve rule' : 'approved by the pool machine’s mode', { tool })
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }))
  return true
}

const toolName = (tool: string | undefined) => (tool === 'apply_patch' ? 'Edit' : codexToolName(tool || 'a tool'))

function readLink(file: string): CodexLink | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CodexLink
  } catch {
    return null
  }
}

function writeLink(file: string, value: CodexLink) {
  mkdirSync(paths.run, { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
}

/** The input holds the user's prompt or the tool's input: a parse error could quote it, so it is never logged. */
async function readInput(): Promise<CodexHookInput | null> {
  try {
    return JSON.parse(await Bun.stdin.text()) as CodexHookInput | null
  } catch {
    return null
  }
}
