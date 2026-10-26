export const MAX_MACHINES_PER_ACCOUNT = 100
export const MAX_SESSIONS_PER_ACCOUNT = 100
export const MAX_ENTRIES_PER_SESSION = 800
export const MAX_SESSION_BYTES = 16 * 1024 * 1024
export const MAX_ACCOUNT_BYTES = 128 * 1024 * 1024
export const MAX_BLOB_BYTES = 8 * 1024 * 1024
/** A machine health report is a few numbers. */
export const MAX_HEALTH_BYTES = 4096
/** Health reports closer than this to the previous one are dropped. */
export const HEALTH_MIN_INTERVAL_MS = 10_000
export const MAX_PENDING_PERMISSIONS = 10
/** Sealed auto-approve rules of one machine. */
export const MAX_RULES_BYTES = 64 * 1024
/** A sealed order to start a session, or the user's answer to one of its questions: a folder path, a yes or no. */
export const MAX_START_ORDER_BYTES = 8192
/** A sealed question claude asks before a started session runs, with the screen it shows. */
export const MAX_START_DETAIL_BYTES = 16 * 1024
export const MAX_WS_MESSAGE_BYTES = 32 * 1024 * 1024

export const FINISHED_SESSION_TTL_MS = 6 * 60 * 60_000

export const RATE_LIMITS = {
  signups: { limit: 5, windowMs: 60 * 60_000 },
  claims: { limit: 20, windowMs: 10 * 60_000 },
  failedAuth: { limit: 30, windowMs: 10 * 60_000 },
}
