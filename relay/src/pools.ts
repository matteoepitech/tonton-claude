// Pools in SQLite (docs/pools.md): who is in which pool with which role, invites, the sessions put in a pool, and the
// pool's tasks, notes, messages and events. Ids, roles, revisions and times are in clear; every blob is sealed with the
// pool key, which the relay never has, except each member's copy of that key, sealed with the member's account key.

import type { Database } from 'bun:sqlite'
import type {
  PoolKeyWrapWire,
  PoolMemberWire,
  PoolNotesWire,
  PoolPostWire,
  PoolRole,
  PoolSessionRef,
  PoolSessionWire,
  PoolSnapshot,
  PoolSummary,
  PoolTaskWire,
} from '../../shared/pool-protocol'
import {
  MAX_POOL_EVENTS,
  MAX_POOL_INVITES,
  MAX_POOL_KEY_VERSIONS,
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

/** A member's keys for a pool, as it publishes them on creating or joining it. */
export interface MemberKeys {
  publicKey: string
  secret: string
}

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

/** Why a rotation was refused, for the route to say. */
export type RotateResult =
  | { ok: true; kicked: PoolSessionOrderRow[] | null; remaining: string[] }
  | { ok: false; reason: 'version' | 'wraps' | 'target' | 'limit' }

/** The member's own keys for the pool, sent to that member only. */
export interface OwnKeys {
  secret: string | null
  wraps: PoolKeyWrapWire[]
}

export type Put<T> = { ok: true; value: T } | { ok: false; reason: 'conflict'; current: T | null } | { ok: false; reason: 'limit' }

interface MemberRow {
  account_id: string
  role: string
  joined_at: string
  profile_blob: string | null
}

const MEMBER_COLUMNS = 'account_id, role, joined_at, profile_blob'

/** The version of the pool key a blob says sealed it: the number before `:`, or 1 (shared/pool-keys.ts). */
export const blobVersion = (blob: string): number => {
  const match = /^(\d{1,6}):/.exec(blob)
  return match ? Number(match[1]) : 1
}

interface PoolRow {
  id: string
  owner_account: string
  created_at: string
  paused: number
  key_version: number
  info_blob: string
  orchestrator_account: string | null
  orchestrator_session: string | null
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

const toMember = (row: MemberRow, publicKeys: string[]): PoolMemberWire => ({
  account: row.account_id,
  role: toRole(row.role),
  joinedAt: row.joined_at,
  profile: row.profile_blob,
  publicKeys,
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
  create(accountId: string, id: string, info: string, keyGrant: string, profile: string | null, keys: MemberKeys): PoolSummary | null {
    return this.db.transaction(() => {
      if (this.poolCount(accountId) >= MAX_POOLS_PER_ACCOUNT) return null
      if (this.db.query('SELECT 1 FROM pools WHERE id = ?').get(id)) return null
      const createdAt = now()
      this.db.query('INSERT INTO pools (id, owner_account, created_at, info_blob) VALUES (?, ?, ?, ?)').run(id, accountId, createdAt, info)
      this.db
        .query(
          'INSERT INTO pool_members (pool_id, account_id, role, joined_at, profile_blob, key_blob, secret_blob) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, accountId, 'owner', createdAt, profile, keyGrant, keys.secret)
      this.addMemberKey(id, accountId, keys.publicKey)
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
    const own = this.own(poolId, accountId)
    return {
      id: row.id,
      role: toRole(row.role),
      createdAt: row.created_at,
      paused: row.paused === 1,
      keyVersion: row.key_version,
      info: row.info_blob,
      key: row.key_blob,
      members: row.members,
      secret: own.secret,
      wraps: own.wraps,
    }
  }

  /** The member's private key for the pool and the pool keys wrapped for it, oldest first. */
  own(poolId: string, accountId: string): OwnKeys {
    const member = this.db.query('SELECT secret_blob FROM pool_members WHERE pool_id = ? AND account_id = ?').get(poolId, accountId) as {
      secret_blob: string | null
    } | null
    const wraps = this.db
      .query('SELECT version, from_account, blob FROM pool_key_wraps WHERE pool_id = ? AND account_id = ? ORDER BY version')
      .all(poolId, accountId) as { version: number; from_account: string; blob: string }[]
    return { secret: member?.secret_blob ?? null, wraps: wraps.map(w => ({ version: w.version, from: w.from_account, blob: w.blob })) }
  }

  /**
   * Publishes the member's public key sealed with one version of the pool key, kept next to the versions before it: a
   * member who only holds an older version still reads it. The private key, when given, replaces the one kept.
   */
  setMemberKeys(poolId: string, accountId: string, publicKey: string, secret: string | null) {
    this.db.transaction(() => {
      if (!this.role(poolId, accountId)) return
      this.addMemberKey(poolId, accountId, publicKey)
      if (secret !== null) {
        this.db.query('UPDATE pool_members SET secret_blob = ? WHERE pool_id = ? AND account_id = ?').run(secret, poolId, accountId)
      }
    })()
  }

  private addMemberKey(poolId: string, accountId: string, blob: string) {
    const version = blobVersion(blob)
    if (version > MAX_POOL_KEY_VERSIONS) return
    this.db
      .query(
        `INSERT INTO pool_member_keys (pool_id, account_id, version, blob) VALUES (?, ?, ?, ?)
         ON CONFLICT (pool_id, account_id, version) DO UPDATE SET blob = excluded.blob`,
      )
      .run(poolId, accountId, version, blob)
  }

  /** A member's public key, sealed with each version it was published under, oldest first. */
  private memberKeys(poolId: string, accountId: string): string[] {
    const rows = this.db
      .query('SELECT blob FROM pool_member_keys WHERE pool_id = ? AND account_id = ? ORDER BY version')
      .all(poolId, accountId) as { blob: string }[]
    return rows.map(row => row.blob)
  }

  private toMember(poolId: string, row: MemberRow): PoolMemberWire {
    return toMember(row, this.memberKeys(poolId, row.account_id))
  }

  /** Changes a member's role. Never makes or unmakes the owner: that is `transferOwner`. */
  setRole(poolId: string, accountId: string, role: Exclude<PoolRole, 'owner'>): boolean {
    return (
      this.db
        .query("UPDATE pool_members SET role = ? WHERE pool_id = ? AND account_id = ? AND role != 'owner'")
        .run(role, poolId, accountId).changes > 0
    )
  }

  /** Hands the pool to another member, who becomes its owner; the previous owner stays as an admin. */
  transferOwner(poolId: string, from: string, to: string): boolean {
    return this.db.transaction(() => {
      if (this.role(poolId, from) !== 'owner' || !this.role(poolId, to) || from === to) return false
      this.db.query("UPDATE pool_members SET role = 'admin' WHERE pool_id = ? AND account_id = ?").run(poolId, from)
      this.db.query("UPDATE pool_members SET role = 'owner' WHERE pool_id = ? AND account_id = ?").run(poolId, to)
      this.db.query('UPDATE pools SET owner_account = ? WHERE id = ?').run(to, poolId)
      return true
    })()
  }

  /**
   * Version `version` of the pool key, wrapped by `actor` for the members left, after taking `kick` out when given. The
   * relay cannot check what a wrap holds: it checks the version follows the current one, and that the wraps go to
   * members left, one each, the actor among them. A member left without one, whose public key the actor could not
   * read, needs a new invite. Every open invite is revoked: they hold the previous key.
   */
  rotate(poolId: string, actor: string, version: number, wraps: { account: string; blob: string }[], kick: string | null): RotateResult {
    return this.db.transaction((): RotateResult => {
      const state = this.state(poolId)
      if (!state || version !== state.keyVersion + 1) return { ok: false, reason: 'version' }
      if (version > MAX_POOL_KEY_VERSIONS) return { ok: false, reason: 'limit' }
      if (kick !== null && (!this.role(poolId, kick) || this.role(poolId, kick) === 'owner' || kick === actor)) {
        return { ok: false, reason: 'target' }
      }
      const remaining = this.memberAccounts(poolId).filter(account => account !== kick)
      const left = new Set(remaining)
      const given = new Set(wraps.map(wrap => wrap.account))
      const valid = given.size === wraps.length && [...given].every(account => left.has(account)) && given.has(actor)
      if (!valid) return { ok: false, reason: 'wraps' }

      const kicked = kick === null ? null : this.sessionOrders(poolId).filter(session => session.accountId === kick)
      if (kick !== null) {
        this.db.query('DELETE FROM pool_sessions WHERE pool_id = ? AND account_id = ?').run(poolId, kick)
        this.db.query('DELETE FROM pool_members WHERE pool_id = ? AND account_id = ?').run(poolId, kick)
      }
      const insert = this.db.query('INSERT INTO pool_key_wraps (pool_id, account_id, version, from_account, blob) VALUES (?, ?, ?, ?, ?)')
      for (const wrap of wraps) insert.run(poolId, wrap.account, version, actor, wrap.blob)
      this.db.query('UPDATE pools SET key_version = ? WHERE id = ?').run(version, poolId)
      this.db.query('DELETE FROM pool_invites WHERE pool_id = ?').run(poolId)
      return { ok: true, kicked, remaining }
    })()
  }

  /** One member's wrap of one version, to send it on. */
  wrap(poolId: string, accountId: string, version: number): PoolKeyWrapWire | null {
    const row = this.db
      .query('SELECT version, from_account, blob FROM pool_key_wraps WHERE pool_id = ? AND account_id = ? AND version = ?')
      .get(poolId, accountId, version) as { version: number; from_account: string; blob: string } | null
    return row ? { version: row.version, from: row.from_account, blob: row.blob } : null
  }

  members(poolId: string): PoolMemberWire[] {
    const rows = this.db.query(`SELECT ${MEMBER_COLUMNS} FROM pool_members WHERE pool_id = ? ORDER BY joined_at`).all(poolId) as MemberRow[]
    return rows.map(row => this.toMember(poolId, row))
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
      .query(`SELECT ${MEMBER_COLUMNS} FROM pool_members WHERE pool_id = ? AND account_id = ?`)
      .get(poolId, accountId) as MemberRow | null
    return row ? this.toMember(poolId, row) : null
  }

  setInfo(poolId: string, info: string) {
    this.db.query('UPDATE pools SET info_blob = ? WHERE id = ?').run(info, poolId)
  }

  setProfile(poolId: string, accountId: string, profile: string) {
    this.db.query('UPDATE pool_members SET profile_blob = ? WHERE pool_id = ? AND account_id = ?').run(profile, poolId, accountId)
  }

  /**
   * Makes one of the pool's sessions the orchestrator, or none. False when that session is not in the pool: only a
   * pool session can plan for it.
   */
  setOrchestrator(poolId: string, orchestrator: PoolSessionRef | null): boolean {
    if (orchestrator && !this.isPoolSession(poolId, orchestrator.account, orchestrator.session)) return false
    this.db
      .query('UPDATE pools SET orchestrator_account = ?, orchestrator_session = ? WHERE id = ?')
      .run(orchestrator?.account ?? null, orchestrator?.session ?? null, poolId)
    return true
  }

  /** The orchestrator, while its session is still in the pool: one that left or was kicked plans no more. */
  orchestrator(poolId: string): PoolSessionRef | null {
    const row = this.db.query('SELECT orchestrator_account, orchestrator_session FROM pools WHERE id = ?').get(poolId) as Pick<
      PoolRow,
      'orchestrator_account' | 'orchestrator_session'
    > | null
    if (!row?.orchestrator_account || !row.orchestrator_session) return null
    const lead = { account: row.orchestrator_account, session: row.orchestrator_session }
    return this.isPoolSession(poolId, lead.account, lead.session) ? lead : null
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
    keys: MemberKeys,
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
        .query(
          'INSERT INTO pool_members (pool_id, account_id, role, joined_at, profile_blob, key_blob, secret_blob) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(invite.pool_id, accountId, role, now(), profile, keyGrant, keys.secret)
      this.addMemberKey(invite.pool_id, accountId, keys.publicKey)
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
  ): Omit<PoolSessionWire, 'online' | 'ready' | 'status'> | null {
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

  sessions(poolId: string): Omit<PoolSessionWire, 'online' | 'ready' | 'status'>[] {
    // With the revision of the rules its owner accepted for it (relay/src/pool-safety.ts).
    const rows = this.db
      .query(
        `SELECT s.account_id, s.session_id, s.joined_at, s.profile_blob, a.rev AS accepted FROM pool_sessions s
         LEFT JOIN pool_acceptances a ON a.pool_id = s.pool_id AND a.account_id = s.account_id AND a.session_id = s.session_id
         WHERE s.pool_id = ? ORDER BY s.joined_at`,
      )
      .all(poolId) as { account_id: string; session_id: string; joined_at: string; profile_blob: string | null; accepted: number | null }[]
    return rows.map(row => ({
      account: row.account_id,
      session: row.session_id,
      joinedAt: row.joined_at,
      profile: row.profile_blob,
      accepted: row.accepted ?? 0,
    }))
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

  /** Everything a member sees on subscribing. `live` tells whether a session's agent is connected and ready, and its status. */
  snapshot(
    poolId: string,
    live: (accountId: string, sessionId: string) => Pick<PoolSessionWire, 'online' | 'ready' | 'status'>,
    forAccount: string | null = null,
  ): PoolSnapshot | null {
    const pool = this.db.query('SELECT * FROM pools WHERE id = ?').get(poolId) as PoolRow | null
    if (!pool) return null
    return {
      id: pool.id,
      createdAt: pool.created_at,
      paused: pool.paused === 1,
      keyVersion: pool.key_version,
      info: pool.info_blob,
      members: this.members(poolId),
      sessions: this.sessions(poolId).map(session => ({ ...session, ...live(session.account, session.session) })),
      tasks: this.tasks(poolId),
      notes: this.notes(poolId),
      messages: this.posts('message', poolId, POOL_SNAPSHOT_MESSAGES),
      events: this.posts('event', poolId, POOL_SNAPSHOT_EVENTS),
      ...(forAccount ? { own: this.own(poolId, forAccount) } : {}),
      orchestrator: this.orchestrator(poolId),
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
