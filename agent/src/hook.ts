import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HookPost } from '../../shared/protocol'
import { loadConfig, paths } from './config'
import { seal } from './crypto'
import { log } from './log'

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
}

/**
 * Called by Claude Code for each hook event, as a direct child of the claude process.
 * It must never get in the way of the session: failures are logged, and it always exits 0 without output.
 */
export async function runHook() {
  try {
    const event = JSON.parse(await Bun.stdin.text()) as HookInput
    if (!event?.session_id) return
    linkSession(event)

    const config = loadConfig()
    if (!config) return
    // Only the event type travels in clear: any text is sealed with the account key.
    const text = event.message ?? event.error ?? event.reason
    const body: HookPost = {
      event: {
        hook_event_name: event.hook_event_name,
        session_id: event.session_id,
        notification_type: event.notification_type,
        source: event.source,
      },
      ...(text ? { detail: await seal(config.key, { text }) } : {}),
    }
    await fetch(`${config.server}/api/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(event.hook_event_name === 'SessionEnd' ? 1000 : 2000),
    })
  } catch (error) {
    log('hook failed', String(error))
  }
}

/** Tells the channel of the same claude process which session and transcript it serves. */
function linkSession(event: HookInput) {
  mkdirSync(paths.run, { recursive: true, mode: 0o700 })
  const link = { sessionId: event.session_id, transcriptPath: event.transcript_path ?? null, cwd: event.cwd ?? null }
  writeFileSync(join(paths.run, `${process.ppid}.json`), JSON.stringify(link), { mode: 0o600 })
}
