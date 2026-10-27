// Pools in SQLite (docs/pools.md): who is in which pool with which role, invites, the sessions put in a pool, and the
// pool's tasks, notes, messages and events. Ids, roles, revisions and times are in clear; every blob is sealed with the
// pool key, which the relay never has, except each member's copy of that key, sealed with the member's account key.

import type { Database } from 'bun:sqlite'
import type {
  PoolMemberWire,
  PoolNotesWire,
  PoolPostWire,
  PoolRole,
  PoolSessionWire,
  PoolSnapshot,
  PoolSummary,
  PoolTaskWire,
} from '../../shared/pool-protocol'
import {
  MAX_POOL_EVENTS,
  MAX_POOL_INVITES,
  MAX_POOL_MEMBERS,
  MAX_POOL_MESSAGES,
  MAX_POOL_SESSIONS,
  MAX_POOL_TASKS,
  MAX_POOLS_PER_ACCOUNT,
  POOL_SNAPSHOT_EVENTS,
  POOL_SNAPSHOT_MESSAGES,
} from './limits'
import { issueToken, parseToken, safeEqual } from './tokens'

export type PostKind = 'message' | 'event'

export interface PoolInviteRow {
  id: string
  role: PoolRole
  usesLeft: number
  createdAt: string
  expiresAt: string
}

/** A session put in a pool, with the sealed order its agent needs, to send again whenever the agent connects. */
export interface PoolSessionOrderRow {
  poolId: string
  accountId: string
  sessionId: string
  order: string
}

/** Who wrote: the account, and the pool session it spoke from (null for an app or the website). */
export interface Author {
  accountId: string
  sessionId: string | null
}

export type Put<T> = { ok: true; value: T } | { ok: false; reason: 'conflict'; current: T | null } | { ok: false; reason: 'limit' }

interface MemberRow {
  account_id: string
  role: string
  joined_at: string
  profile_blob: string | null
}

interface PoolRow {
  id: string
  owner_account: string
  created_at: string
  paused: number
  key_version: number
  info_blob: string
}

interface ItemRow {
  id: string
  rev: number
  updated_at: string
  account_id: string
  session_id: string | null
  blob: string
}

interface PostRow {
  seq: number
  id: string
  ts: string
  account_id: string
  session_id: string | null
  blob: string
}

const now = () => new Date().toISOString()
const toRole = (role: string): PoolRole => (role === 'owner' || role === 'admin' || role === 'viewer' ? role : 'member')

const toMember = (row: MemberRow): PoolMemberWire => ({
  account: row.account_id,
  role: toRole(row.role),
  joinedAt: row.joined_at,
  profile: row.profile_blob,
})

const toTask = (row: ItemRow): PoolTaskWire => ({
  id: row.id,
  rev: row.rev,
  updatedAt: row.updated_at,
  account: row.account_id,
  session: row.session_id,
  blob: row.blob,
})

const toNotes = (row: Omit<ItemRow, 'id'>): PoolNotesWire => ({
  rev: row.rev,
  updatedAt: row.updated_at,
  account: row.account_id,
  session: row.session_id,
  blob: row.blob,
})

const toPost = (row: PostRow): PoolPostWire => ({
  id: row.id,
  seq: row.seq,
  ts: row.ts,
  account: row.account_id,
  session: row.session_id,
  blob: row.blob,
})

export class PoolStore {
  constructor(private readonly db: Database) {}

  // MARK: Pools and members

  /** A new pool with its creator as owner. Null when the id is taken or the account is in too many pools. */
  create(accountId: string, id: string, info: string, keyGrant: string, profile: string | null): PoolSummary | null {
    return this.db.transaction(() => {
      if (this.poolCount(accountId) >= MAX_POOLS_PER_ACCOUNT) return null
      if (this.db.query('SELECT 1 FROM pools WHERE id = ?').get(id)) return null
      const createdAt = now()
      this.db.query('INSERT INTO pools (id, owner_account, created_at, info_blob) VALUES (?, ?, ?, ?)').run(id, accountId, createdAt, info)
      this.db
        .query('INSERT INTO pool_members (pool_id, account_id, role, joined_at, profile_blob, key_blob) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, accountId, 'owner', createdAt, profile, keyGrant)
      return this.summary(id, accountId)
    })()
  }

  /** The pools the account is in, with its role and its copy of each key. */
  summaries(accountId: string): PoolSummary[] {
    const ids = this.db.query('SELECT pool_id FROM pool_members WHERE account_id = ? ORDER BY joined_at').all(accountId) as {
      pool_id: string
    }[]
    return ids.flatMap(({ pool_id }) => this.summary(pool_id, accountId) ?? [])
  }

  summary(poolId: string, accountId: string): PoolSummary | null {
    const row = this.db
      .query(
        `SELECT p.*, m.role, m.key_blob, (SELECT COUNT(*) FROM pool_members WHERE pool_id = p.id) AS members
         FROM pools p JOIN pool_members m ON m.pool_id = p.id WHERE p.id = ? AND m.account_id = ?`,
      )
      .get(poolId, accountId) as (PoolRow & { role: string; key_blob: string; members: number }) | null
    if (!row) return null
    return {
      id: row.id,
      role: toRole(row.role),
      createdAt: row.created_at,
      paused: row.paused === 1,
      keyVersion: row.key_version,
      info: row.info_blob,
      key: row.key_blob,
      members: row.members,
    }
  }

  role(poolId: string, accountId: string): PoolRole | null {
    const row = this.db.query('SELECT role FROM pool_members WHERE pool_id = ? AND account_id = ?').get(poolId, accountId) as {
      role: string
    } | null
    return row ? toRole(row.role) : null
  }

  memberAccounts(poolId: string): string[] {
    return (this.db.query('SELECT account_id FROM pool_members WHERE pool_id = ?').all(poolId) as { account_id: string }[]).map(
      row => row.account_id,
    )
  }

  member(poolId: string, accountId: string): PoolMemberWire | null {
    const row = this.db
      .query('SELECT account_id, role, joined_at, profile_blob FROM pool_members WHERE pool_id = ? AND account_id = ?')
      .get(poolId, accountId) as MemberRow | null
    return row ? toMember(row) : null
  }

  setInfo(poolId: string, info: string) {
    this.db.query('UPDATE pools SET info_blob = ? WHERE id = ?').run(info, poolId)
  }

  setProfile(poolId: string, accountId: string, profile: string) {
    this.db.query('UPDATE pool_members SET profile_blob = ? WHERE pool_id = ? AND account_id = ?').run(profile, poolId, accountId)
  }

  /** The pool's clear fields, as `pool_info` sends them. */
  state(poolId: string): { info: string; paused: boolean; keyVersion: number } | null {
    const row = this.db.query('SELECT info_blob, paused, key_version FROM pools WHERE id = ?').get(poolId) as Pick<
      PoolRow,
      'info_blob' | 'paused' | 'key_version'
    > | null
    return row ? { info: row.info_blob, paused: row.paused === 1, keyVersion: row.key_version } : null
  }

  /** Deletes the pool with all it holds, and returns the sessions that were in it. */
  remove(poolId: string): PoolSessionOrderRow[] {
    return this.db.transaction(() => {
      const sessions = this.sessionOrders(poolId)
      this.db.query('DELETE FROM pool_sessions WHERE pool_id = ?').run(poolId)
      this.db.query('DELETE FROM pools WHERE id = ?').run(poolId)
      return sessions
    })()
  }

  /** A member leaves, with its sessions, which are returned. The owner cannot leave: it deletes the pool instead. */
  leave(poolId: string, accountId: string): PoolSessionOrderRow[] | null {
    return this.db.transaction(() => {
      const role = this.role(poolId, accountId)
      if (!role || role === 'owner') return null
      const sessions = this.sessionOrders(poolId).filter(session => session.accountId === accountId)
      this.db.query('DELETE FROM pool_sessions WHERE pool_id = ? AND account_id = ?').run(poolId, accountId)
      this.db.query('DELETE FROM pool_members WHERE pool_id = ? AND account_id = ?').run(poolId, accountId)
      return sessions
    })()
  }

  /** The pools an account owns, and those it is only a member of. */
  poolsOf(accountId: string): { owned: string[]; joined: string[] } {
    const rows = this.db.query('SELECT pool_id, role FROM pool_members WHERE account_id = ?').all(accountId) as {
      pool_id: string
      role: string
    }[]
    return {
      owned: rows.filter(row => row.role === 'owner').map(row => row.pool_id),
      joined: rows.filter(row => row.role !== 'owner').map(row => row.pool_id),
    }
  }

  private poolCount(accountId: string): number {
    return (this.db.query('SELECT COUNT(*) AS count FROM pool_members WHERE account_id = ?').get(accountId) as { count: number }).count
  }

  // MARK: Invites

  /** Null when the pool has as many open invites as it may. */
  createInvite(poolId: string, role: PoolRole, uses: number, expiresAt: number): (PoolInviteRow & { token: string }) | null {
    return this.db.transaction(() => {
      this.db.query('DELETE FROM pool_invites WHERE pool_id = ? AND (expires_at <= ? OR uses_left <= 0)').run(poolId, Date.now())
      const { count } = this.db.query('SELECT COUNT(*) AS count FROM pool_invites WHERE pool_id = ?').get(poolId) as { count: number }
      if (count >= MAX_POOL_INVITES) return null
      const { id, token, secretHash } = issueToken('tp')
      const createdAt = now()
      this.db
        .query('INSERT INTO pool_invites (id, pool_id, secret_hash, role, uses_left, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, poolId, secretHash, role, uses, createdAt, expiresAt)
      return { id, token, role, usesLeft: uses, createdAt, expiresAt: new Date(expiresAt).toISOString() }
    })()
  }

  invites(poolId: string): PoolInviteRow[] {
    const rows = this.db
      .query('SELECT id, role, uses_left, created_at, expires_at FROM pool_invites WHERE pool_id = ? AND expires_at > ? AND uses_left > 0')
      .all(poolId, Date.now()) as { id: string; role: string; uses_left: number; created_at: string; expires_at: number }[]
    return rows.map(row => ({
      id: row.id,
      role: toRole(row.role),
      usesLeft: row.uses_left,
      createdAt: row.created_at,
      expiresAt: new Date(row.expires_at).toISOString(),
    }))
  }

  revokeInvite(poolId: string, inviteId: string): boolean {
    return this.db.query('DELETE FROM pool_invites WHERE id = ? AND pool_id = ?').run(inviteId, poolId).changes > 0
  }

  /**
   * Joins the pool the invite is for. An account already in it gets its pool back without spending a use. Errors:
   * `invalid` (no such invite, used up or expired), `full` (the pool or the account has no room).
   */
  join(
    token: string,
    accountId: string,
    keyGrant: string,
    profile: string | null,
  ): { ok: true; poolId: string; fresh: boolean } | { ok: false; reason: 'invalid' | 'full' } {
    return this.db.transaction((): ReturnType<PoolStore['join']> => {
      const parsed = parseToken(token, 'tp')
      if (!parsed) return { ok: false, reason: 'invalid' }
      const invite = this.db
        .query('SELECT pool_id, secret_hash, role, uses_left, expires_at FROM pool_invites WHERE id = ?')
        .get(parsed.id) as { pool_id: string; secret_hash: Uint8Array; role: string; uses_left: number; expires_at: number } | null
      if (!invite || !safeEqual(invite.secret_hash, parsed.secretHash)) return { ok: false, reason: 'invalid' }
      // Opening the same invite again, from another device of a member, spends nothing.
      if (this.role(invite.pool_id, accountId)) return { ok: true, poolId: invite.pool_id, fresh: false }
      if (invite.uses_left <= 0 || invite.expires_at <= Date.now()) return { ok: false, reason: 'invalid' }
      if (this.memberAccounts(invite.pool_id).length >= MAX_POOL_MEMBERS || this.poolCount(accountId) >= MAX_POOLS_PER_ACCOUNT) {
        return { ok: false, reason: 'full' }
      }
      this.db.query('UPDATE pool_invites SET uses_left = uses_left - 1 WHERE id = ?').run(parsed.id)
      // An invite never makes an owner.
      const role = invite.role === 'admin' || invite.role === 'viewer' ? invite.role : 'member'
      this.db
        .query('INSERT INTO pool_members (pool_id, account_id, role, joined_at, profile_blob, key_blob) VALUES (?, ?, ?, ?, ?, ?)')
        .run(invite.pool_id, accountId, role, now(), profile, keyGrant)
      return { ok: true, poolId: invite.pool_id, fresh: true }
    })()
  }

  // MARK: Sessions

  /** Puts a session of a member in the pool, or updates its order. Null when the pool has no room. */
  addSession(
    poolId: string,
    accountId: string,
    sessionId: string,
    order: string,
    profile: string,
  ): Omit<PoolSessionWire, 'online' | 'ready'> | null {
    return this.db.transaction(() => {
      const known = this.db
        .query('SELECT joined_at FROM pool_sessions WHERE pool_id = ? AND account_id = ? AND session_id = ?')
        .get(poolId, accountId, sessionId) as { joined_at: string } | null
      if (known) {
        this.db
          .query('UPDATE pool_sessions SET order_blob = ?, profile_blob = ? WHERE pool_id = ? AND account_id = ? AND session_id = ?')
          .run(order, profile, poolId, accountId, sessionId)
        return { account: accountId, session: sessionId, joinedAt: known.joined_at, profile }
      }
      const { count } = this.db.query('SELECT COUNT(*) AS count FROM pool_sessions WHERE pool_id = ?').get(poolId) as { count: number }
      if (count >= MAX_POOL_SESSIONS) return null
      const joinedAt = now()
      this.db
        .query('INSERT INTO pool_sessions (pool_id, account_id, session_id, joined_at, profile_blob, order_blob) VALUES (?, ?, ?, ?, ?, ?)')
        .run(poolId, accountId, sessionId, joinedAt, profile, order)
      return { account: accountId, session: sessionId, joinedAt, profile }
    })()
  }

  removeSession(poolId: string, accountId: string, sessionId: string): boolean {
    return (
      this.db.query('DELETE FROM pool_sessions WHERE pool_id = ? AND account_id = ? AND session_id = ?').run(poolId, accountId, sessionId)
        .changes > 0
    )
  }

  isPoolSession(poolId: string, accountId: string, sessionId: string): boolean {
    return Boolean(
      this.db
        .query('SELECT 1 FROM pool_sessions WHERE pool_id = ? AND account_id = ? AND session_id = ?')
        .get(poolId, accountId, sessionId),
    )
  }

  /** The pools a session of the account is in, with the orders to hand its agent. */
  ordersFor(accountId: string, sessionId: string): PoolSessionOrderRow[] {
    const rows = this.db
      .query('SELECT pool_id, order_blob FROM pool_sessions WHERE account_id = ? AND session_id = ?')
      .all(accountId, sessionId) as { pool_id: string; order_blob: string }[]
    return rows.map(row => ({ poolId: row.pool_id, accountId, sessionId, order: row.order_blob }))
  }

  sessionOrders(poolId: string): PoolSessionOrderRow[] {
    const rows = this.db.query('SELECT account_id, session_id, order_blob FROM pool_sessions WHERE pool_id = ?').all(poolId) as {
      account_id: string
      session_id: string
      order_blob: string
    }[]
    return rows.map(row => ({ poolId, accountId: row.account_id, sessionId: row.session_id, order: row.order_blob }))
  }

  sessions(poolId: string): Omit<PoolSessionWire, 'online' | 'ready'>[] {
    const rows = this.db
      .query('SELECT account_id, session_id, joined_at, profile_blob FROM pool_sessions WHERE pool_id = ? ORDER BY joined_at')
      .all(poolId) as { account_id: string; session_id: string; joined_at: string; profile_blob: string | null }[]
    return rows.map(row => ({ account: row.account_id, session: row.session_id, joinedAt: row.joined_at, profile: row.profile_blob }))
  }

  // MARK: Tasks and notes

  /** Writes a task over revision `rev` (0 for a new one). Refused when someone changed it since. */
  putTask(poolId: string, id: string, rev: number, blob: string, author: Author): Put<PoolTaskWire> {
    return this.db.transaction((): Put<PoolTaskWire> => {
      const current = this.db
        .query('SELECT id, rev, updated_at, account_id, session_id, blob FROM pool_tasks WHERE pool_id = ? AND id = ?')
        .get(poolId, id) as ItemRow | null
      if ((current?.rev ?? 0) !== rev) return { ok: false, reason: 'conflict', current: current ? toTask(current) : null }
      if (!current) {
        const { count } = this.db.query('SELECT COUNT(*) AS count FROM pool_tasks WHERE pool_id = ?').get(poolId) as { count: number }
        if (count >= MAX_POOL_TASKS) return { ok: false, reason: 'limit' }
      }
      const row: ItemRow = { id, rev: rev + 1, updated_at: now(), account_id: author.accountId, session_id: author.sessionId, blob }
      this.db
        .query(
          `INSERT INTO pool_tasks (pool_id, id, rev, updated_at, account_id, session_id, blob) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (pool_id, id) DO UPDATE SET rev = excluded.rev, updated_at = excluded.updated_at,
             account_id = excluded.account_id, session_id = excluded.session_id, blob = excluded.blob`,
        )
        .run(poolId, id, row.rev, row.updated_at, row.account_id, row.session_id, row.blob)
      return { ok: true, value: toTask(row) }
    })()
  }

  tasks(poolId: string): PoolTaskWire[] {
    const rows = this.db
      .query('SELECT id, rev, updated_at, account_id, session_id, blob FROM pool_tasks WHERE pool_id = ? ORDER BY rowid')
      .all(poolId) as ItemRow[]
    return rows.map(toTask)
  }

  putNotes(poolId: string, rev: number, blob: string, author: Author): Put<PoolNotesWire> {
    return this.db.transaction((): Put<PoolNotesWire> => {
      const current = this.notesRow(poolId)
      if ((current?.rev ?? 0) !== rev) return { ok: false, reason: 'conflict', current: current ? toNotes(current) : null }
      const row = { rev: rev + 1, updated_at: now(), account_id: author.accountId, session_id: author.sessionId, blob }
      this.db
        .query(
          `INSERT INTO pool_notes (pool_id, rev, updated_at, account_id, session_id, blob) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (pool_id) DO UPDATE SET rev = excluded.rev, updated_at = excluded.updated_at,
             account_id = excluded.account_id, session_id = excluded.session_id, blob = excluded.blob`,
        )
        .run(poolId, row.rev, row.updated_at, row.account_id, row.session_id, row.blob)
      return { ok: true, value: toNotes(row) }
    })()
  }

  notes(poolId: string): PoolNotesWire | null {
    const row = this.notesRow(poolId)
    return row ? toNotes(row) : null
  }

  private notesRow(poolId: string): Omit<ItemRow, 'id'> | null {
    return this.db.query('SELECT rev, updated_at, account_id, session_id, blob FROM pool_notes WHERE pool_id = ?').get(poolId) as Omit<
      ItemRow,
      'id'
    > | null
  }

  // MARK: Messages and events

  /** Appends a message or an event, dropping the oldest past the cap. Null when an item with that id is there already. */
  addPost(kind: PostKind, poolId: string, id: string, blob: string, author: Author): PoolPostWire | null {
    return this.db.transaction(() => {
      if (this.db.query('SELECT 1 FROM pool_posts WHERE pool_id = ? AND kind = ? AND id = ?').get(poolId, kind, id)) return null
      const ts = now()
      const { lastInsertRowid } = this.db
        .query('INSERT INTO pool_posts (pool_id, kind, id, ts, account_id, session_id, blob) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(poolId, kind, id, ts, author.accountId, author.sessionId, blob)
      const cap = kind === 'message' ? MAX_POOL_MESSAGES : MAX_POOL_EVENTS
      this.db
        .query(
          `DELETE FROM pool_posts WHERE pool_id = ? AND kind = ? AND seq <= (
             SELECT seq FROM pool_posts WHERE pool_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
        )
        .run(poolId, kind, poolId, kind, cap)
      return { id, seq: Number(lastInsertRowid), ts, account: author.accountId, session: author.sessionId, blob }
    })()
  }

  /** The latest `limit` posts of a kind, oldest first. */
  posts(kind: PostKind, poolId: string, limit: number): PoolPostWire[] {
    const rows = this.db
      .query('SELECT seq, id, ts, account_id, session_id, blob FROM pool_posts WHERE pool_id = ? AND kind = ? ORDER BY seq DESC LIMIT ?')
      .all(poolId, kind, limit) as PostRow[]
    return rows.reverse().map(toPost)
  }

  // MARK: Snapshot

  /** Everything a member sees on subscribing. `live` tells whether a session's agent is connected and ready. */
  snapshot(poolId: string, live: (accountId: string, sessionId: string) => { online: boolean; ready: boolean }): PoolSnapshot | null {
    const pool = this.db.query('SELECT * FROM pools WHERE id = ?').get(poolId) as PoolRow | null
    if (!pool) return null
    const members = this.db
      .query('SELECT account_id, role, joined_at, profile_blob FROM pool_members WHERE pool_id = ? ORDER BY joined_at')
      .all(poolId) as MemberRow[]
    return {
      id: pool.id,
      createdAt: pool.created_at,
      paused: pool.paused === 1,
      keyVersion: pool.key_version,
      info: pool.info_blob,
      members: members.map(toMember),
      sessions: this.sessions(poolId).map(session => ({ ...session, ...live(session.account, session.session) })),
      tasks: this.tasks(poolId),
      notes: this.notes(poolId),
      messages: this.posts('message', poolId, POOL_SNAPSHOT_MESSAGES),
      events: this.posts('event', poolId, POOL_SNAPSHOT_EVENTS),
    }
  }

  /** Totals over the whole relay, for the metrics page. */
  counts(): { pools: number; poolMembers: number } {
    return this.db.query('SELECT (SELECT COUNT(*) FROM pools) AS pools, (SELECT COUNT(*) FROM pool_members) AS poolMembers').get() as {
      pools: number
      poolMembers: number
    }
  }
}
