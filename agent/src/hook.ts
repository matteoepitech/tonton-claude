import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { seal } from '../../shared/crypto'
import type { HookPost } from '../../shared/protocol'
import { terminalOf } from './channel/terminal'
import { type AgentConfig, loadConfig, paths } from './config'
import { log } from './log'
import { clearSessionRules, matchingRule, modeAllows, poolMode, poolRules, readRules, sessionRules } from './rules'
import { runningTasksIn } from './transcript/background'

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
    linkSession(event)
    if (event.hook_event_name === 'PermissionRequest') return approveByRule(event)
    if (event.hook_event_name === 'SessionEnd') clearSessionRules(event.session_id)

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
  const rules = [...(readRules()?.rules ?? []), ...sessionRules(event.session_id), ...poolRules(event.session_id)]
  const rule = event.tool_name ? matchingRule(rules, event.tool_name, event.tool_input) : undefined
  const mode = !rule && event.tool_name ? poolMode(event.session_id) : null
  if (!rule && !(mode && modeAllows(mode, event.tool_name ?? '', event.tool_input))) return
  log(rule ? 'approved by an auto-approve rule' : 'approved by the pool machine’s mode', { tool: rule?.tool ?? event.tool_name })
  const decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
  process.stdout.write(JSON.stringify(decision))
}

/** Tells the channel of the same claude process which session and transcript it serves. */
function linkSession(event: HookInput) {
  mkdirSync(paths.run, { recursive: true, mode: 0o700 })
  // Hooks get Claude Code's environment, so they know whether it runs in tmux; its channel may not.
  const link = { sessionId: event.session_id, transcriptPath: event.transcript_path ?? null, cwd: event.cwd ?? null, tmux: terminalOf() }
  writeFileSync(join(paths.run, `${process.ppid}.json`), JSON.stringify(link), { mode: 0o600 })
}
