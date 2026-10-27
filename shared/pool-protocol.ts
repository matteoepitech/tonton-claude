// Pools: several accounts whose Claude Code sessions build one project together (docs/pools.md). What the relay keeps
// in clear is ids, roles, revisions, sizes and times; everything that says what the pool does is sealed with the pool
// key, which the members share and the relay never gets. Mirrors app/Sources/TontonCore/Pool.swift.

import type { PoolKeyWrapWire } from './pool-keys'
import type { PermissionRule, Sealed } from './protocol'

export type { PoolKeyWrapWire } from './pool-keys'

export type PoolRole = 'owner' | 'admin' | 'member' | 'viewer'

/** Who did something in a pool: an account, and the pool session it spoke from, if any. */
export interface PoolAuthor {
  account: string
  /** Null when it came from an app or the website rather than a session. */
  session: string | null
}

// Plaintext payloads, sealed with the pool key.

export interface PoolInfo {
  name: string
  /** What the pool builds, for the orchestrator and every member. */
  goal?: string
}

/** How a member shows in the pool. */
export interface PoolMemberProfile {
  name: string
}

/** What a pool session is for, as its owner set it when it joined. */
export interface PoolSessionProfile {
  /** `front`, `back`, `infra`, `tests`, `docs`, `review`, or anything else. */
  area?: string
  /** What it knows, in a few words. */
  skills?: string
  /** The repository folder it works in. */
  repo?: string
  project?: string
  machine?: string
  tool?: 'claude' | 'opencode'
  /** The one session that plans and assigns. */
  orchestrator?: boolean
}

export type PoolTaskState = 'todo' | 'assigned' | 'in_progress' | 'review' | 'done' | 'blocked'

export interface PoolTask {
  title: string
  goal?: string
  /** What "done" means. */
  criteria?: string[]
  area?: string
  state: PoolTaskState
  assignee?: { account: string; session: string }
  /** Ids of the tasks it waits for. */
  dependsOn?: string[]
  branch?: string
  /** What was done, when it is done or blocked. */
  summary?: string
}

export interface PoolNotes {
  text: string
}

export interface PoolMessageBody {
  text: string
  /** Missing: everyone. Otherwise one session, or every session of an area. */
  to?: { session?: { account: string; session: string }; area?: string }
}

export interface PoolEventBody {
  /** `joined`, `task_moved`, `merged`, `blocked`… `session`: what a pool session runs on, posted by its agent. */
  kind: string
  text?: string
  taskId?: string
  /** `session` events: the coding tool and the model, so the orchestrator assigns by capability. */
  tool?: 'claude' | 'opencode'
  model?: string
  /** `spend` events: what the session spent since it joined the pool, as its agent counts it. */
  costUSD?: number
  seconds?: number
}

/**
 * Auto-approve rules the owner or an admin proposes for the pool's sessions. A proposal does nothing by itself: each
 * machine owner accepts it for a session, and only what they accepted reaches that session's agent (`PoolRulesAcceptance`).
 */
export interface PoolRules {
  rules: PermissionRule[]
  /** Why, in a few words. */
  note?: string
}

/** A spending cap: cost at list price, time Claude worked. Missing: no cap. */
export interface PoolBudget {
  costUSD?: number
  hours?: number
}

/** Set by the owner and admins. Each agent counts its own session and stops taking pool tasks past a cap. */
export interface PoolBudgets {
  /** The whole pool. */
  pool?: PoolBudget
  /** Each member, all its sessions together, unless `members` names it. */
  member?: PoolBudget
  /** One member, by account. */
  members?: Record<string, PoolBudget>
}

// Sealed with the account key: what a member keeps for itself.

/** A member's own copy of the pool key, kept on the relay so its other devices and its machines' agents get it. */
export interface PoolKeyGrant {
  poolId: string
  /** Base64url AES-256 key. */
  key: string
  version: number
}

/** From the member's app to one of its sessions' agents: work for this pool, with its key. */
export interface PoolSessionOrder {
  poolId: string
  sessionId: string
  key: string
  version: number
  issuedAt: string
  /**
   * The machine owner's choice: start a pool task as soon as it is assigned, or tell the user first and wait for them.
   * Missing: ask first.
   */
  autoStart?: boolean
}

/**
 * From a machine owner's app to its session's agent: apply these pool rules, exactly these, in this session. The rules
 * are copied in, so the relay can neither swap the proposal nor hand the acceptance to another session.
 */
export interface PoolRulesAcceptance {
  poolId: string
  sessionId: string
  /** The revision of the proposal that was accepted. */
  rev: number
  rules: PermissionRule[]
  issuedAt: string
}

// What the relay sends: clear fields and sealed blobs.

export interface PoolSummary {
  id: string
  /** The role of the account asking. */
  role: PoolRole
  createdAt: string
  paused: boolean
  keyVersion: number
  /** `PoolInfo`, sealed with the pool key. */
  info: Sealed
  /** `PoolKeyGrant`, sealed with the account key: the version of the key this member joined with. */
  key: Sealed
  members: number
  /** `PoolMemberSecret`, sealed with the account key: the member's private key for the pool. Null for older members. */
  secret: Sealed | null
  /** The later versions of the pool key, wrapped for this member by the admins who rotated it. */
  wraps: PoolKeyWrapWire[]
}

export interface PoolMemberWire {
  account: string
  role: PoolRole
  joinedAt: string
  /** `PoolMemberProfile`, sealed with the pool key. */
  profile: Sealed | null
  /**
   * `PoolMemberKey`, sealed with each version of the pool key it was published under, oldest first: what an admin wraps
   * a new pool key for. Every one holds the same public key; a reader opens whichever its keys allow.
   */
  publicKeys: Sealed[]
}

export interface PoolSessionWire {
  account: string
  session: string
  joinedAt: string
  /** `PoolSessionProfile`, sealed with the pool key. */
  profile: Sealed | null
  /** Its agent is connected. */
  online: boolean
  /** Its agent took the order and holds the pool key. */
  ready: boolean
  /** The revision of the pool rules its owner accepted for it, 0 for none. Missing from older relays. */
  accepted?: number
}

/** A task: its revision goes up with every change, so two members never overwrite each other unknowingly. */
export interface PoolTaskWire extends PoolAuthor {
  id: string
  rev: number
  updatedAt: string
  /** `PoolTask`. */
  blob: Sealed
}

export interface PoolNotesWire extends PoolAuthor {
  rev: number
  updatedAt: string
  /** `PoolNotes`. */
  blob: Sealed
}

/** A message or an event, in the order the relay got them. */
export interface PoolPostWire extends PoolAuthor {
  id: string
  seq: number
  ts: string
  /** `PoolMessageBody` or `PoolEventBody`. */
  blob: Sealed
}

/** The pool's rules or budgets: who set them last, and the sealed `PoolRules` or `PoolBudgets`. Same shape as the notes. */
export type PoolPolicyWire = PoolNotesWire

/** What the audit log records. The relay writes it in clear: it already knows each of these, as it enforces them. */
export type PoolAuditAction =
  | 'created'
  | 'joined'
  | 'left'
  | 'kicked'
  | 'role'
  | 'owner'
  | 'rotated'
  | 'invite_created'
  | 'invite_revoked'
  | 'session_joined'
  | 'session_left'
  | 'paused'
  | 'resumed'
  | 'stopped'
  | 'rules_proposed'
  | 'rules_accepted'
  | 'budgets_set'

/** One line of the audit log: who did what, to whom, when. */
export interface PoolAuditWire extends PoolAuthor {
  seq: number
  ts: string
  action: PoolAuditAction
  target?: { account?: string; session?: string }
  /** The revision of the rules or budgets, or the key version. */
  rev?: number
}

export interface PoolSnapshot {
  id: string
  createdAt: string
  paused: boolean
  keyVersion: number
  info: Sealed
  members: PoolMemberWire[]
  sessions: PoolSessionWire[]
  tasks: PoolTaskWire[]
  notes: PoolNotesWire | null
  /** The latest ones only, oldest first. */
  messages: PoolPostWire[]
  events: PoolPostWire[]
  /** For the account it is sent to: its private key for the pool and the later pool keys wrapped for it. */
  own?: { secret: Sealed | null; wraps: PoolKeyWrapWire[] }
  /** Missing from older relays. */
  rules?: PoolPolicyWire | null
  budgets?: PoolPolicyWire | null
  /** The latest lines of the audit log, oldest first. */
  audit?: PoolAuditWire[]
}

// app or agent -> relay. Agents add their `sessionId`; the relay attaches the sender to what it keeps.

export type PoolPost =
  /** `rev`: the revision it replaces, 0 for a new task. */
  | { t: 'pool_task'; poolId: string; id: string; rev: number; blob: Sealed }
  | { t: 'pool_notes'; poolId: string; rev: number; blob: Sealed }
  | { t: 'pool_message'; poolId: string; id: string; blob: Sealed }
  | { t: 'pool_event'; poolId: string; id: string; blob: Sealed }

export type PoolAppMessage =
  | PoolPost
  | { t: 'pool_subscribe'; poolId: string }
  | { t: 'pool_unsubscribe'; poolId: string }
  /** Owner and admins: a new sealed `PoolInfo`. */
  | { t: 'pool_info'; poolId: string; info: Sealed }
  /** Its own sealed `PoolMemberProfile`. */
  | { t: 'pool_profile'; poolId: string; profile: Sealed }
  /**
   * The account's own keys for the pool: `publicKey` a `PoolMemberKey` sealed with the pool key, `secret` a
   * `PoolMemberSecret` sealed with the account key. Sent again with the latest pool key after a rotation.
   */
  | { t: 'pool_member_key'; poolId: string; publicKey: Sealed; secret: Sealed }
  /** Puts one of the account's sessions in the pool: `order` is a `PoolSessionOrder` sealed with the account key. */
  | { t: 'pool_join_session'; poolId: string; sessionId: string; order: Sealed; profile: Sealed }
  | { t: 'pool_leave_session'; poolId: string; sessionId: string }
  /** Owner and admins: stop or let through the tasks and messages to the pool's sessions. */
  | { t: 'pool_pause'; poolId: string; paused: boolean }
  /** Owner and admins: stop one session's pool work, or every session's when `target` is null. A member stops its own. */
  | { t: 'pool_stop'; poolId: string; target: { account: string; session: string } | null }
  /** Owner and admins: a new sealed `PoolRules` proposal. `rev`: the revision it replaces, 0 at first. */
  | { t: 'pool_rules'; poolId: string; rev: number; blob: Sealed }
  /** Owner and admins: new sealed `PoolBudgets`. */
  | { t: 'pool_budgets'; poolId: string; rev: number; blob: Sealed }
  /** A machine owner, for one of its own sessions: a `PoolRulesAcceptance` sealed with its account key. */
  | { t: 'pool_accept_rules'; poolId: string; sessionId: string; rev: number; acceptance: Sealed }

export type PoolAgentMessage =
  | (PoolPost & { sessionId: string })
  /** The member's public key sealed with a newer pool key: agents hold the account key and can publish it too. */
  | { t: 'pool_member_key'; sessionId: string; poolId: string; publicKey: Sealed }
  /** The agent opened the order and holds the pool key. */
  | { t: 'pool_ack'; sessionId: string; poolId: string }

// relay -> app, the website and the agents of pool sessions.

export type PoolUpdate =
  | { t: 'pool_snapshot'; pool: PoolSnapshot }
  | { t: 'pool_task'; poolId: string; task: PoolTaskWire }
  | { t: 'pool_notes'; poolId: string; notes: PoolNotesWire }
  | { t: 'pool_message'; poolId: string; message: PoolPostWire }
  | { t: 'pool_event'; poolId: string; event: PoolPostWire }
  | { t: 'pool_info'; poolId: string; info: Sealed; paused: boolean; keyVersion: number }
  | { t: 'pool_member'; poolId: string; member: PoolMemberWire }
  | { t: 'pool_member_left'; poolId: string; account: string }
  | { t: 'pool_session'; poolId: string; session: PoolSessionWire }
  | { t: 'pool_session_left'; poolId: string; account: string; session: string }
  /** To one member only: the pool key was rotated, here is the new version wrapped for it. */
  | { t: 'pool_key'; poolId: string; wrap: PoolKeyWrapWire }
  | { t: 'pool_rules'; poolId: string; rules: PoolPolicyWire }
  | { t: 'pool_budgets'; poolId: string; budgets: PoolPolicyWire }
  | { t: 'pool_audit'; poolId: string; entry: PoolAuditWire }
  /** A change sent against an older revision was refused: here is the current one. */
  | {
      t: 'pool_conflict'
      poolId: string
      kind: 'task' | 'notes' | 'rules' | 'budgets'
      id?: string
      current: PoolTaskWire | PoolNotesWire | null
    }
  /** The account left, or the pool is gone. */
  | { t: 'pool_removed'; poolId: string }
  | { t: 'pool_error'; poolId: string; message: string }

// relay -> agent: a session joins or leaves a pool.
export type PoolToAgent =
  /** `acceptance`: the pool rules its owner accepted for it, a sealed `PoolRulesAcceptance`, when there are. */
  | { t: 'pool_join'; sessionId: string; poolId: string; order: Sealed; acceptance?: Sealed }
  | { t: 'pool_left'; sessionId: string; poolId: string }
  /** The owner or an admin stopped this session's pool work: interrupt the turn. `pool_left` follows. */
  | { t: 'pool_stop'; sessionId: string; poolId: string }
  /** Its owner accepted the pool rules for it, or newer ones. */
  | { t: 'pool_accept'; sessionId: string; poolId: string; acceptance: Sealed }
