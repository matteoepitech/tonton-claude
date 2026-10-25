import { appendFileSync, mkdirSync } from 'node:fs'
import { paths } from './config'

/** Appends to ~/.tonton/tonton.log. Hooks and the channel must never write to stdout. */
export function log(message: string, details?: unknown) {
  try {
    mkdirSync(paths.home, { recursive: true, mode: 0o700 })
    const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`
    appendFileSync(paths.log, `${new Date().toISOString()} [${process.pid}] ${message}${suffix}\n`)
  } catch {
    // Logging is best effort.
  }
}
