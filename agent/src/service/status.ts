import { readFileSync, writeFileSync } from 'node:fs'
import { paths, VERSION } from '../config'

export type ServiceState = 'not-configured' | 'connecting' | 'connected' | 'revoked'

/** What the tray icon shows. */
export interface ServiceStatus {
  version: string
  state: ServiceState
  relay: string | null
  pid: number
}

export function writeStatus(state: ServiceState, relay: string | null) {
  const status: ServiceStatus = { version: VERSION, state, relay, pid: process.pid }
  try {
    writeFileSync(paths.status, JSON.stringify(status), { mode: 0o600 })
  } catch {
    // The tray keeps the previous state.
  }
}

export function readStatus(): ServiceStatus | null {
  try {
    return JSON.parse(readFileSync(paths.status, 'utf8')) as ServiceStatus
  } catch {
    return null
  }
}
