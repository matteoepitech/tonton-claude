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
/** Read-only shares an account can hold at once, how many people may watch one, and how long one may last. */
export const MAX_SHARES_PER_ACCOUNT = 10
export const MAX_VIEWERS_PER_SHARE = 20
export const MAX_SHARE_HOURS = 30 * 24
/** The sealed copy of a shared conversation, kept in memory only: the agent sends it again when it reconnects. */
export const MAX_SHARE_BYTES = 4 * 1024 * 1024
/** A session's sealed name: a few words, its session id and a date. */
export const MAX_SESSION_NAME_BYTES = 2048
/** A sealed request for a machine's agent log: two ids and a date. */
export const MAX_LOG_REQUEST_BYTES = 4096
/** The end of an agent log, sealed. The agent keeps it under this. */
export const MAX_AGENT_LOG_BYTES = 256 * 1024
/** A sealed request to check a machine's setup, with the repair it may ask for. */
export const MAX_DIAGNOSE_REQUEST_BYTES = 4096
/** A sealed diagnosis: a few lines of checks. */
export const MAX_DIAGNOSIS_BYTES = 64 * 1024
/** Pools (docs/pools.md): what one account and one pool may hold. Messages and events go oldest first. */
export const MAX_POOLS_PER_ACCOUNT = 10
export const MAX_POOL_MEMBERS = 50
export const MAX_POOL_SESSIONS = 100
export const MAX_POOL_TASKS = 500
export const MAX_POOL_MESSAGES = 2000
export const MAX_POOL_EVENTS = 5000
export const MAX_POOL_INVITES = 20
export const MAX_POOL_INVITE_USES = 100
export const MAX_POOL_INVITE_HOURS = 30 * 24
/** Sealed pool name and goal, a member's or a session's profile, a key grant, a session order. */
export const MAX_POOL_INFO_BYTES = 8192
/** How many times a pool's key can be rotated: each one keeps a wrapped key per member. */
export const MAX_POOL_KEY_VERSIONS = 200
/** A member's public key or private key for a pool, sealed, or one wrap of the pool key. */
export const MAX_POOL_KEY_BYTES = 2048
export const MAX_POOL_NOTES_BYTES = 256 * 1024
/** One sealed task, message or event. */
export const MAX_POOL_TASK_BYTES = 64 * 1024
export const MAX_POOL_POST_BYTES = 16 * 1024
/** What a snapshot carries of the messages and events, the latest ones. */
export const POOL_SNAPSHOT_MESSAGES = 200
export const POOL_SNAPSHOT_EVENTS = 500
/** Posts (tasks, notes, messages, events) one member may send to one pool per minute. */
export const MAX_POOL_POSTS_PER_MINUTE = 240
/** The sealed rules the owner and admins propose, the sealed budgets, and one machine owner's acceptance of the rules. */
export const MAX_POOL_RULES_BYTES = 64 * 1024
export const MAX_POOL_BUDGETS_BYTES = 16 * 1024
/** Lines of a pool's audit log kept, oldest first to go, and how many a snapshot carries. */
export const MAX_POOL_AUDIT = 5000
export const POOL_SNAPSHOT_AUDIT = 300
/** Whole machines a pool may hold (docs/pool-autopilot.md). Their profile and order are under MAX_POOL_INFO_BYTES. */
export const MAX_POOL_MACHINES = 50
/** The sealed dispatch setting: on or off, and a few words. */
export const MAX_POOL_DISPATCH_BYTES = 4096
export const MAX_WS_MESSAGE_BYTES = 32 * 1024 * 1024

/** iPhones and iPads that get pushes, per account. The least recently registered goes first. */
export const MAX_PUSH_DEVICES_PER_ACCOUNT = 10
/** What Apple accepts in an alert or a Live Activity push. */
export const MAX_PUSH_PAYLOAD_BYTES = 4096
/** Sessions shown on the Live Activity, and the longest sealed blobs it carries for each. */
export const ISLAND_SESSIONS = 3
export const MAX_ISLAND_INFO_BYTES = 1024
export const MAX_ISLAND_DETAIL_BYTES = 512
/** Changes are gathered this long before the Live Activity is pushed. */
export const ISLAND_DEBOUNCE_MS = 1500
/** Between two pushes to one Live Activity, unless a session starts needing the user. */
export const ISLAND_MIN_INTERVAL_MS = 10_000
/** A Live Activity is ended once nothing has run for this long. */
export const ISLAND_QUIET_MS = 15 * 60_000
/** No Live Activity is started by push this soon after the phone's app closed its socket: it may have one on the way. */
export const ISLAND_START_GRACE_MS = 60_000
/** A Live Activity the relay started but the phone never reported is not started again before this. */
export const ISLAND_RESTART_MS = 8 * 60 * 60_000
/** Permission alerts already sent, kept to not send one twice when an agent reconnects. */
export const MAX_ALERTED_REQUESTS = 200
/** A permission alert that could not be delivered within this is dropped by Apple. */
export const PERMISSION_ALERT_TTL_S = 600

/**
 * What goes first to an app that subscribes with `latestFirst`: the latest entries within these, so the end of the
 * conversation shows before a long history and its images have arrived.
 */
export const RECENT_HISTORY_ENTRIES = 60
export const RECENT_HISTORY_BYTES = 256 * 1024

export const FINISHED_SESSION_TTL_MS = 6 * 60 * 60_000

export const RATE_LIMITS = {
  signups: { limit: 5, windowMs: 60 * 60_000 },
  claims: { limit: 20, windowMs: 10 * 60_000 },
  failedAuth: { limit: 30, windowMs: 10 * 60_000 },
}
