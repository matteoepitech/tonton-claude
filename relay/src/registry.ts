import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ENROLLMENT_TTL_MS, MAX_MACHINES_PER_ACCOUNT } from './limits'
import { issueToken, newEnrollmentCode, parseToken, safeEqual, sha256 } from './tokens'

export interface Machine {
  id: string
  accountId: string
  /** Sealed `{ name }`, readable only by the account owner. */
  nameBlob: string
  createdAt: string
  lastSeen: string | null
}

export type ClaimResult = { ok: true; machine: Machine; token: string } | { ok: false; reason: 'invalid-code' | 'machine-limit' }

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
]

interface MachineRow {
  id: string
  account_id: string
  name_blob: string
  created_at: string
  last_seen: string | null
}

const toMachine = (row: MachineRow): Machine => ({
  id: row.id,
  accountId: row.account_id,
  nameBlob: row.name_blob,
  createdAt: row.created_at,
  lastSeen: row.last_seen,
})

/** Accounts, machines and enrollment codes. Only hashes of secrets are stored. */
export class Registry {
  private readonly db: Database

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

  createEnrollment(accountId: string): { code: string; expiresAt: string } {
    this.db.query('DELETE FROM enrollments WHERE expires_at < ?').run(Date.now())
    const code = newEnrollmentCode()
    const expiresAt = Date.now() + ENROLLMENT_TTL_MS
    this.db.query('INSERT INTO enrollments (code_hash, account_id, expires_at) VALUES (?, ?, ?)').run(sha256(code), accountId, expiresAt)
    return { code, expiresAt: new Date(expiresAt).toISOString() }
  }

  /** Consumes a single-use enrollment code and registers the machine. */
  claimEnrollment(code: string, nameBlob: string): ClaimResult {
    return this.db.transaction((): ClaimResult => {
      const enrollment = this.db
        .query('DELETE FROM enrollments WHERE code_hash = ? RETURNING account_id, expires_at')
        .get(sha256(code.trim().toUpperCase())) as { account_id: string; expires_at: number } | null
      if (!enrollment || enrollment.expires_at < Date.now()) return { ok: false, reason: 'invalid-code' }

      const { count } = this.db.query('SELECT COUNT(*) AS count FROM machines WHERE account_id = ?').get(enrollment.account_id) as {
        count: number
      }
      if (count >= MAX_MACHINES_PER_ACCOUNT) return { ok: false, reason: 'machine-limit' }

      const { id, token, secretHash } = issueToken('tm')
      const createdAt = now()
      this.db
        .query('INSERT INTO machines (id, account_id, secret_hash, name_blob, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, enrollment.account_id, secretHash, nameBlob, createdAt)
      return { ok: true, token, machine: { id, accountId: enrollment.account_id, nameBlob, createdAt, lastSeen: null } }
    })()
  }

  machines(accountId: string): Machine[] {
    const rows = this.db
      .query('SELECT id, account_id, name_blob, created_at, last_seen FROM machines WHERE account_id = ? ORDER BY created_at')
      .all(accountId) as MachineRow[]
    return rows.map(toMachine)
  }

  touchMachine(machineId: string) {
    this.db.query('UPDATE machines SET last_seen = ? WHERE id = ?').run(now(), machineId)
  }

  revokeMachine(accountId: string, machineId: string): boolean {
    return this.db.query('DELETE FROM machines WHERE id = ? AND account_id = ?').run(machineId, accountId).changes > 0
  }

  close() {
    this.db.close()
  }
}

const now = () => new Date().toISOString()
