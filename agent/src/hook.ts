import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { seal } from '../../shared/crypto'
import type { HookPost } from '../../shared/protocol'
import { terminalOf } from './channel/terminal'
import { clearGuardState, guard, readGuardState } from './cluster/guard'
import { type AgentConfig, loadConfig, paths } from './config'
import { log } from './log'
import { clearSessionRules, matchingRule, modeAllows, poolMode, poolRules, readRules, sessionRules } from './rules'
import { runningTasksIn } from './transcript/background'

/** A link left by a claude that ended without its SessionEnd hook, killed or with its terminal closed. */
const LINK_MAX_AGE_MS = 7 * 24 * 3600_000

interface HookInput {
  hook_event_name: string
  session_id: string
  transcript_path?: string
  cwd?: string
  message?: string
  notification_type?: string
  source?: string
  error?: string
  reason?: string
  tool_name?: string
  tool_input?: unknown
}

/**
 * Called by Claude Code for each hook event, as a direct child of the claude process.
 * It must never get in the way of the session: failures are logged, and it always exits 0. Only an approval by an
 * auto-approve rule prints something.
 */
export async function runHook() {
  const event = await readInput()
  if (!event) return log('hook: unreadable input')
  try {
    if (!event.session_id) return
    // Before each edit: it has to be quick, and the session is linked by then.
    if (event.hook_event_name === 'PreToolUse') return guardEdit(event)
    if (event.hook_event_name === 'SessionEnd') unlinkSession(event.session_id)
    else linkSession(event)
    if (event.hook_event_name === 'SessionStart') pruneLinks(paths.run)
    if (event.hook_event_name === 'PermissionRequest') return approveByRule(event)
    if (event.hook_event_name === 'SessionEnd') {
      clearSessionRules(event.session_id)
      clearGuardState(event.session_id)
    }

    const config = loadConfig()
    if (!config) return
    const { hook_event_name, session_id, notification_type, source } = event
    const background = waitsForBackground(event)
    // Still at work, in the background: neither done nor waiting for the user.
    if (background) return await postHook(config, { hook_event_name: 'UserPromptSubmit', session_id, source }, background)
    await postHook(config, { hook_event_name, session_id, notification_type, source }, event.message ?? event.error ?? event.reason)
  } catch (error) {
    log('hook failed', String(error))
  }
}

/** Sends a status change to the relay. Only the event type travels in clear: any text is sealed with the account key. */
export async function postHook(config: AgentConfig, event: HookPost['event'], text?: string) {
  const body: HookPost = { event, ...(text ? { detail: await seal(config.key, { text }) } : {}) }
  await fetch(`${config.server}/api/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(event.hook_event_name === 'SessionEnd' ? 1000 : 2000),
  })
}

/** The input holds the user's prompt or the tool's input: a parse error could quote it, so it is never logged. */
async function readInput(): Promise<HookInput | null> {
  try {
    return JSON.parse(await Bun.stdin.text()) as HookInput | null
  } catch {
    return null
  }
}

/**
 * Claude Code ends its turn, then says it waits for the user, while a shell, a monitor or an agent it started in the
 * background has yet to report back: what to say instead, or null.
 */
export function waitsForBackground(event: Pick<HookInput, 'hook_event_name' | 'notification_type' | 'transcript_path'>): string | null {
  const ends =
    event.hook_event_name === 'Stop' || (event.hook_event_name === 'Notification' && event.notification_type !== 'permission_prompt')
  if (!ends || !event.transcript_path) return null
  const running = runningTasksIn(event.transcript_path).length
  return running ? `Waiting for ${running} background task${running === 1 ? '' : 's'}` : null
}

/**
 * Claude Code asks before this call: approve it when an auto-approve rule from the app, one allowed for this session, or
 * a pool rule the machine owner accepted for this session matches, or when the session is a pool machine's and the
 * mode its owner chose lets it pass. Otherwise print nothing, and the user is asked as usual, in the terminal or the notch.
 */
function approveByRule(event: HookInput) {
  // A file another session of a cluster holds is the owner's to decide: no rule or mode lets that edit through.
  if (event.tool_name && guard(readGuardState(event.session_id), event.tool_name, event.tool_input, event.cwd)) return
  const rules = [...(readRules()?.rules ?? []), ...sessionRules(event.session_id), ...poolRules(event.session_id)]
  const rule = event.tool_name ? matchingRule(rules, event.tool_name, event.tool_input) : undefined
  const mode = !rule && event.tool_name ? poolMode(event.session_id) : null
  if (!rule && !(mode && modeAllows(mode, event.tool_name ?? '', event.tool_input))) return
  log(rule ? 'approved by an auto-approve rule' : 'approved by the pool machine’s mode', { tool: rule?.tool ?? event.tool_name })
  const decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
  process.stdout.write(JSON.stringify(decision))
}

/**
 * Claude Code is about to edit a file: when another session of one of this session's clusters holds it, the owner is
 * asked, with who holds it, or the edit is refused when the cluster says so. Otherwise print nothing. The path stays out
 * of the log, which the owner can send from the app.
 */
function guardEdit(event: HookInput) {
  const found = event.tool_name ? guard(readGuardState(event.session_id), event.tool_name, event.tool_input, event.cwd) : null
  if (!found) return
  log('cluster guard: the file is held', { tool: event.tool_name, decision: found.decision })
  const output = { hookEventName: 'PreToolUse', permissionDecision: found.decision, permissionDecisionReason: found.reason }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: output }))
}

/** Tells the channel of the same claude process which session and transcript it serves. */
function linkSession(event: HookInput) {
  mkdirSync(paths.run, { recursive: true, mode: 0o700 })
  // Hooks get Claude Code's environment, so they know whether it runs in tmux; its channel may not.
  const link = { sessionId: event.session_id, transcriptPath: event.transcript_path ?? null, cwd: event.cwd ?? null, tmux: terminalOf() }
  writeFileSync(join(paths.run, `${process.ppid}.json`), JSON.stringify(link), { mode: 0o600 })
}

/**
 * The link goes with its session: a claude started later with the same pid, which Windows hands out again soon, must not
 * follow the old session. Only if it still names it: after /clear, the next session's SessionStart may have come first.
 */
function unlinkSession(sessionId: string) {
  const file = join(paths.run, `${process.ppid}.json`)
  try {
    if ((JSON.parse(readFileSync(file, 'utf8')) as { sessionId?: unknown }).sessionId === sessionId) rmSync(file, { force: true })
  } catch {
    // No link, or one being written.
  }
}

/** Removes links no hook has touched for a week. Each hook event rewrites its session's link. */
export function pruneLinks(run: string, now = Date.now()) {
  try {
    for (const file of readdirSync(run)) {
      const path = join(run, file)
      const modified = /^\d+\.json$/.test(file) ? statSync(path, { throwIfNoEntry: false })?.mtimeMs : undefined
      if (modified !== undefined && now - modified > LINK_MAX_AGE_MS) rmSync(path, { force: true })
    }
  } catch {
    // No run folder yet: nothing to prune.
  }
}
