// Clusters in SQLite (docs/cluster.md): who is in which cluster, invites, the sessions put in a cluster, its posts and its
// shared documents. Ids, roles, revisions and times are in clear; every blob is sealed with the cluster key, which the
// relay never has, except each member's copy of that key and its private key, sealed with the member's account key, and
// the orders that put a session in, sealed the same way. No table here says what a session may do on another machine:
// there is nothing of the kind.

import type { Database } from 'bun:sqlite'
import type {
  ClusterDocWire,
  ClusterMemberWire,
  ClusterPostWire,
  ClusterRole,
  ClusterSessionWire,
  ClusterSnapshot,
  ClusterSummary,
} from '../../shared/cluster-protocol'
import type { PoolKeyWrapWire } from '../../shared/pool-keys'
import {
  CLUSTER_SNAPSHOT_POSTS,
  MAX_CLUSTER_DOCS,
  MAX_CLUSTER_FILES_BYTES,
  MAX_CLUSTER_INVITES,
  MAX_CLUSTER_MEMBERS,
  MAX_CLUSTER_POSTS,
  MAX_CLUSTER_SESSIONS,
  MAX_CLUSTERS_PER_ACCOUNT,
  MAX_POOL_KEY_VERSIONS,
} from './limits'
import { blobVersion } from './pools'
import { issueToken, parseToken, safeEqual } from './tokens'

/** Who wrote something: an account, the session it spoke for (null from an app), the machine of its agent. */
export interface ClusterAuthor {
  accountId: string
  sessionId: string | null
  machineId?: string | null
}

export interface ClusterMemberKeys {
  publicKey: string
  secret: string
}

export interface ClusterInviteRow {
  id: string
  usesLeft: number
  createdAt: string
  expiresAt: string
}

export interface ClusterSessionRow {
  clusterId: string
  accountId: string
  sessionId: string
  order: string
}

export type ClusterRotateResult =
  | { ok: true; kicked: ClusterSessionRow[] | null; remaining: string[] }
  | { ok: false; reason: 'version' | 'wraps' | 'target' | 'limit' }

export type ClusterPut =
  | { ok: true; value: ClusterDocWire }
  | { ok: false; reason: 'conflict'; current: ClusterDocWire | null }
  | { ok: false; reason: 'limit' }

interface ClusterRow {
  id: string
  owner_account: string
  created_at: string
  key_version: number
  info_blob: string
}

interface MemberRow {
  account_id: string
  role: string
  joined_at: string
  profile_blob: string | null
}

interface PostRow {
  seq: number
  id: string
  ts: string
  account_id: string
  session_id: string | null
  machine_id: string | null
  blob: string
}

interface DocRow {
  name: string
  rev: number
  updated_at: string
  account_id: string
  session_id: string | null
  machine_id: string | null
  blob: string
}

const now = () => new Date().toISOString()
const toRole = (role: string): ClusterRole => (role === 'owner' ? 'owner' : 'member')
const byMachine = (machineId: string | null | undefined): { machine?: string } => (machineId ? { machine: machineId } : {})

const toPost = (row: PostRow): ClusterPostWire => ({
  id: row.id,
  seq: row.seq,
  ts: row.ts,
  account: row.account_id,
  session: row.session_id,
  ...byMachine(row.machine_id),
  blob: row.blob,
})

const toDoc = (row: DocRow): ClusterDocWire => ({
  name: row.name,
  rev: row.rev,
  updatedAt: row.updated_at,
  account: row.account_id,
  session: row.session_id,
  ...byMachine(row.machine_id),
  blob: row.blob,
})

export class ClusterStore {
  constructor(private readonly db: Database) {}

  // MARK: Clusters and members

  /** A new cluster with its creator as owner. Null when the id is taken or the account is in too many clusters. */
  create(
    accountId: string,
    id: string,
    info: string,
    keyGrant: string,
    profile: string | null,
    keys: ClusterMemberKeys,
  ): ClusterSummary | null {
    return this.db.transaction(() => {
      if (this.clusterCount(accountId) >= MAX_CLUSTERS_PER_ACCOUNT) return null
      if (this.db.query('SELECT 1 FROM clusters WHERE id = ?').get(id)) return null
      const createdAt = now()
      this.db
        .query('INSERT INTO clusters (id, owner_account, created_at, info_blob) VALUES (?, ?, ?, ?)')
        .run(id, accountId, createdAt, info)
      this.db
        .query(
          'INSERT INTO cluster_members (cluster_id, account_id, role, joined_at, profile_blob, key_blob, secret_blob) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, accountId, 'owner', createdAt, profile, keyGrant, keys.secret)
      this.addMemberKey(id, accountId, keys.publicKey)
      return this.summary(id, accountId)
    })()
  }

  /** The clusters the account is in, with its role and its copy of each key. */
  summaries(accountId: string): ClusterSummary[] {
    const ids = this.db.query('SELECT cluster_id FROM cluster_members WHERE account_id = ? ORDER BY joined_at').all(accountId) as {
      cluster_id: string
    }[]
    return ids.flatMap(({ cluster_id }) => this.summary(cluster_id, accountId) ?? [])
  }

  summary(clusterId: string, accountId: string): ClusterSummary | null {
    const row = this.db
      .query(
        `SELECT c.*, m.role, m.key_blob, m.secret_blob, (SELECT COUNT(*) FROM cluster_members WHERE cluster_id = c.id) AS members
         FROM clusters c JOIN cluster_members m ON m.cluster_id = c.id WHERE c.id = ? AND m.account_id = ?`,
      )
      .get(clusterId, accountId) as (ClusterRow & { role: string; key_blob: string; secret_blob: string | null; members: number }) | null
    if (!row) return null
    return {
      id: row.id,
      role: toRole(row.role),
      createdAt: row.created_at,
      keyVersion: row.key_version,
      info: row.info_blob,
      key: row.key_blob,
      members: row.members,
      secret: row.secret_blob,
      wraps: this.wraps(clusterId, accountId),
    }
  }

  /** The member's private key for the cluster and the cluster keys wrapped for it, oldest first. */
  own(clusterId: string, accountId: string): { secret: string | null; wraps: PoolKeyWrapWire[] } {
    const member = this.db
      .query('SELECT secret_blob FROM cluster_members WHERE cluster_id = ? AND account_id = ?')
      .get(clusterId, accountId) as { secret_blob: string | null } | null
    return { secret: member?.secret_blob ?? null, wraps: this.wraps(clusterId, accountId) }
  }

  private wraps(clusterId: string, accountId: string): PoolKeyWrapWire[] {
    const rows = this.db
      .query('SELECT version, from_account, blob FROM cluster_key_wraps WHERE cluster_id = ? AND account_id = ? ORDER BY version')
      .all(clusterId, accountId) as { version: number; from_account: string; blob: string }[]
    return rows.map(row => ({ version: row.version, from: row.from_account, blob: row.blob }))
  }

  /** Publishes the member's public key sealed with one version of the cluster key; the private key, when given, replaces the one kept. */
  setMemberKeys(clusterId: string, accountId: string, publicKey: string, secret: string | null) {
    this.db.transaction(() => {
      if (!this.role(clusterId, accountId)) return
      this.addMemberKey(clusterId, accountId, publicKey)
      if (secret !== null) {
        this.db
          .query('UPDATE cluster_members SET secret_blob = ? WHERE cluster_id = ? AND account_id = ?')
          .run(secret, clusterId, accountId)
      }
    })()
  }

  private addMemberKey(clusterId: string, accountId: string, blob: string) {
    const version = blobVersion(blob)
    if (version > MAX_POOL_KEY_VERSIONS) return
    this.db
      .query(
        `INSERT INTO cluster_member_keys (cluster_id, account_id, version, blob) VALUES (?, ?, ?, ?)
         ON CONFLICT (cluster_id, account_id, version) DO UPDATE SET blob = excluded.blob`,
      )
      .run(clusterId, accountId, version, blob)
  }

  private memberKeys(clusterId: string, accountId: string): string[] {
    const rows = this.db
      .query('SELECT blob FROM cluster_member_keys WHERE cluster_id = ? AND account_id = ? ORDER BY version')
      .all(clusterId, accountId) as { blob: string }[]
    return rows.map(row => row.blob)
  }

  /** In the order they joined; two that joined within one millisecond, in the order they were written. */
  members(clusterId: string): ClusterMemberWire[] {
    const rows = this.db
      .query('SELECT account_id, role, joined_at, profile_blob FROM cluster_members WHERE cluster_id = ? ORDER BY joined_at, rowid')
      .all(clusterId) as MemberRow[]
    return rows.map(row => this.toMember(clusterId, row))
  }

  member(clusterId: string, accountId: string): ClusterMemberWire | null {
    const row = this.db
      .query('SELECT account_id, role, joined_at, profile_blob FROM cluster_members WHERE cluster_id = ? AND account_id = ?')
      .get(clusterId, accountId) as MemberRow | null
    return row ? this.toMember(clusterId, row) : null
  }

  private toMember(clusterId: string, row: MemberRow): ClusterMemberWire {
    return {
      account: row.account_id,
      role: toRole(row.role),
      joinedAt: row.joined_at,
      profile: row.profile_blob,
      publicKeys: this.memberKeys(clusterId, row.account_id),
    }
  }

  role(clusterId: string, accountId: string): ClusterRole | null {
    const row = this.db.query('SELECT role FROM cluster_members WHERE cluster_id = ? AND account_id = ?').get(clusterId, accountId) as {
      role: string
    } | null
    return row ? toRole(row.role) : null
  }

  memberAccounts(clusterId: string): string[] {
    const rows = this.db.query('SELECT account_id FROM cluster_members WHERE cluster_id = ? ORDER BY joined_at, rowid').all(clusterId) as {
      account_id: string
    }[]
    return rows.map(row => row.account_id)
  }

  setInfo(clusterId: string, info: string) {
    this.db.query('UPDATE clusters SET info_blob = ? WHERE id = ?').run(info, clusterId)
  }

  setProfile(clusterId: string, accountId: string, profile: string) {
    this.db.query('UPDATE cluster_members SET profile_blob = ? WHERE cluster_id = ? AND account_id = ?').run(profile, clusterId, accountId)
  }

  state(clusterId: string): { info: string; keyVersion: number } | null {
    const row = this.db.query('SELECT info_blob, key_version FROM clusters WHERE id = ?').get(clusterId) as {
      info_blob: string
      key_version: number
    } | null
    return row ? { info: row.info_blob, keyVersion: row.key_version } : null
  }

  /**
   * Version `version` of the cluster key, wrapped by the owner for the members left, after taking `kick` out when given.
   * The relay cannot check what a wrap holds: it checks the version follows the current one, and that the wraps go to
   * members left, one each, the owner among them. Every open invite is revoked: they hold the previous key.
   */
  rotate(
    clusterId: string,
    actor: string,
    version: number,
    wraps: { account: string; blob: string }[],
    kick: string | null,
  ): ClusterRotateResult {
    return this.db.transaction((): ClusterRotateResult => {
      const state = this.state(clusterId)
      if (!state || version !== state.keyVersion + 1) return { ok: false, reason: 'version' }
      if (version > MAX_POOL_KEY_VERSIONS) return { ok: false, reason: 'limit' }
      if (kick !== null && (!this.role(clusterId, kick) || this.role(clusterId, kick) === 'owner' || kick === actor)) {
        return { ok: false, reason: 'target' }
      }
      const remaining = this.memberAccounts(clusterId).filter(account => account !== kick)
      const left = new Set(remaining)
      const given = new Set(wraps.map(wrap => wrap.account))
      const valid = given.size === wraps.length && [...given].every(account => left.has(account)) && given.has(actor)
      if (!valid) return { ok: false, reason: 'wraps' }

      const kicked = kick === null ? null : this.sessionRows(clusterId).filter(session => session.accountId === kick)
      if (kick !== null) {
        this.db.query('DELETE FROM cluster_sessions WHERE cluster_id = ? AND account_id = ?').run(clusterId, kick)
        this.db.query('DELETE FROM cluster_members WHERE cluster_id = ? AND account_id = ?').run(clusterId, kick)
      }
      const insert = this.db.query(
        'INSERT INTO cluster_key_wraps (cluster_id, account_id, version, from_account, blob) VALUES (?, ?, ?, ?, ?)',
      )
      for (const wrap of wraps) insert.run(clusterId, wrap.account, version, actor, wrap.blob)
      this.db.query('UPDATE clusters SET key_version = ? WHERE id = ?').run(version, clusterId)
      this.db.query('DELETE FROM cluster_invites WHERE cluster_id = ?').run(clusterId)
      return { ok: true, kicked, remaining }
    })()
  }

  /** One member's wrap of one version, to send it on. */
  wrap(clusterId: string, accountId: string, version: number): PoolKeyWrapWire | null {
    return this.wraps(clusterId, accountId).find(wrap => wrap.version === version) ?? null
  }

  /** The owner deleted the cluster: its sessions are returned, for their agents to be told. */
  remove(clusterId: string): ClusterSessionRow[] {
    return this.db.transaction(() => {
      const sessions = this.sessionRows(clusterId)
      this.db.query('DELETE FROM cluster_sessions WHERE cluster_id = ?').run(clusterId)
      this.db.query('DELETE FROM clusters WHERE id = ?').run(clusterId)
      return sessions
    })()
  }

  /** A member leaves, with its sessions, which are returned. The owner cannot leave: it deletes the cluster instead. */
  leave(clusterId: string, accountId: string): ClusterSessionRow[] | null {
    return this.db.transaction(() => {
      const role = this.role(clusterId, accountId)
      if (!role || role === 'owner') return null
      const sessions = this.sessionRows(clusterId).filter(session => session.accountId === accountId)
      this.db.query('DELETE FROM cluster_sessions WHERE cluster_id = ? AND account_id = ?').run(clusterId, accountId)
      this.db.query('DELETE FROM cluster_members WHERE cluster_id = ? AND account_id = ?').run(clusterId, accountId)
      return sessions
    })()
  }

  /** The clusters an account owns, and those it is only a member of. */
  clustersOf(accountId: string): { owned: string[]; joined: string[] } {
    const rows = this.db.query('SELECT cluster_id, role FROM cluster_members WHERE account_id = ?').all(accountId) as {
      cluster_id: string
      role: string
    }[]
    return {
      owned: rows.filter(row => row.role === 'owner').map(row => row.cluster_id),
      joined: rows.filter(row => row.role !== 'owner').map(row => row.cluster_id),
    }
  }

  private clusterCount(accountId: string): number {
    return (this.db.query('SELECT COUNT(*) AS count FROM cluster_members WHERE account_id = ?').get(accountId) as { count: number }).count
  }

  // MARK: Invites

  /** Null when the cluster has as many open invites as it may. */
  createInvite(clusterId: string, uses: number, expiresAt: number): (ClusterInviteRow & { token: string }) | null {
    return this.db.transaction(() => {
      this.db.query('DELETE FROM cluster_invites WHERE cluster_id = ? AND (expires_at <= ? OR uses_left <= 0)').run(clusterId, Date.now())
      const { count } = this.db.query('SELECT COUNT(*) AS count FROM cluster_invites WHERE cluster_id = ?').get(clusterId) as {
        count: number
      }
      if (count >= MAX_CLUSTER_INVITES) return null
      const { id, token, secretHash } = issueToken('tc')
      const createdAt = now()
      this.db
        .query('INSERT INTO cluster_invites (id, cluster_id, secret_hash, uses_left, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, clusterId, secretHash, uses, createdAt, expiresAt)
      return { id, token, usesLeft: uses, createdAt, expiresAt: new Date(expiresAt).toISOString() }
    })()
  }

  invites(clusterId: string): ClusterInviteRow[] {
    const rows = this.db
      .query('SELECT id, uses_left, created_at, expires_at FROM cluster_invites WHERE cluster_id = ? AND expires_at > ? AND uses_left > 0')
      .all(clusterId, Date.now()) as { id: string; uses_left: number; created_at: string; expires_at: number }[]
    return rows.map(row => ({
      id: row.id,
      usesLeft: row.uses_left,
      createdAt: row.created_at,
      expiresAt: new Date(row.expires_at).toISOString(),
    }))
  }

  revokeInvite(clusterId: string, inviteId: string): boolean {
    return this.db.query('DELETE FROM cluster_invites WHERE id = ? AND cluster_id = ?').run(inviteId, clusterId).changes > 0
  }

  /**
   * Joins the cluster the invite is for, as a member. An account already in it gets its cluster back without spending a
   * use. Errors: `invalid` (no such invite, used up or expired), `full` (the cluster or the account has no room).
   */
  join(
    token: string,
    accountId: string,
    keyGrant: string,
    profile: string | null,
    keys: ClusterMemberKeys,
  ): { ok: true; clusterId: string; fresh: boolean } | { ok: false; reason: 'invalid' | 'full' } {
    return this.db.transaction((): ReturnType<ClusterStore['join']> => {
      const parsed = parseToken(token, 'tc')
      if (!parsed) return { ok: false, reason: 'invalid' }
      const invite = this.db
        .query('SELECT cluster_id, secret_hash, uses_left, expires_at FROM cluster_invites WHERE id = ?')
        .get(parsed.id) as { cluster_id: string; secret_hash: Uint8Array; uses_left: number; expires_at: number } | null
      if (!invite || !safeEqual(invite.secret_hash, parsed.secretHash)) return { ok: false, reason: 'invalid' }
      if (this.role(invite.cluster_id, accountId)) return { ok: true, clusterId: invite.cluster_id, fresh: false }
      if (invite.uses_left <= 0 || invite.expires_at <= Date.now()) return { ok: false, reason: 'invalid' }
      if (
        this.memberAccounts(invite.cluster_id).length >= MAX_CLUSTER_MEMBERS ||
        this.clusterCount(accountId) >= MAX_CLUSTERS_PER_ACCOUNT
      ) {
        return { ok: false, reason: 'full' }
      }
      this.db.query('UPDATE cluster_invites SET uses_left = uses_left - 1 WHERE id = ?').run(parsed.id)
      this.db
        .query(
          'INSERT INTO cluster_members (cluster_id, account_id, role, joined_at, profile_blob, key_blob, secret_blob) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(invite.cluster_id, accountId, 'member', now(), profile, keyGrant, keys.secret)
      this.addMemberKey(invite.cluster_id, accountId, keys.publicKey)
      return { ok: true, clusterId: invite.cluster_id, fresh: true }
    })()
  }

  // MARK: Sessions

  /** Puts a session of a member in the cluster, or replaces its order and profile. Null when the cluster has no room. */
  addSession(
    clusterId: string,
    accountId: string,
    sessionId: string,
    order: string,
    profile: string,
  ): Omit<ClusterSessionWire, 'online' | 'ready' | 'status' | 'machine'> | null {
    return this.db.transaction(() => {
      if (!this.role(clusterId, accountId)) return null
      const known = this.db
        .query('SELECT joined_at FROM cluster_sessions WHERE cluster_id = ? AND account_id = ? AND session_id = ?')
        .get(clusterId, accountId, sessionId) as { joined_at: string } | null
      if (known) {
        this.db
          .query('UPDATE cluster_sessions SET order_blob = ?, profile_blob = ? WHERE cluster_id = ? AND account_id = ? AND session_id = ?')
          .run(order, profile, clusterId, accountId, sessionId)
        return { account: accountId, session: sessionId, joinedAt: known.joined_at, profile }
      }
      const { count } = this.db.query('SELECT COUNT(*) AS count FROM cluster_sessions WHERE cluster_id = ?').get(clusterId) as {
        count: number
      }
      if (count >= MAX_CLUSTER_SESSIONS) return null
      const joinedAt = now()
      this.db
        .query(
          'INSERT INTO cluster_sessions (cluster_id, account_id, session_id, joined_at, profile_blob, order_blob) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(clusterId, accountId, sessionId, joinedAt, profile, order)
      return { account: accountId, session: sessionId, joinedAt, profile }
    })()
  }

  /** A new profile for a session already in, from its agent. False when it is not in. */
  setSessionProfile(clusterId: string, accountId: string, sessionId: string, profile: string): boolean {
    return (
      this.db
        .query('UPDATE cluster_sessions SET profile_blob = ? WHERE cluster_id = ? AND account_id = ? AND session_id = ?')
        .run(profile, clusterId, accountId, sessionId).changes > 0
    )
  }

  removeSession(clusterId: string, accountId: string, sessionId: string): boolean {
    return (
      this.db
        .query('DELETE FROM cluster_sessions WHERE cluster_id = ? AND account_id = ? AND session_id = ?')
        .run(clusterId, accountId, sessionId).changes > 0
    )
  }

  isClusterSession(clusterId: string, accountId: string, sessionId: string): boolean {
    return (
      this.db
        .query('SELECT 1 FROM cluster_sessions WHERE cluster_id = ? AND account_id = ? AND session_id = ?')
        .get(clusterId, accountId, sessionId) !== null
    )
  }

  /** The clusters a session of an account is in, with the order that put it there. */
  ordersFor(accountId: string, sessionId: string): ClusterSessionRow[] {
    const rows = this.db
      .query('SELECT cluster_id, order_blob FROM cluster_sessions WHERE account_id = ? AND session_id = ?')
      .all(accountId, sessionId) as { cluster_id: string; order_blob: string }[]
    return rows.map(row => ({ clusterId: row.cluster_id, accountId, sessionId, order: row.order_blob }))
  }

  sessionRows(clusterId: string): ClusterSessionRow[] {
    const rows = this.db
      .query('SELECT account_id, session_id, order_blob FROM cluster_sessions WHERE cluster_id = ? ORDER BY joined_at, rowid')
      .all(clusterId) as { account_id: string; session_id: string; order_blob: string }[]
    return rows.map(row => ({ clusterId, accountId: row.account_id, sessionId: row.session_id, order: row.order_blob }))
  }

  sessions(clusterId: string): Omit<ClusterSessionWire, 'online' | 'ready' | 'status' | 'machine'>[] {
    const rows = this.db
      .query('SELECT account_id, session_id, joined_at, profile_blob FROM cluster_sessions WHERE cluster_id = ? ORDER BY joined_at, rowid')
      .all(clusterId) as { account_id: string; session_id: string; joined_at: string; profile_blob: string | null }[]
    return rows.map(row => ({ account: row.account_id, session: row.session_id, joinedAt: row.joined_at, profile: row.profile_blob }))
  }

  // MARK: Posts and documents

  /** A post, kept with who wrote it; the oldest go past the cap. Null when its id was already used in this cluster. */
  addPost(clusterId: string, id: string, blob: string, author: ClusterAuthor): ClusterPostWire | null {
    return this.db.transaction(() => {
      if (this.db.query('SELECT 1 FROM cluster_posts WHERE cluster_id = ? AND id = ?').get(clusterId, id)) return null
      const ts = now()
      const machineId = author.machineId ?? null
      const { lastInsertRowid } = this.db
        .query('INSERT INTO cluster_posts (cluster_id, id, ts, account_id, session_id, machine_id, blob) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(clusterId, id, ts, author.accountId, author.sessionId, machineId, blob)
      this.db
        .query(
          `DELETE FROM cluster_posts WHERE cluster_id = ? AND seq <= (
             SELECT seq FROM cluster_posts WHERE cluster_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
        )
        .run(clusterId, clusterId, MAX_CLUSTER_POSTS)
      return { id, seq: Number(lastInsertRowid), ts, account: author.accountId, session: author.sessionId, ...byMachine(machineId), blob }
    })()
  }

  /** The latest `limit` posts, oldest first. */
  posts(clusterId: string, limit: number): ClusterPostWire[] {
    const rows = this.db
      .query(
        'SELECT seq, id, ts, account_id, session_id, machine_id, blob FROM cluster_posts WHERE cluster_id = ? ORDER BY seq DESC LIMIT ?',
      )
      .all(clusterId, limit) as PostRow[]
    return rows.reverse().map(toPost)
  }

  /** A document written over revision `rev` (0 for a new one): refused with the current one when `rev` is behind. */
  putDoc(clusterId: string, name: string, rev: number, blob: string, author: ClusterAuthor): ClusterPut {
    return this.db.transaction((): ClusterPut => {
      const current = this.db
        .query('SELECT name, rev, updated_at, account_id, session_id, machine_id, blob FROM cluster_docs WHERE cluster_id = ? AND name = ?')
        .get(clusterId, name) as DocRow | null
      if ((current?.rev ?? 0) !== rev) return { ok: false, reason: 'conflict', current: current ? toDoc(current) : null }
      if (!current) {
        const { count } = this.db.query('SELECT COUNT(*) AS count FROM cluster_docs WHERE cluster_id = ?').get(clusterId) as {
          count: number
        }
        if (count >= MAX_CLUSTER_DOCS) return { ok: false, reason: 'limit' }
      }
      const row: DocRow = {
        name,
        rev: rev + 1,
        updated_at: now(),
        account_id: author.accountId,
        session_id: author.sessionId,
        machine_id: author.machineId ?? null,
        blob,
      }
      this.db
        .query(
          `INSERT INTO cluster_docs (cluster_id, name, rev, updated_at, account_id, session_id, machine_id, blob) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (cluster_id, name) DO UPDATE SET rev = excluded.rev, updated_at = excluded.updated_at, account_id = excluded.account_id,
           session_id = excluded.session_id, machine_id = excluded.machine_id, blob = excluded.blob`,
        )
        .run(clusterId, name, row.rev, row.updated_at, row.account_id, row.session_id, row.machine_id, row.blob)
      return { ok: true, value: toDoc(row) }
    })()
  }

  docs(clusterId: string): ClusterDocWire[] {
    const rows = this.db
      .query('SELECT name, rev, updated_at, account_id, session_id, machine_id, blob FROM cluster_docs WHERE cluster_id = ? ORDER BY name')
      .all(clusterId) as DocRow[]
    return rows.map(toDoc)
  }

  // MARK: Files

  /** A sealed file, kept under its id; older files go until the cluster's total fits. False when the id is taken. */
  putFile(clusterId: string, id: string, accountId: string, blob: string): boolean {
    return this.db.transaction(() => {
      if (this.db.query('SELECT 1 FROM cluster_files WHERE cluster_id = ? AND id = ?').get(clusterId, id)) return false
      this.db
        .query('INSERT INTO cluster_files (cluster_id, id, account_id, size, created_at, blob) VALUES (?, ?, ?, ?, ?, ?)')
        .run(clusterId, id, accountId, blob.length, now(), blob)
      const rows = this.db
        .query('SELECT id, size FROM cluster_files WHERE cluster_id = ? ORDER BY created_at DESC, rowid DESC')
        .all(clusterId) as { id: string; size: number }[]
      let total = 0
      for (const row of rows) {
        total += row.size
        if (total > MAX_CLUSTER_FILES_BYTES)
          this.db.query('DELETE FROM cluster_files WHERE cluster_id = ? AND id = ?').run(clusterId, row.id)
      }
      return true
    })()
  }

  file(clusterId: string, id: string): string | null {
    const row = this.db.query('SELECT blob FROM cluster_files WHERE cluster_id = ? AND id = ?').get(clusterId, id) as {
      blob: string
    } | null
    return row?.blob ?? null
  }

  // MARK: Snapshot

  /** Everything a member sees on subscribing. `live` tells whether a session's agent is connected and ready, and its status. */
  snapshot(
    clusterId: string,
    live: (accountId: string, sessionId: string) => Pick<ClusterSessionWire, 'online' | 'ready' | 'status' | 'machine'>,
    forAccount: string | null = null,
  ): ClusterSnapshot | null {
    const cluster = this.db.query('SELECT * FROM clusters WHERE id = ?').get(clusterId) as ClusterRow | null
    if (!cluster) return null
    return {
      id: cluster.id,
      createdAt: cluster.created_at,
      keyVersion: cluster.key_version,
      info: cluster.info_blob,
      members: this.members(clusterId),
      sessions: this.sessions(clusterId).map(session => ({ ...session, ...live(session.account, session.session) })),
      posts: this.posts(clusterId, CLUSTER_SNAPSHOT_POSTS),
      docs: this.docs(clusterId),
      ...(forAccount ? { own: this.own(clusterId, forAccount) } : {}),
    }
  }

  /** Totals over the whole relay, for the metrics page. */
  counts(): { clusters: number; clusterMembers: number } {
    return this.db
      .query('SELECT (SELECT COUNT(*) FROM clusters) AS clusters, (SELECT COUNT(*) FROM cluster_members) AS clusterMembers')
      .get() as { clusters: number; clusterMembers: number }
  }
}
