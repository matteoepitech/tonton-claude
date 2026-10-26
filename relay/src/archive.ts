import type { Database } from 'bun:sqlite'
import type { Sealed, SealedEntry, SessionStatus, SessionSummary } from '../../shared/protocol'

/** Writes are grouped: one transaction a second instead of one per transcript line, which would block on the disk. */
const FLUSH_MS = 1000

/** What survives a restart: ids, the state, the times and the sealed blobs. Pending permissions die with their agent. */
export interface ArchivedSession {
  accountId: string
  id: string
  machineId: string
  status: SessionStatus
  info: Sealed | null
  meta: Sealed | null
  statusDetail: Sealed | null
  startedAt: string
  lastActivity: string
  history: SealedEntry[]
}

interface SessionRow {
  account_id: string
  id: string
  machine_id: string
  status: SessionStatus
  info: string | null
  meta: string | null
  status_detail: string | null
  started_at: string
  last_activity: string
}

interface EntryRow {
  account_id: string
  session_id: string
  id: string
  ts: string
  blob: string
}

/**
 * A copy on disk of the sessions the relay holds in memory, read back when it starts. The memory stays the source of
 * truth: the store reports each change here, and the changes reach SQLite within a second.
 */
export class SessionArchive {
  /** Entry writes and removals, in the order they happened. */
  private pending: (() => void)[] = []
  /** Sessions whose summary changed, written last: only their latest state matters. */
  private readonly dirty = new Map<string, { accountId: string; session: SessionSummary }>()
  private readonly timer: Timer
  private closed = false

  constructor(private readonly db: Database) {
    this.timer = setInterval(() => this.flush(), FLUSH_MS)
  }

  /** Every saved session with its history, oldest entry first. Sessions of machines that are gone are deleted. */
  load(): ArchivedSession[] {
    this.db.transaction(() => {
      this.db.exec(`DELETE FROM sessions WHERE NOT EXISTS (
        SELECT 1 FROM machines m WHERE m.id = sessions.machine_id AND m.account_id = sessions.account_id)`)
      this.db.exec(`DELETE FROM session_entries WHERE NOT EXISTS (
        SELECT 1 FROM sessions s WHERE s.account_id = session_entries.account_id AND s.id = session_entries.session_id)`)
    })()
    const sessions = new Map<string, ArchivedSession>()
    for (const row of this.db.query<SessionRow, []>('SELECT * FROM sessions').iterate()) {
      sessions.set(key(row.account_id, row.id), {
        accountId: row.account_id,
        id: row.id,
        machineId: row.machine_id,
        status: row.status,
        info: row.info,
        meta: row.meta,
        statusDetail: row.status_detail,
        startedAt: row.started_at,
        lastActivity: row.last_activity,
        history: [],
      })
    }
    const entries = this.db.query<EntryRow, []>('SELECT account_id, session_id, id, ts, blob FROM session_entries ORDER BY seq')
    for (const row of entries.iterate()) {
      sessions.get(key(row.account_id, row.session_id))?.history.push({ id: row.id, ts: row.ts, blob: row.blob })
    }
    return [...sessions.values()]
  }

  saveSession(accountId: string, session: SessionSummary) {
    if (!this.closed) this.dirty.set(key(accountId, session.id), { accountId, session })
  }

  addEntries(accountId: string, sessionId: string, entries: SealedEntry[]) {
    this.later(() => {
      const insert = this.db.query('INSERT INTO session_entries (account_id, session_id, id, ts, blob) VALUES (?, ?, ?, ?, ?)')
      for (const entry of entries) insert.run(accountId, sessionId, entry.id, entry.ts, entry.blob)
    })
  }

  dropEntries(accountId: string, sessionId: string, ids: string[]) {
    this.later(() => {
      const remove = this.db.query('DELETE FROM session_entries WHERE account_id = ? AND session_id = ? AND id = ?')
      for (const id of ids) remove.run(accountId, sessionId, id)
    })
  }

  clearEntries(accountId: string, sessionId: string) {
    this.later(() => this.db.query('DELETE FROM session_entries WHERE account_id = ? AND session_id = ?').run(accountId, sessionId))
  }

  removeSession(accountId: string, sessionId: string) {
    this.dirty.delete(key(accountId, sessionId))
    this.later(() => {
      this.db.query('DELETE FROM sessions WHERE account_id = ? AND id = ?').run(accountId, sessionId)
      this.db.query('DELETE FROM session_entries WHERE account_id = ? AND session_id = ?').run(accountId, sessionId)
    })
  }

  removeAccount(accountId: string) {
    for (const [id, { accountId: owner }] of this.dirty) if (owner === accountId) this.dirty.delete(id)
    this.later(() => {
      this.db.query('DELETE FROM sessions WHERE account_id = ?').run(accountId)
      this.db.query('DELETE FROM session_entries WHERE account_id = ?').run(accountId)
    })
  }

  /** Writes what changed since the last flush, in one transaction. */
  flush() {
    if (this.closed || (!this.pending.length && !this.dirty.size)) return
    const pending = this.pending
    const dirty = [...this.dirty.values()]
    this.pending = []
    this.dirty.clear()
    const upsert = this.db.query(
      `INSERT INTO sessions (account_id, id, machine_id, status, info, meta, status_detail, started_at, last_activity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, id) DO UPDATE SET machine_id = excluded.machine_id, status = excluded.status,
         info = excluded.info, meta = excluded.meta, status_detail = excluded.status_detail,
         started_at = excluded.started_at, last_activity = excluded.last_activity`,
    )
    try {
      this.db.transaction(() => {
        for (const write of pending) write()
        for (const { accountId, session: s } of dirty) {
          upsert.run(accountId, s.id, s.machineId, s.status, s.info, s.meta, s.statusDetail, s.startedAt, s.lastActivity)
        }
      })()
    } catch (error) {
      // The sessions stay in memory and the relay keeps serving them; only what a restart would bring back is lost.
      console.error(`relay: could not save sessions: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Flushes, then ignores every later change: the database closes right after. */
  close() {
    clearInterval(this.timer)
    this.flush()
    this.closed = true
  }

  private later(write: () => void) {
    if (!this.closed) this.pending.push(write)
  }
}

const key = (accountId: string, sessionId: string) => `${accountId}/${sessionId}`
