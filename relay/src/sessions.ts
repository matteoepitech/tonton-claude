import type { HookPost, Sealed, SealedEntry, SealedPermission, SessionStatus, SessionSummary } from '../../shared/protocol'
import type { ArchivedSession, SessionArchive } from './archive'
import {
  FINISHED_SESSION_TTL_MS,
  MAX_ACCOUNT_BYTES,
  MAX_ENTRIES_PER_SESSION,
  MAX_PENDING_PERMISSIONS,
  MAX_SESSION_BYTES,
  MAX_SESSIONS_PER_ACCOUNT,
} from './limits'
import { SESSION_STATUSES } from './metrics'

export interface SessionListener {
  updated(accountId: string, session: SessionSummary): void
  removed(accountId: string, sessionId: string): void
  /** A request that was not pending yet, after `updated`. */
  permissionRequested?(accountId: string, session: SessionSummary, request: SealedPermission): void
}

interface Session extends SessionSummary {
  history: SealedEntry[]
  historyIds: Set<string>
  historyBytes: number
}

const HOOK_STATUS: Record<string, SessionStatus | undefined> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  Stop: 'idle',
  StopFailure: 'error',
  SessionEnd: 'ended',
}

/**
 * Live sessions, in memory and partitioned by account. Every content field is a sealed blob the relay cannot read.
 * Memory is bounded per session and per account; the oldest history goes first. With an archive, every change is also
 * written to disk, and the sessions come back from it after a restart.
 */
export class SessionStore {
  private readonly accounts = new Map<string, Map<string, Session>>()
  private readonly gcTimer: Timer

  constructor(
    private readonly listener: SessionListener,
    private readonly archive: SessionArchive | null = null,
  ) {
    if (archive) this.restore(archive.load())
    this.gcTimer = setInterval(() => this.collectFinished(), 60_000)
  }

  dispose() {
    clearInterval(this.gcTimer)
  }

  list(accountId: string): SessionSummary[] {
    return [...(this.accounts.get(accountId)?.values() ?? [])].map(toSummary)
  }

  history(accountId: string, sessionId: string): SealedEntry[] {
    return this.get(accountId, sessionId)?.history ?? []
  }

  /** Totals over every account, for the metrics page. */
  stats(): { byStatus: Record<SessionStatus, number>; entries: number; bytes: number } {
    const byStatus = Object.fromEntries(SESSION_STATUSES.map(status => [status, 0])) as Record<SessionStatus, number>
    let entries = 0
    let bytes = 0
    for (const sessions of this.accounts.values()) {
      for (const session of sessions.values()) {
        byStatus[session.status]++
        entries += session.history.length
        bytes += session.historyBytes
      }
    }
    return { byStatus, entries, bytes }
  }

  applyHook(accountId: string, machineId: string, { event, detail }: HookPost) {
    const status =
      event.hook_event_name === 'Notification'
        ? event.notification_type === 'permission_prompt'
          ? 'permission'
          : 'waiting'
        : HOOK_STATUS[event.hook_event_name]
    if (!status) return
    const session = this.ensure(accountId, machineId, event.session_id)
    if (!session) return

    session.status = status
    session.statusDetail = detail ?? null
    if (status === 'idle' || status === 'ended') session.pendingPermissions = []
    if (status === 'ended') session.canChat = false
    this.changed(accountId, session)
  }

  /** Returns false when the session belongs to another machine. */
  agentConnected(accountId: string, machineId: string, sessionId: string, info: Sealed, canChat: boolean): boolean {
    const session = this.ensure(accountId, machineId, sessionId)
    if (!session) return false
    session.info = info
    session.agentOnline = true
    session.canChat = canChat
    if (session.status === 'offline' || session.status === 'ended' || session.status === 'starting') session.status = 'idle'
    this.changed(accountId, session)
    return true
  }

  agentDisconnected(accountId: string, sessionId: string) {
    const session = this.get(accountId, sessionId)
    if (!session) return
    session.agentOnline = false
    session.canChat = false
    session.pendingPermissions = []
    if (session.status !== 'ended') session.status = 'offline'
    this.changed(accountId, session)
  }

  /** Appends entries and returns the ones that were new. `reset` replaces the whole history. */
  addEntries(accountId: string, sessionId: string, entries: SealedEntry[], reset: boolean): SealedEntry[] {
    const session = this.get(accountId, sessionId)
    if (!session) return []
    if (reset) {
      session.history = []
      session.historyIds.clear()
      session.historyBytes = 0
      this.archive?.clearEntries(accountId, sessionId)
    }
    const fresh = entries.filter(entry => !session.historyIds.has(entry.id))
    for (const entry of fresh) {
      session.history.push(entry)
      session.historyIds.add(entry.id)
      session.historyBytes += entry.blob.length
    }
    if (fresh.length) this.archive?.addEntries(accountId, sessionId, fresh)
    this.trim(accountId, session, MAX_ENTRIES_PER_SESSION, MAX_SESSION_BYTES)
    this.enforceAccountBudget(accountId)

    if (fresh.length && !reset && (session.status === 'idle' || session.status === 'starting')) session.status = 'working'
    if (fresh.length || reset) this.changed(accountId, session)
    return fresh
  }

  /** The name a Mac gave the session. Not activity: the session keeps its place in the list. */
  rename(accountId: string, sessionId: string, name: Sealed) {
    const session = this.get(accountId, sessionId)
    if (!session) return
    session.name = name
    this.saved(accountId, session)
  }

  setMeta(accountId: string, sessionId: string, meta: Sealed) {
    const session = this.get(accountId, sessionId)
    if (!session) return
    session.meta = meta
    this.changed(accountId, session)
  }

  addPermission(accountId: string, sessionId: string, request: SealedPermission) {
    const session = this.get(accountId, sessionId)
    if (!session) return
    const others = session.pendingPermissions.filter(p => p.requestId !== request.requestId)
    const isNew = others.length === session.pendingPermissions.length
    session.pendingPermissions = [...others, request].slice(-MAX_PENDING_PERMISSIONS)
    session.status = 'permission'
    this.changed(accountId, session)
    if (isNew) this.listener.permissionRequested?.(accountId, toSummary(session), request)
  }

  closePermission(accountId: string, sessionId: string, requestId: string) {
    const session = this.get(accountId, sessionId)
    if (!session) return
    session.pendingPermissions = session.pendingPermissions.filter(p => p.requestId !== requestId)
    if (session.status === 'permission' && session.pendingPermissions.length === 0) {
      session.status = 'working'
      session.statusDetail = null
    }
    this.changed(accountId, session)
  }

  remove(accountId: string, sessionId: string) {
    if (!this.accounts.get(accountId)?.delete(sessionId)) return
    this.archive?.removeSession(accountId, sessionId)
    this.listener.removed(accountId, sessionId)
  }

  removeMachine(accountId: string, machineId: string) {
    for (const session of this.sessionsOf(accountId)) {
      if (session.machineId === machineId) this.remove(accountId, session.id)
    }
  }

  removeAccount(accountId: string) {
    this.accounts.delete(accountId)
    this.archive?.removeAccount(accountId)
  }

  private get(accountId: string, sessionId: string): Session | undefined {
    return this.accounts.get(accountId)?.get(sessionId)
  }

  private accountSessions(accountId: string): Map<string, Session> {
    let sessions = this.accounts.get(accountId)
    if (!sessions) {
      sessions = new Map()
      this.accounts.set(accountId, sessions)
    }
    return sessions
  }

  private sessionsOf(accountId: string): Session[] {
    return [...(this.accounts.get(accountId)?.values() ?? [])]
  }

  /** Finds or creates a session. A machine can only ever touch its own sessions. */
  private ensure(accountId: string, machineId: string, sessionId: string): Session | null {
    const sessions = this.accountSessions(accountId)
    const existing = sessions.get(sessionId)
    if (existing) return existing.machineId === machineId ? existing : null

    if (sessions.size >= MAX_SESSIONS_PER_ACCOUNT) this.evictOne(accountId)
    const now = new Date().toISOString()
    const session: Session = {
      id: sessionId,
      machineId,
      status: 'starting',
      agentOnline: false,
      canChat: false,
      info: null,
      meta: null,
      statusDetail: null,
      pendingPermissions: [],
      startedAt: now,
      lastActivity: now,
      name: null,
      history: [],
      historyIds: new Set(),
      historyBytes: 0,
    }
    sessions.set(sessionId, session)
    return session
  }

  private changed(accountId: string, session: Session) {
    session.lastActivity = new Date().toISOString()
    this.saved(accountId, session)
  }

  private saved(accountId: string, session: Session) {
    this.archive?.saveSession(accountId, session)
    this.listener.updated(accountId, toSummary(session))
  }

  /** Sessions saved before a restart. Their agents are gone until they reconnect and say hello again. */
  private restore(saved: ArchivedSession[]) {
    for (const { accountId, history, ...summary } of saved) {
      const session: Session = {
        ...summary,
        status: summary.status === 'ended' ? 'ended' : 'offline',
        agentOnline: false,
        canChat: false,
        pendingPermissions: [],
        history,
        historyIds: new Set(history.map(entry => entry.id)),
        historyBytes: history.reduce((sum, entry) => sum + entry.blob.length, 0),
      }
      this.accountSessions(accountId).set(session.id, session)
      this.trim(accountId, session, MAX_ENTRIES_PER_SESSION, MAX_SESSION_BYTES)
    }
    for (const accountId of this.accounts.keys()) this.enforceAccountBudget(accountId)
    this.collectFinished()
  }

  /** Drops the oldest history beyond the limits, on disk too. */
  private trim(accountId: string, session: Session, maxEntries: number, maxBytes: number) {
    const dropped = trimHistory(session, maxEntries, maxBytes)
    if (dropped.length) this.archive?.dropEntries(accountId, session.id, dropped)
  }

  /** Makes room for a new session: the least recently active offline one, or the least recent overall. */
  private evictOne(accountId: string) {
    const byAge = this.sessionsOf(accountId).sort((a, b) => a.lastActivity.localeCompare(b.lastActivity))
    const victim = byAge.find(s => !s.agentOnline) ?? byAge[0]
    if (victim) this.remove(accountId, victim.id)
  }

  /** Halves the history of the least recently active sessions until the account fits its budget. */
  private enforceAccountBudget(accountId: string) {
    const sessions = this.sessionsOf(accountId)
    let total = sessions.reduce((sum, s) => sum + s.historyBytes, 0)
    if (total <= MAX_ACCOUNT_BYTES) return
    for (const session of sessions.sort((a, b) => a.lastActivity.localeCompare(b.lastActivity))) {
      const before = session.historyBytes
      this.trim(accountId, session, Math.floor(session.history.length / 2), Math.floor(session.historyBytes / 2))
      total -= before - session.historyBytes
      if (total <= MAX_ACCOUNT_BYTES) return
    }
  }

  private collectFinished() {
    const cutoff = Date.now() - FINISHED_SESSION_TTL_MS
    for (const [accountId, sessions] of this.accounts) {
      for (const session of sessions.values()) {
        const finished = session.status === 'ended' || session.status === 'offline'
        if (finished && Date.parse(session.lastActivity) < cutoff) this.remove(accountId, session.id)
      }
      if (sessions.size === 0) this.accounts.delete(accountId)
    }
  }
}

/** Returns the ids of the entries it dropped. */
function trimHistory(session: Session, maxEntries: number, maxBytes: number): string[] {
  const dropped: string[] = []
  while (session.history.length > maxEntries || (session.historyBytes > maxBytes && session.history.length > 0)) {
    const entry = session.history.shift()
    if (!entry) break
    session.historyIds.delete(entry.id)
    session.historyBytes -= entry.blob.length
    dropped.push(entry.id)
  }
  return dropped
}

function toSummary(session: Session): SessionSummary {
  const { history: _history, historyIds: _ids, historyBytes: _bytes, ...summary } = session
  return summary
}
