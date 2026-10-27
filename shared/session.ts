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

/**
 * Without the window, Claude Code's default: 200K. A context already past the window shows the window is bigger: it was
 * guessed from the model's name, which Claude Code writes without `[1m]` for the 1M window too. Like `ContextUsage`.
 */
export function contextWindow(usedTokens: number, windowTokens?: number): ContextWindow {
  const window = windowTokens ?? 200_000
  return { usedTokens, windowTokens: usedTokens > window ? Math.max(1_000_000, usedTokens) : window }
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
  /** What its agent runs for it: Claude Code in tmux types them, OpenCode runs them through its API. */
  commands: SessionCommand['name'][]
  /** The API id of the model it uses (`claude-opus-4-5-20251101`). Null with older agents, and before Claude Code says. */
  model: string | null
  /** The coding agent running it: `opencode`, or null for Claude Code and older agents. */
  tool: string | null
}

/** What agents that type in a terminal knew before `model`, and do not list. */
export const ORIGINAL_COMMANDS: readonly SessionCommand['name'][] = ['compact', 'clear']

/** Every command this client can send. */
export const COMMANDS: readonly SessionCommand['name'][] = ['compact', 'clear', 'model', 'interrupt']

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

/**
 * Its agent runs the command now: slash commands while the session waits at its prompt, where Enter only submits them,
 * and an interruption while it works. Like `SessionSummary.accepts` in the Mac app.
 */
export function accepts(session: Session, command: SessionCommand['name']): boolean {
  if (!session.commands.includes(command) || !session.canChat || !session.agentOnline) return false
  return command === 'interrupt' ? session.status === 'working' : session.status === 'idle' || session.status === 'waiting'
}

/** The slash commands of a session's menu: the model has its own, interrupting its own button. */
export const menuCommands = (session: Session): SessionCommand['name'][] =>
  (['compact', 'clear'] as const).filter(name => session.commands.includes(name))

/** One of the slash commands can run now. */
export const acceptsCommands = (session: Session): boolean => menuCommands(session).some(name => accepts(session, name))

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

const ACTIVITY_RANK: Partial<Record<SessionStatus, number>> = { permission: 0, error: 1, waiting: 2, working: 3 }

/**
 * What a closed notch or island shows, like the Dynamic Island: the session that needs the user most, or else the most
 * recently active one at work. Null when nothing is going on. Like `LiveActivity.pick` in the Mac app.
 */
export function liveActivity(sessions: readonly Session[]): Session | null {
  let best: Session | null = null
  for (const session of sessions) {
    const rank = ACTIVITY_RANK[session.status]
    if (rank === undefined) continue
    const bestRank = best ? (ACTIVITY_RANK[best.status] ?? 9) : 10
    const newer = (session.lastActivity ?? -Infinity) > (best?.lastActivity ?? -Infinity)
    if (rank < bestRank || (rank === bestRank && newer)) best = session
  }
  return best
}

/** What it needs when it needs the user, otherwise what it is working on. Like `LiveActivity.text`. */
export const liveActivityText = (session: Session): string =>
  needsAttention(session.status) ? displayStatusText(session) : (session.title ?? session.lastMessage ?? STATUS_LABELS[session.status])

/**
 * Why a session's new version is worth telling the user about: it started needing them (or asks for something else), or
 * it finished working. Like `SessionStore.notify` in the Mac app.
 */
export function sessionAlert(previous: Session | undefined, next: Session): 'attention' | 'finished' | null {
  const requests = (s: Session | undefined) => s?.pendingPermissions.map(p => p.requestId).join(' ')
  const changed = previous?.status !== next.status || requests(previous) !== requests(next)
  if (needsAttention(next.status) && changed) return 'attention'
  if (previous?.status === 'working' && next.status === 'idle') return 'finished'
  return null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** An ISO 8601 date and time with its zone, as the relay and the agents write them. Null for anything else. */
export function parseDate(text: string | null | undefined): number | null {
  if (!text || !ISO_DATE.test(text)) return null
  const time = Date.parse(text)
  return Number.isNaN(time) ? null : time
}
