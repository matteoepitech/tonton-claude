import { appendFileSync, mkdirSync } from 'node:fs'
import { paths } from './config'

/** Long enough for an error and its context, short enough that nothing large ends up in the log by mistake. */
const MAX_DETAILS = 1000

/**
 * Appends to ~/.tonton/tonton.log. Hooks and the channel must never write to stdout. The app can show the log
 * (Settings › Machines), so it says what the agent does and never holds what Claude writes: no prompt, message, tool
 * input, permission text or status text, even in an error.
 */
export function log(message: string, details?: unknown) {
  try {
    mkdirSync(paths.home, { recursive: true, mode: 0o700 })
    const suffix = details === undefined ? '' : ` ${JSON.stringify(details).slice(0, MAX_DETAILS)}`
    appendFileSync(paths.log, `${new Date().toISOString()} [${process.pid}] ${message}${suffix}\n`)
  } catch {
    // Logging is best effort.
  }
}
