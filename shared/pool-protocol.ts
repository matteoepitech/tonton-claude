// Pools: several accounts whose Claude Code sessions build one project together (docs/pools.md). What the relay keeps
// in clear is ids, roles, revisions, sizes and times; everything that says what the pool does is sealed with the pool
// key, which the members share and the relay never gets. Mirrors app/Sources/TontonCore/Pool.swift.

import type { PoolKeyWrapWire } from './pool-keys'
import type { Sealed } from './protocol'

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
  /** Older profiles only: the orchestrator is now the pool's `orchestrator` field, which only owners and admins set. */
  orchestrator?: boolean
  /**
   * The kind of task its owner gives it: `simple` (tests, docs, small fixes, boilerplate) or `large` (features that need
   * broad context). Missing: by its tool, simple for OpenCode and large for Claude Code (docs/pools.md, Sizes of work).
   */
  takes?: PoolTaskSize
}

/** `simple`: tests, docs, small fixes, boilerplate, a page that follows an existing pattern. `large`: a feature, an area. */
export type PoolTaskSize = 'simple' | 'large'

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
  /** `pool/<id>-<slug>`: the branch the work goes on, one per task. */
  branch?: string
  /** What was done, when it is done or blocked. */
  summary?: string
  /** Missing: `large`. Decides who the orchestrator hands it to. */
  size?: PoolTaskSize
  /** The files and folders the task works in, from its area. */
  paths?: string[]
}

/** An area of the code and the paths it owns, so two sessions rarely edit the same files. */
export interface PoolArea {
  name: string
  paths: string[]
}

/** The sections of the shared notes, each replaced on its own. */
export type PoolNotesSection = 'goal' | 'stack' | 'contracts' | 'decisions'

export interface PoolNotes {
  /** Free text, for anything the sections do not hold. Older clients read and write only this. */
  text: string
  sections?: Partial<Record<PoolNotesSection, string>>
  areas?: PoolArea[]
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
  /**
   * The one pool session that plans and assigns, set by an owner or an admin. In clear, like every id: the relay
   * attests it, so no member can make its own session the orchestrator. Missing from older relays.
   */
  orchestrator?: PoolSessionRef | null
}

export interface PoolSessionRef {
  account: string
  session: string
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
  /** Owner and admins: make one of the pool's sessions the orchestrator, or none. */
  | { t: 'pool_orchestrator'; poolId: string; orchestrator: PoolSessionRef | null }

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
  | { t: 'pool_orchestrator'; poolId: string; orchestrator: PoolSessionRef | null }
  | { t: 'pool_member'; poolId: string; member: PoolMemberWire }
  | { t: 'pool_member_left'; poolId: string; account: string }
  | { t: 'pool_session'; poolId: string; session: PoolSessionWire }
  | { t: 'pool_session_left'; poolId: string; account: string; session: string }
  /** To one member only: the pool key was rotated, here is the new version wrapped for it. */
  | { t: 'pool_key'; poolId: string; wrap: PoolKeyWrapWire }
  /** A change sent against an older revision was refused: here is the current one. */
  | { t: 'pool_conflict'; poolId: string; kind: 'task' | 'notes'; id?: string; current: PoolTaskWire | PoolNotesWire | null }
  /** The account left, or the pool is gone. */
  | { t: 'pool_removed'; poolId: string }
  | { t: 'pool_error'; poolId: string; message: string }

// relay -> agent: a session joins or leaves a pool.
export type PoolToAgent =
  | { t: 'pool_join'; sessionId: string; poolId: string; order: Sealed }
  | { t: 'pool_left'; sessionId: string; poolId: string }
