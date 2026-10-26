// Sessions and machines as a client shows them, once decrypted, with the rules the notch follows to label and order
// them. The TypeScript twin of app/Sources/TontonCore/Session.swift, for the web, Windows and Linux apps.

import type { MachineHealth, SessionCommand, SessionStatus, TokenCounts } from './protocol'

export const STATUSES: readonly SessionStatus[] = ['starting', 'working', 'waiting', 'permission', 'idle', 'error', 'ended', 'offline']

export const STATUS_LABELS: Record<SessionStatus, string> = {
  starting: 'Starting',
  working: 'Working',
  waiting: 'Waiting for you',
  permission: 'Needs approval',
  idle: 'Done',
  error: 'Error',
  ended: 'Closed',
  offline: 'Offline',
}

export const needsAttention = (status: SessionStatus): boolean => status === 'waiting' || status === 'permission' || status === 'error'

export const isLive = (status: SessionStatus): boolean => status !== 'ended' && status !== 'offline'

/** The status that stands for several live sessions: the one that needs the user most. */
export function mostUrgent(statuses: readonly SessionStatus[]): SessionStatus | null {
  const order: SessionStatus[] = ['permission', 'error', 'waiting', 'working', 'starting', 'idle']
  return order.find(status => statuses.includes(status)) ?? null
}

export interface PermissionRequest {
  requestId: string
  toolName: string
  description: string
  inputPreview: string
  ts: string
}

/** How much of a Claude plan's usage window is spent. */
export interface UsageWindow {
  /** 0 to 100. */
  usedPercent: number
  /** Milliseconds since the epoch. */
  resetsAt: number
}

export type UsageLevel = 'normal' | 'high' | 'reached'

/** Null once the window has reset: the reading says nothing about the new one. */
export function usageLevel(window: UsageWindow, now = Date.now()): UsageLevel | null {
  if (window.resetsAt <= now) return null
  return window.usedPercent >= 100 ? 'reached' : window.usedPercent >= 80 ? 'high' : 'normal'
}

/** How full a session's context is: the input of its last API response, against the model's context window. */
export interface ContextWindow {
  usedTokens: number
  windowTokens: number
}

/** Without the window, Claude Code's default: 200K, unless the context is already past it, which only a 1M window allows. */
export function contextWindow(usedTokens: number, windowTokens?: number): ContextWindow {
  return { usedTokens, windowTokens: windowTokens ?? (usedTokens > 200_000 ? 1_000_000 : 200_000) }
}

/** A session, decrypted. Dates are milliseconds since the epoch, null when the relay sent something else. */
export interface Session {
  id: string
  machineId: string
  machine: string
  /** The agent's platform (win32, darwin, linux), when it reported one. */
  platform: string | null
  cwd: string
  project: string
  title: string | null
  status: SessionStatus
  statusText: string | null
  agentOnline: boolean
  canChat: boolean
  pendingPermissions: PermissionRequest[]
  costUSD: number | null
  /** Null with older agents. */
  tokens: TokenCounts | null
  /** Null with older agents, and before the first answer. */
  context: ContextWindow | null
  startedAt: number | null
  lastActivity: number | null
  lastMessage: string | null
  /** The 5-hour window of the Claude plan the session runs on. Null with an API key, and with older agents. */
  fiveHourLimit: UsageWindow | null
  sevenDayLimit: UsageWindow | null
  /** Runs in tmux, so a client can have its agent type slash commands in it. */
  terminal: boolean
  /** The commands its agent can type there. */
  commands: SessionCommand['name'][]
  /** The API id of the model it uses (`claude-opus-4-5-20251101`). Null with older agents, and before Claude Code says. */
  model: string | null
}

/** What agents that type in a terminal knew before `model`, and do not list. */
export const ORIGINAL_COMMANDS: readonly SessionCommand['name'][] = ['compact', 'clear']

/** Every command this client can send. */
export const COMMANDS: readonly SessionCommand['name'][] = ['compact', 'clear', 'model']

export interface Machine {
  id: string
  name: string
  platform: string | null
  createdAt: number | null
  lastSeen: number | null
  online: boolean
  /** Installed agent version, unknown for agents older than 0.4.0. */
  agentVersion: string | null
  /** The latest report of its background service. */
  health: MachineHealth | null
}

/** Claude Code's notification texts, shortened like the notch does. */
export function displayStatusText(session: Pick<Session, 'status' | 'statusText'>): string {
  const text = session.statusText
  if (!text) return STATUS_LABELS[session.status]
  const permission = text.indexOf('needs your permission to use ')
  if (permission >= 0) return `Wants to use ${text.slice(permission + 'needs your permission to use '.length)}`
  if (text.includes('waiting for your input')) return 'Waiting for you'
  // StopFailure's error type when the plan's limit refuses a request.
  if (text === 'rate_limit') return 'Usage limit reached'
  return text
}

/** Its agent can type in its terminal, and Claude waits at its prompt: Enter then only submits the command. */
export const acceptsCommands = (session: Session): boolean =>
  session.terminal && session.canChat && session.agentOnline && (session.status === 'idle' || session.status === 'waiting')

/** Live sessions first, then the most recently active, like the notch's list. */
export function sortSessions(sessions: readonly Session[]): Session[] {
  return [...sessions].sort((a, b) =>
    isLive(a.status) !== isLive(b.status) ? (isLive(a.status) ? -1 : 1) : (b.lastActivity ?? -Infinity) - (a.lastActivity ?? -Infinity),
  )
}

/** The session to show first: one that needs the user, or else a live one, or else the first. */
export function preferredSession(sessions: readonly Session[]): Session | null {
  return sessions.find(s => needsAttention(s.status)) ?? sessions.find(s => isLive(s.status)) ?? sessions[0] ?? null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** An ISO 8601 date and time with its zone, as the relay and the agents write them. Null for anything else. */
export function parseDate(text: string | null | undefined): number | null {
  if (!text || !ISO_DATE.test(text)) return null
  const time = Date.parse(text)
  return Number.isNaN(time) ? null : time
}
