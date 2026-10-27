// Reads what the relay sends a client. The relay is not trusted: a message whose shape is wrong is dropped, a session or a
// machine whose shape is wrong is left out, and unknown message types and fields are ignored, as in
// app/Sources/TontonCore/Wire.swift. Sealed fields are only checked to be strings here; the vault opens them.

import type { MachineSummary, RelayToApp, SealedEntry, SealedPermission, SessionSummary } from './protocol'
import { STATUSES } from './session'

type Fields = Record<string, unknown>

const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const isOptionalText = (value: unknown): value is string | null | undefined => value === undefined || value === null || isText(value)

function isPermission(value: unknown): value is SealedPermission {
  return isFields(value) && isText(value.requestId) && isText(value.ts) && isText(value.blob)
}

function isEntry(value: unknown): value is SealedEntry {
  return isFields(value) && isText(value.id) && isText(value.ts) && isText(value.blob)
}

export function isSessionSummary(value: unknown): value is SessionSummary {
  return (
    isFields(value) &&
    isText(value.id) &&
    isText(value.machineId) &&
    STATUSES.includes(value.status as SessionSummary['status']) &&
    typeof value.agentOnline === 'boolean' &&
    typeof value.canChat === 'boolean' &&
    isOptionalText(value.info) &&
    isOptionalText(value.meta) &&
    isOptionalText(value.statusDetail) &&
    Array.isArray(value.pendingPermissions) &&
    value.pendingPermissions.every(isPermission) &&
    isText(value.startedAt) &&
    isText(value.lastActivity)
  )
}

export function isMachineSummary(value: unknown): value is MachineSummary {
  return (
    isFields(value) &&
    isText(value.id) &&
    isText(value.name) &&
    isText(value.createdAt) &&
    isOptionalText(value.lastSeen) &&
    typeof value.online === 'boolean' &&
    isOptionalText(value.agentVersion) &&
    isOptionalText(value.health)
  )
}

const sessions = (value: unknown) => (Array.isArray(value) ? value.filter(isSessionSummary) : null)
const machines = (value: unknown) => (Array.isArray(value) ? value.filter(isMachineSummary) : null)
const entries = (value: unknown) => (Array.isArray(value) ? value.filter(isEntry) : null)

/** A message from the relay, or null for one this client does not know or that does not have the expected shape. */
export function parseRelayMessage(raw: string): RelayToApp | null {
  let message: unknown
  try {
    message = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isFields(message)) return null
  const m = message
  switch (m.t) {
    case 'snapshot': {
      const [s, list] = [sessions(m.sessions), machines(m.machines)]
      return s && list ? { t: 'snapshot', sessions: s, machines: list } : null
    }
    case 'session':
      return isSessionSummary(m.session) ? { t: 'session', session: m.session } : null
    case 'removed':
      return isText(m.sessionId) ? { t: 'removed', sessionId: m.sessionId } : null
    case 'machines': {
      const list = machines(m.machines)
      return list ? { t: 'machines', machines: list } : null
    }
    case 'history':
    case 'entries': {
      const list = entries(m.entries)
      if (!isText(m.sessionId) || !list) return null
      return m.t === 'history'
        ? { t: 'history', sessionId: m.sessionId, entries: list }
        : { t: 'entries', sessionId: m.sessionId, entries: list, reset: m.reset === true }
    }
    case 'error':
      return isText(m.message) ? { t: 'error', message: m.message } : null
    case 'agent_update':
      if (!isText(m.machineId) || typeof m.ok !== 'boolean' || !isOptionalText(m.detail)) return null
      return {
        t: 'agent_update',
        machineId: m.machineId,
        ok: m.ok,
        ...(m.reason === 'offline' || m.reason === 'unsupported' ? { reason: m.reason } : {}),
        detail: m.detail ?? null,
      }
    case 'session_start':
      if (!isText(m.machineId) || !isText(m.launchId) || !isText(m.state) || !isOptionalText(m.detail)) return null
      return {
        t: 'session_start',
        machineId: m.machineId,
        launchId: m.launchId,
        state: m.state as Extract<RelayToApp, { t: 'session_start' }>['state'],
        ...(m.reason === 'offline' ? { reason: m.reason } : {}),
        detail: m.detail ?? null,
      }
    case 'agent_logs':
      if (!isText(m.machineId) || !isText(m.requestId) || !isOptionalText(m.logs)) return null
      return {
        t: 'agent_logs',
        machineId: m.machineId,
        requestId: m.requestId,
        ...(m.reason === 'offline' ? { reason: m.reason } : {}),
        logs: m.logs ?? null,
      }
    case 'diagnosis':
      if (!isText(m.machineId) || !isText(m.requestId) || !isOptionalText(m.diagnosis)) return null
      return {
        t: 'diagnosis',
        machineId: m.machineId,
        requestId: m.requestId,
        ...(m.reason === 'offline' ? { reason: m.reason } : {}),
        diagnosis: m.diagnosis ?? null,
      }
    default:
      return null
  }
}
