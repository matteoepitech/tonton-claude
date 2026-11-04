// Clusters: the Claude Code and OpenCode sessions of several machines and people, talking to each other (docs/cluster.md).
// No orchestrator, no tasks, nothing that drives a session of another account: only posts, a few shared documents and
// who is there. What the relay keeps in clear is ids, roles, revisions, sizes and times; everything that says what the
// sessions do is sealed with the cluster key, which the members share and the relay never gets.
// Mirrors app/Sources/TontonCore/Cluster.swift.

import type { PoolKeyWrapWire } from './pool-keys'
import type { Sealed, SessionStatus } from './protocol'

export type ClusterRole = 'owner' | 'member'

/** The coding tool of a session. */
export type ClusterTool = 'claude' | 'opencode'

/** Who wrote a post or a document, as the relay attests it from the socket it came on. */
export interface ClusterAuthor {
  account: string
  /** Null when it came from an app or the website rather than a session. */
  session: string | null
  /** The machine of the agent that wrote it. Missing for apps and the website. */
  machine?: string
}

// Plaintext payloads, sealed with the cluster key.

export interface ClusterInfo {
  name: string
  /** What the cluster is for, in a sentence. */
  about?: string
}

/** How a member shows in the cluster. */
export interface ClusterMemberProfile {
  name: string
}

/** How a session shows in the cluster: set by its owner on joining, then kept up to date by its agent. */
export interface ClusterSessionProfile {
  /** The session's name, as its owner sees it. */
  name?: string
  /** The project folder's name, never the full path. */
  project?: string
  /** The machine's name. */
  machine?: string
  tool?: ClusterTool
  model?: string
  branch?: string
  /** What the session says it is doing (`cluster_status`), and since when, ISO. */
  status?: string
  statusAt?: string
}

/**
 * `message`: to read. `ask`: a question that waits for an `answer` (`replyTo` names it). `event`: something that happened
 * (a push, a submit, a build). `claim`: a file or an asset held or released. `file`: a small file shared. `notice`: from
 * Tonton itself (a milestone of the clock). Readers skip kinds they don't know.
 */
export type ClusterPostKind = 'message' | 'ask' | 'answer' | 'event' | 'claim' | 'file' | 'notice'

/** Who a post is for: a session, or every session of a member when `session` is missing. */
export interface ClusterTarget {
  account: string
  session?: string
}

/** Something that happened, for `event` posts (docs/cluster.md, Events). Readers skip types they don't know. */
export interface ClusterEvent {
  /** `commit`, `push`, `submit`, `shelve`, `build`, `test`, `attention`, `custom`… */
  type: string
  /** Missing: not a pass or fail kind of event. */
  ok?: boolean
  /** A branch, a commit, a changelist: what names it. */
  ref?: string
  /** The files it touched, relative to the project. */
  paths?: string[]
  count?: number
}

/** A small file shared through the cluster (docs/cluster.md, Files): its bytes are sealed apart. */
export interface ClusterFileRef {
  id: string
  name: string
  size: number
  /** A media type: `image/png`, `text/plain`… */
  type: string
  /** Hex SHA-256 of the bytes, to check them once opened. */
  sha256: string
}

export interface ClusterPostBody {
  kind: ClusterPostKind
  text: string
  /** Missing or empty: every session of the cluster. */
  to?: ClusterTarget[]
  /** A word to group posts by: `art`, `gameplay`, `build`. */
  topic?: string
  /** The id of the post it answers or follows. */
  replyTo?: string
  event?: ClusterEvent
  file?: ClusterFileRef
}

/** The documents a cluster shares, each with its own revision: the relay takes any name of this shape. */
export type ClusterDocName = 'notes' | 'claims' | 'clock' | (string & {})

/** `notes`: the shared board, conventions, interfaces and decisions. */
export interface ClusterNotes {
  text: string
}

/** A file, a folder or a glob held by a session (docs/cluster.md, Claims). */
export interface ClusterClaim {
  id: string
  /** Relative to the project root, with `/`: `Content/Maps/Main.umap`, `Content/Characters/Hero/**`. */
  paths: string[]
  reason?: string
  account: string
  session: string
  /** ISO times: when it was taken, and when it lapses unless renewed. */
  at: string
  until?: string
}

/** `claims`. */
export interface ClusterClaims {
  claims: ClusterClaim[]
}

export interface ClusterMilestone {
  name: string
  /** ISO. */
  at: string
}

/** `clock`: a deadline for everyone, and the marks on the way. */
export interface ClusterClock {
  /** ISO, when the clock started. */
  startedAt?: string
  deadline?: string
  milestones?: ClusterMilestone[]
}

export interface ClusterKeyGrant {
  clusterId: string
  /** Base64url AES-256 key. */
  key: string
  version: number
}

/**
 * How a session takes posts, as its owner chose: `live` as they come, `digest` gathered for its next prompt, `muted`
 * not at all. Missing: live, or digest for a session that skips permission prompts (docs/cluster.md, The rule).
 */
export type ClusterDelivery = 'live' | 'digest' | 'muted'

/** From the owner's app, or its own agent, to one of its sessions' agents: be in this cluster, with its key. */
export interface ClusterSessionOrder {
  clusterId: string
  sessionId: string
  key: string
  version: number
  issuedAt: string
  delivery?: ClusterDelivery
  /** The owner turned live delivery on for a session that skips permission prompts. */
  liveWithoutPrompts?: boolean
}

// Wire shapes, as the relay keeps and sends them.

export interface ClusterSummary {
  id: string
  /** The role of the account asking. */
  role: ClusterRole
  createdAt: string
  keyVersion: number
  /** `ClusterInfo`, sealed with the cluster key. */
  info: Sealed
  /** `ClusterKeyGrant`, sealed with the account key: the version of the key this member joined with. */
  key: Sealed
  members: number
  /** The member's P-256 private key for the cluster, sealed with the account key. */
  secret: Sealed | null
  /** The later versions of the cluster key, wrapped for this member by the owner who rotated it. */
  wraps: PoolKeyWrapWire[]
}

export interface ClusterMemberWire {
  account: string
  role: ClusterRole
  joinedAt: string
  /** `ClusterMemberProfile`, sealed with the cluster key. */
  profile: Sealed | null
  /** Its public key, sealed with each version of the cluster key it was published under, oldest first. */
  publicKeys: Sealed[]
}

export interface ClusterSessionWire {
  account: string
  session: string
  /** The machine of its agent, as the relay attests it. Missing until its agent connected. */
  machine?: string
  joinedAt: string
  /** `ClusterSessionProfile`, sealed with the cluster key. */
  profile: Sealed | null
  /** Its agent is connected. */
  online: boolean
  /** Its agent took the order and holds the cluster key. */
  ready: boolean
  /** The session's status, which the relay sees anyway for its account; the members see it too. */
  status?: SessionStatus
}

/** A post, in the order the relay got them. */
export interface ClusterPostWire extends ClusterAuthor {
  id: string
  seq: number
  ts: string
  /** `ClusterPostBody`. */
  blob: Sealed
}

/** A shared document: its revision goes up with every change, so two writers never overwrite each other unknowingly. */
export interface ClusterDocWire extends ClusterAuthor {
  name: ClusterDocName
  rev: number
  updatedAt: string
  blob: Sealed
}

export interface ClusterSnapshot {
  id: string
  createdAt: string
  keyVersion: number
  info: Sealed
  members: ClusterMemberWire[]
  sessions: ClusterSessionWire[]
  /** The latest ones only, oldest first. */
  posts: ClusterPostWire[]
  docs: ClusterDocWire[]
  /** For the account it is sent to: its private key for the cluster and the later keys wrapped for it. */
  own?: { secret: Sealed | null; wraps: PoolKeyWrapWire[] }
}

// app -> relay. Apps and the website never post: posts come from sessions (docs/cluster.md, The rule).

export type ClusterAppMessage =
  | { t: 'cluster_subscribe'; clusterId: string }
  | { t: 'cluster_unsubscribe'; clusterId: string }
  /** The owner: a new sealed `ClusterInfo`. */
  | { t: 'cluster_info'; clusterId: string; info: Sealed }
  /** Its own sealed `ClusterMemberProfile`. */
  | { t: 'cluster_profile'; clusterId: string; profile: Sealed }
  /** The account's own keys: `publicKey` sealed with the cluster key, `secret` with the account key. */
  | { t: 'cluster_member_key'; clusterId: string; publicKey: Sealed; secret: Sealed }
  /** Puts one of the account's sessions in, or changes its order: a `ClusterSessionOrder` sealed with the account key. */
  | { t: 'cluster_join_session'; clusterId: string; sessionId: string; order: Sealed; profile: Sealed }
  | { t: 'cluster_leave_session'; clusterId: string; sessionId: string }
  /** `rev`: the revision it replaces, 0 for a new document. */
  | { t: 'cluster_doc'; clusterId: string; name: ClusterDocName; rev: number; blob: Sealed }

// agent -> relay, for the session its socket speaks for.

export type ClusterAgentMessage =
  | { t: 'cluster_post'; sessionId: string; clusterId: string; id: string; blob: Sealed }
  | { t: 'cluster_doc'; sessionId: string; clusterId: string; name: ClusterDocName; rev: number; blob: Sealed }
  /** The session's sealed `ClusterSessionProfile`, with a new status line. */
  | { t: 'cluster_session_profile'; sessionId: string; clusterId: string; profile: Sealed }
  /** The agent opened the order and holds the cluster key. */
  | { t: 'cluster_ack'; sessionId: string; clusterId: string }
  /** The member's public key sealed with a newer cluster key: agents hold the account key and can publish it. */
  | { t: 'cluster_member_key'; sessionId: string; clusterId: string; publicKey: Sealed }
  /** The agent puts its own session in, for its owner (`tonton cluster join`, a folder that joins). */
  | { t: 'cluster_join_session'; sessionId: string; clusterId: string; order: Sealed; profile: Sealed }
  | { t: 'cluster_leave_session'; sessionId: string; clusterId: string }

// relay -> apps, the website and the agents of cluster sessions.

export type ClusterUpdate =
  | { t: 'cluster_snapshot'; cluster: ClusterSnapshot }
  | { t: 'cluster_post'; clusterId: string; post: ClusterPostWire }
  | { t: 'cluster_doc'; clusterId: string; doc: ClusterDocWire }
  | { t: 'cluster_info'; clusterId: string; info: Sealed; keyVersion: number }
  | { t: 'cluster_member'; clusterId: string; member: ClusterMemberWire }
  | { t: 'cluster_member_left'; clusterId: string; account: string }
  | { t: 'cluster_session'; clusterId: string; session: ClusterSessionWire }
  | { t: 'cluster_session_left'; clusterId: string; account: string; session: string }
  /** To one member only: the cluster key was rotated, here is the new version wrapped for it. */
  | { t: 'cluster_key'; clusterId: string; wrap: PoolKeyWrapWire }
  /** A document sent against an older revision was refused: here is the current one. */
  | { t: 'cluster_conflict'; clusterId: string; name: ClusterDocName; current: ClusterDocWire | null }
  /** The account left or was removed, or the cluster is gone. */
  | { t: 'cluster_removed'; clusterId: string }
  | { t: 'cluster_error'; clusterId: string; message: string }

// relay -> agent: a session joins or leaves a cluster.
export type ClusterToAgent =
  | { t: 'cluster_join'; sessionId: string; clusterId: string; order: Sealed }
  | { t: 'cluster_left'; sessionId: string; clusterId: string }
