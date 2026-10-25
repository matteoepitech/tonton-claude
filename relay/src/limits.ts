export const MAX_MACHINES_PER_ACCOUNT = 100
export const MAX_SESSIONS_PER_ACCOUNT = 100
export const MAX_ENTRIES_PER_SESSION = 800
export const MAX_SESSION_BYTES = 16 * 1024 * 1024
export const MAX_ACCOUNT_BYTES = 128 * 1024 * 1024
export const MAX_BLOB_BYTES = 8 * 1024 * 1024
export const MAX_PENDING_PERMISSIONS = 10
export const MAX_WS_MESSAGE_BYTES = 32 * 1024 * 1024

export const ENROLLMENT_TTL_MS = 15 * 60_000
export const FINISHED_SESSION_TTL_MS = 6 * 60 * 60_000

export const RATE_LIMITS = {
  signups: { limit: 5, windowMs: 60 * 60_000 },
  claims: { limit: 20, windowMs: 10 * 60_000 },
  failedAuth: { limit: 30, windowMs: 10 * 60_000 },
}
