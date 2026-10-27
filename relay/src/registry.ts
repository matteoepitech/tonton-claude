import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PushDevice } from '../../shared/protocol'
import { MAX_MACHINES_PER_ACCOUNT, MAX_PUSH_DEVICES_PER_ACCOUNT, MAX_SHARES_PER_ACCOUNT } from './limits'
import { issueToken, newJoinSecret, parseToken, safeEqual, sha256 } from './tokens'

export interface Machine {
  id: string
  accountId: string
  /** Sealed `{ name }`, readable only by the account owner. */
  nameBlob: string
  createdAt: string
  lastSeen: string | null
}

export interface Share {
  id: string
  accountId: string
  sessionId: string
  /** Sealed `ShareOrder`, null until the app sent it. */
  order: string | null
  createdAt: string
  /** Unix milliseconds. */
  expiresAt: number
}

export type JoinResult = { ok: true; machine: Machine; token: string } | { ok: false; reason: 'invalid-token' | 'machine-limit' }

// The first schema predates versioning, hence IF NOT EXISTS: it must apply cleanly to existing databases.
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS accounts (
     id TEXT PRIMARY KEY,
     secret_hash BLOB NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS machines (
     id TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     secret_hash BLOB NOT NULL,
     name_blob TEXT NOT NULL,
     created_at TEXT NOT NULL,
     last_seen TEXT
   );
   CREATE INDEX IF NOT EXISTS machines_account ON machines(account_id);
   CREATE TABLE IF NOT EXISTS enrollments (
     code_hash BLOB PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL
   );`,
  // Machines join with the account token instead of single-use codes.
  `ALTER TABLE accounts ADD COLUMN join_hash BLOB;
   DROP TABLE enrollments;`,
  // Sessions and their sealed history, kept across restarts (relay/src/archive.ts). Ids, states, times and sealed blobs
  // only: what the relay already holds in memory.
  `CREATE TABLE sessions (
     account_id TEXT NOT NULL,
     id TEXT NOT NULL,
     machine_id TEXT NOT NULL,
     status TEXT NOT NULL,
     info TEXT,
     meta TEXT,
     status_detail TEXT,
     started_at TEXT NOT NULL,
     last_activity TEXT NOT NULL,
     PRIMARY KEY (account_id, id)
   );
   CREATE TABLE session_entries (
     seq INTEGER PRIMARY KEY,
     account_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     id TEXT NOT NULL,
     ts TEXT NOT NULL,
     blob TEXT NOT NULL
   );
   CREATE INDEX session_entries_session ON session_entries(account_id, session_id, id);`,
  // Read-only shares of one session (relay/src/shares.ts). The order is sealed by the app for the session's agent.
  `CREATE TABLE shares (
     id TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     session_id TEXT NOT NULL,
     secret_hash BLOB NOT NULL,
     order_blob TEXT,
     created_at TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX shares_session ON shares(account_id, session_id);`,
  // iPhones that get pushes: kept across restarts, since a phone only registers again when its app opens.
  `CREATE TABLE push_devices (
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     id TEXT NOT NULL,
     environment TEXT NOT NULL,
     alert_token TEXT,
     activity_token TEXT,
     start_token TEXT,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (account_id, id)
   );`,
  // The name a Mac gave a session, sealed like the rest.
  `ALTER TABLE sessions ADD COLUMN name TEXT;`,
  // Pools (relay/src/pools.ts, docs/pools.md): ids, roles, revisions and times in clear, everything else sealed with the
  // pool key, except each member's copy of that key, sealed with its own account key.
  `CREATE TABLE pools (
     id TEXT PRIMARY KEY,
     owner_account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL,
     paused INTEGER NOT NULL DEFAULT 0,
     key_version INTEGER NOT NULL DEFAULT 1,
     info_blob TEXT NOT NULL
   );
   CREATE TABLE pool_members (
     pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     joined_at TEXT NOT NULL,
     profile_blob TEXT,
     key_blob TEXT NOT NULL,
     PRIMARY KEY (pool_id, account_id)
   );
   CREATE INDEX pool_members_account ON pool_members(account_id);
   CREATE TABLE pool_invites (
     id TEXT PRIMARY KEY,
     pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
     secret_hash BLOB NOT NULL,
     role TEXT NOT NULL,
     uses_left INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX pool_invites_pool ON pool_invites(pool_id);
   CREATE TABLE pool_sessions (
     pool_id TEXT NOT NULL,
     account_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     joined_at TEXT NOT NULL,
     profile_blob TEXT,
     order_blob TEXT NOT NULL,
     PRIMARY KEY (pool_id, account_id, session_id),
     FOREIGN KEY (pool_id, account_id) REFERENCES pool_members(pool_id, account_id) ON DELETE CASCADE
   );
   CREATE INDEX pool_sessions_session ON pool_sessions(account_id, session_id);
   CREATE TABLE pool_tasks (
     pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
     id TEXT NOT NULL,
     rev INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     account_id TEXT NOT NULL,
     session_id TEXT,
     blob TEXT NOT NULL,
     PRIMARY KEY (pool_id, id)
   );
   CREATE TABLE pool_notes (
     pool_id TEXT PRIMARY KEY REFERENCES pools(id) ON DELETE CASCADE,
     rev INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     account_id TEXT NOT NULL,
     session_id TEXT,
     blob TEXT NOT NULL
   );
   CREATE TABLE pool_posts (
     seq INTEGER PRIMARY KEY,
     pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     id TEXT NOT NULL,
     ts TEXT NOT NULL,
     account_id TEXT NOT NULL,
     session_id TEXT,
     blob TEXT NOT NULL
   );
   CREATE INDEX pool_posts_pool ON pool_posts(pool_id, kind, seq);`,
  // Each member's key pair for its pools (docs/pools.md, Keys): its private key sealed with its account key, its public
  // key sealed with each version of the pool key it saw, and the later versions of the pool key admins wrapped for it.
  `ALTER TABLE pool_members ADD COLUMN secret_blob TEXT;
   CREATE TABLE pool_member_keys (
     pool_id TEXT NOT NULL,
     account_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     blob TEXT NOT NULL,
     PRIMARY KEY (pool_id, account_id, version),
     FOREIGN KEY (pool_id, account_id) REFERENCES pool_members(pool_id, account_id) ON DELETE CASCADE
   );
   CREATE TABLE pool_key_wraps (
     pool_id TEXT NOT NULL,
     account_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     from_account TEXT NOT NULL,
     blob TEXT NOT NULL,
     PRIMARY KEY (pool_id, account_id, version),
     FOREIGN KEY (pool_id, account_id) REFERENCES pool_members(pool_id, account_id) ON DELETE CASCADE
   );`,
]

/** One install of the iPhone app, with its APNs tokens (see `PushDevice` in shared/protocol.ts). */
export interface StoredPushDevice extends PushDevice {
  accountId: string
}

export type PushTokenKind = 'alert' | 'activity' | 'activityStart'

interface PushDeviceRow {
  account_id: string
  id: string
  environment: string
  alert_token: string | null
  activity_token: string | null
  start_token: string | null
}

const PUSH_COLUMNS: Record<PushTokenKind, string> = { alert: 'alert_token', activity: 'activity_token', activityStart: 'start_token' }

const toPushDevice = (row: PushDeviceRow): StoredPushDevice => ({
  accountId: row.account_id,
  device: row.id,
  environment: row.environment === 'production' ? 'production' : 'sandbox',
  alert: row.alert_token,
  activity: row.activity_token,
  activityStart: row.start_token,
})

interface MachineRow {
  id: string
  account_id: string
  name_blob: string
  created_at: string
  last_seen: string | null
}

interface ShareRow {
  id: string
  account_id: string
  session_id: string
  order_blob: string | null
  created_at: string
  expires_at: number
}

const SHARE_COLUMNS = 'id, account_id, session_id, order_blob, created_at, expires_at'

const toShare = (row: ShareRow): Share => ({
  id: row.id,
  accountId: row.account_id,
  sessionId: row.session_id,
  order: row.order_blob,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
})

const toMachine = (row: MachineRow): Machine => ({
  id: row.id,
  accountId: row.account_id,
  nameBlob: row.name_blob,
  createdAt: row.created_at,
  lastSeen: row.last_seen,
})

/** Accounts, machines and enrollment codes. Only hashes of secrets are stored. */
export class Registry {
  /** Also holds the session archive's tables, so that they migrate with the rest. */
  readonly db: Database

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.db = new Database(join(dataDir, 'tonton.db'), { create: true, strict: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  private migrate() {
    const { user_version: version } = this.db.query('PRAGMA user_version').get() as { user_version: number }
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[i])
        this.db.exec(`PRAGMA user_version = ${i + 1}`)
      })()
    }
  }

  createAccount(): { id: string; token: string } {
    const { id, token, secretHash } = issueToken('ta')
    this.db.query('INSERT INTO accounts (id, secret_hash, created_at) VALUES (?, ?, ?)').run(id, secretHash, now())
    return { id, token }
  }

  deleteAccount(accountId: string) {
    this.db.query('DELETE FROM accounts WHERE id = ?').run(accountId)
  }

  /** Account id for a valid account token, null otherwise. */
  authenticateAccount(token: string): string | null {
    const parsed = parseToken(token, 'ta')
    if (!parsed) return null
    const row = this.db.query('SELECT secret_hash FROM accounts WHERE id = ?').get(parsed.id) as { secret_hash: Uint8Array } | null
    return row && safeEqual(row.secret_hash, parsed.secretHash) ? parsed.id : null
  }

  authenticateMachine(token: string): Machine | null {
    const parsed = parseToken(token, 'tm')
    if (!parsed) return null
    const row = this.db.query('SELECT * FROM machines WHERE id = ?').get(parsed.id) as (MachineRow & { secret_hash: Uint8Array }) | null
    return row && safeEqual(row.secret_hash, parsed.secretHash) ? toMachine(row) : null
  }

  /**
   * The secret machines join the account with. A new one replaces the previous: every machine that joined with it is
   * signed out, and their ids are returned. Without `regenerate`, an account that already has one keeps it.
   */
  newJoinSecret(accountId: string, regenerate: boolean): { secret: string; revoked: string[] } | null {
    return this.db.transaction(() => {
      const row = this.db.query('SELECT join_hash FROM accounts WHERE id = ?').get(accountId) as { join_hash: Uint8Array | null } | null
      if (!row || (row.join_hash && !regenerate)) return null
      const revoked = row.join_hash
        ? (this.db.query('DELETE FROM machines WHERE account_id = ? RETURNING id').all(accountId) as { id: string }[]).map(m => m.id)
        : []
      const secret = newJoinSecret()
      this.db.query('UPDATE accounts SET join_hash = ? WHERE id = ?').run(sha256(secret), accountId)
      return { secret, revoked }
    })()
  }

  /** Registers a machine that holds the account token. */
  joinMachine(accountId: string, secret: string, nameBlob: string): JoinResult {
    return this.db.transaction((): JoinResult => {
      const row = this.db.query('SELECT join_hash FROM accounts WHERE id = ?').get(accountId) as { join_hash: Uint8Array | null } | null
      if (!row?.join_hash || !safeEqual(row.join_hash, sha256(secret))) return { ok: false, reason: 'invalid-token' }

      const { count } = this.db.query('SELECT COUNT(*) AS count FROM machines WHERE account_id = ?').get(accountId) as { count: number }
      if (count >= MAX_MACHINES_PER_ACCOUNT) return { ok: false, reason: 'machine-limit' }

      const { id, token, secretHash } = issueToken('tm')
      const createdAt = now()
      this.db
        .query('INSERT INTO machines (id, account_id, secret_hash, name_blob, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, accountId, secretHash, nameBlob, createdAt)
      return { ok: true, token, machine: { id, accountId, nameBlob, createdAt, lastSeen: null } }
    })()
  }

  machines(accountId: string): Machine[] {
    const rows = this.db
      .query('SELECT id, account_id, name_blob, created_at, last_seen FROM machines WHERE account_id = ? ORDER BY created_at')
      .all(accountId) as MachineRow[]
    return rows.map(toMachine)
  }

  counts(): { accounts: number; machines: number } {
    return this.db.query('SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM machines) AS machines').get() as {
      accounts: number
      machines: number
    }
  }

  touchMachine(machineId: string) {
    this.db.query('UPDATE machines SET last_seen = ? WHERE id = ?').run(now(), machineId)
  }

  revokeMachine(accountId: string, machineId: string): boolean {
    return this.db.query('DELETE FROM machines WHERE id = ? AND account_id = ?').run(machineId, accountId).changes > 0
  }

  /** A read-only share of one session until `expiresAt`, null when the account holds too many. */
  createShare(accountId: string, sessionId: string, expiresAt: number): { share: Share; token: string } | null {
    return this.db.transaction(() => {
      this.db.query('DELETE FROM shares WHERE account_id = ? AND expires_at <= ?').run(accountId, Date.now())
      const { count } = this.db.query('SELECT COUNT(*) AS count FROM shares WHERE account_id = ?').get(accountId) as { count: number }
      if (count >= MAX_SHARES_PER_ACCOUNT) return null
      const { id, token, secretHash } = issueToken('ts')
      const createdAt = now()
      this.db
        .query('INSERT INTO shares (id, account_id, session_id, secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, accountId, sessionId, secretHash, createdAt, expiresAt)
      return { token, share: { id, accountId, sessionId, order: null, createdAt, expiresAt } }
    })()
  }

  /** Keeps the app's sealed order for the share's agent. False when the share is not this account's, for this session. */
  setShareOrder(accountId: string, shareId: string, sessionId: string, order: string): boolean {
    return (
      this.db
        .query('UPDATE shares SET order_blob = ? WHERE id = ? AND account_id = ? AND session_id = ? AND expires_at > ?')
        .run(order, shareId, accountId, sessionId, Date.now()).changes > 0
    )
  }

  /** The account's shares still running, or those of one session. */
  shares(accountId: string, sessionId?: string): Share[] {
    const rows = sessionId
      ? this.db
          .query(`SELECT ${SHARE_COLUMNS} FROM shares WHERE account_id = ? AND session_id = ? AND expires_at > ? ORDER BY created_at`)
          .all(accountId, sessionId, Date.now())
      : this.db
          .query(`SELECT ${SHARE_COLUMNS} FROM shares WHERE account_id = ? AND expires_at > ? ORDER BY created_at`)
          .all(accountId, Date.now())
    return (rows as ShareRow[]).map(toShare)
  }

  share(accountId: string, shareId: string): Share | null {
    const row = this.db
      .query(`SELECT ${SHARE_COLUMNS} FROM shares WHERE id = ? AND account_id = ? AND expires_at > ?`)
      .get(shareId, accountId, Date.now()) as ShareRow | null
    return row ? toShare(row) : null
  }

  revokeShare(accountId: string, shareId: string): Share | null {
    const row = this.db
      .query(`DELETE FROM shares WHERE id = ? AND account_id = ? RETURNING ${SHARE_COLUMNS}`)
      .get(shareId, accountId) as ShareRow | null
    return row ? toShare(row) : null
  }

  /** The share a teammate's token opens, while it runs. */
  authenticateShare(token: string): Share | null {
    const parsed = parseToken(token, 'ts')
    if (!parsed) return null
    const row = this.db
      .query(`SELECT ${SHARE_COLUMNS}, secret_hash FROM shares WHERE id = ? AND expires_at > ?`)
      .get(parsed.id, Date.now()) as (ShareRow & { secret_hash: Uint8Array }) | null
    return row && safeEqual(row.secret_hash, parsed.secretHash) ? toShare(row) : null
  }

  /** Deletes the shares past their time and returns them. */
  expireShares(): Share[] {
    const rows = this.db.query(`DELETE FROM shares WHERE expires_at <= ? RETURNING ${SHARE_COLUMNS}`).all(Date.now()) as ShareRow[]
    return rows.map(toShare)
  }

  /**
   * Replaces what a phone registered. A token belongs to one account: a phone signed in to another one since gets
   * nothing more from the first. Past the cap, the device registered the longest ago goes.
   */
  savePushDevice(accountId: string, device: PushDevice) {
    this.db.transaction(() => {
      for (const kind of ['alert', 'activity', 'activityStart'] as const) {
        const token = device[kind]
        if (!token) continue
        this.db
          .query(`UPDATE push_devices SET ${PUSH_COLUMNS[kind]} = NULL WHERE ${PUSH_COLUMNS[kind]} = ? AND NOT (account_id = ? AND id = ?)`)
          .run(token, accountId, device.device)
      }
      this.db
        .query(
          `INSERT INTO push_devices (account_id, id, environment, alert_token, activity_token, start_token, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, id) DO UPDATE SET environment = excluded.environment, alert_token = excluded.alert_token,
             activity_token = excluded.activity_token, start_token = excluded.start_token, updated_at = excluded.updated_at`,
        )
        .run(accountId, device.device, device.environment, device.alert, device.activity, device.activityStart, now())
      this.db
        .query(
          `DELETE FROM push_devices WHERE account_id = ? AND id NOT IN
             (SELECT id FROM push_devices WHERE account_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?)`,
        )
        .run(accountId, accountId, MAX_PUSH_DEVICES_PER_ACCOUNT)
    })()
  }

  pushDevices(accountId: string): StoredPushDevice[] {
    const rows = this.db.query('SELECT * FROM push_devices WHERE account_id = ? ORDER BY id').all(accountId) as PushDeviceRow[]
    return rows.map(toPushDevice)
  }

  removePushDevice(accountId: string, deviceId: string) {
    this.db.query('DELETE FROM push_devices WHERE account_id = ? AND id = ?').run(accountId, deviceId)
  }

  /** Forgets a token Apple refused, or a Live Activity the relay ended. */
  clearPushToken(accountId: string, deviceId: string, kind: PushTokenKind, token: string) {
    this.db
      .query(`UPDATE push_devices SET ${PUSH_COLUMNS[kind]} = NULL WHERE account_id = ? AND id = ? AND ${PUSH_COLUMNS[kind]} = ?`)
      .run(accountId, deviceId, token)
  }

  close() {
    this.db.close()
  }
}

const now = () => new Date().toISOString()
