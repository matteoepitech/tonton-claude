// A cluster as a client reads it: its key, kept wrapped with the account key; the order that puts a session in it; and
// its posts and documents, opened with the cluster key and folded into an immutable state. What other members sealed is
// checked like anything from the relay: a field of the wrong type is dropped, never trusted.
// The key's versions, member keys and wraps are the pools' (shared/pool-keys.ts), scoped with `clusterKeyScope` so that
// a cluster's keys can never be taken for a pool's.

import { bytesToBase64Url } from './base64'
import type {
  ClusterAuthor,
  ClusterClaim,
  ClusterClaims,
  ClusterClock,
  ClusterDelivery,
  ClusterDocWire,
  ClusterEvent,
  ClusterFileRef,
  ClusterInfo,
  ClusterKeyGrant,
  ClusterMemberProfile,
  ClusterMilestone,
  ClusterNotes,
  ClusterPostBody,
  ClusterPostKind,
  ClusterPostWire,
  ClusterRole,
  ClusterSessionOrder,
  ClusterSessionProfile,
  ClusterSnapshot,
  ClusterTarget,
  ClusterTool,
  ClusterUpdate,
} from './cluster-protocol'
import { type AccountKey, newAccountKey, open, openBytes, seal, sealBytes } from './crypto'
import { blobVersion, PoolKeyring, type PoolKeyWrapWire } from './pool-keys'
import type { Sealed, SessionStatus } from './protocol'
import { isCodingTool } from './session'

const KEY = /^[A-Za-z0-9_-]{43}$/
const ROLES: readonly ClusterRole[] = ['owner', 'member']
const KINDS: readonly ClusterPostKind[] = ['message', 'ask', 'answer', 'event', 'claim', 'file', 'notice']
const DELIVERIES: readonly ClusterDelivery[] = ['live', 'digest', 'muted']
const STATUSES: readonly SessionStatus[] = ['starting', 'working', 'waiting', 'permission', 'idle', 'error', 'ended', 'offline']
/** The longest text kept from a field another member wrote. */
const MAX_TEXT = 16 * 1024
const MAX_LIST = 200

/** A new cluster key, made by whoever creates the cluster. It never goes to the relay unwrapped. */
export const newClusterKey = newAccountKey

/** A new cluster's id: 12 base64url characters, like the relay's own ids. */
export const newClusterId = (): string => bytesToBase64Url(crypto.getRandomValues(new Uint8Array(9)))

/** The largest file a session shares, before sealing (docs/cluster.md, Files). */
export const MAX_CLUSTER_FILE_BYTES = 10 * 1024 * 1024

/** A file's bytes sealed with the latest cluster key, its version in front after version 1, like every cluster blob. */
export async function sealClusterFile(keyring: PoolKeyring, bytes: Uint8Array<ArrayBuffer>): Promise<Sealed> {
  const key = keyring.current
  if (!key) throw new Error('no cluster key')
  const sealed = await sealBytes(key, bytes)
  return keyring.version === 1 ? sealed : `${keyring.version}:${sealed}`
}

/** Throws when the version is not held or the bytes do not open with it. */
export function openClusterFile(keyring: PoolKeyring, blob: Sealed): Promise<Uint8Array> {
  const key = keyring.key(blobVersion(blob))
  if (!key) return Promise.reject(new Error('no cluster key for this version'))
  return openBytes(key, blob.replace(/^\d{1,6}:/, ''))
}

/** Hex SHA-256, as a file's reference names its bytes. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** A random id for a post or a claim. */
export const newClusterItemId = (): string => bytesToBase64Url(crypto.getRandomValues(new Uint8Array(12)))

/** The name a cluster's member keys and wraps are made for: never a pool's id, which has no `:`. */
export const clusterKeyScope = (clusterId: string): string => `cluster:${clusterId}`

export const isClusterRole = (value: unknown): value is ClusterRole => ROLES.includes(value as ClusterRole)

/** The shape the relay takes for a document's name. */
export const CLUSTER_DOC_NAME = /^[a-z][a-z0-9-]{0,23}$/

// MARK: Keys and orders, with the account key

/** The member's own copy of the cluster key, for the relay to keep. */
export function grantClusterKey(accountKey: AccountKey, clusterId: string, key: string, version: number): Promise<Sealed> {
  const grant: ClusterKeyGrant = { clusterId, key, version }
  return seal(accountKey, grant)
}

/** The cluster key from the member's copy, if it opens with the account key and is for this cluster. */
export async function openClusterGrant(accountKey: AccountKey, sealed: Sealed, clusterId: string): Promise<ClusterKeyGrant | null> {
  const grant = await open<Partial<ClusterKeyGrant>>(accountKey, sealed).catch(() => null)
  if (grant?.clusterId !== clusterId || typeof grant.key !== 'string' || !KEY.test(grant.key) || !isVersion(grant.version)) return null
  return { clusterId, key: grant.key, version: grant.version }
}

export function sealClusterSessionOrder(accountKey: AccountKey, order: Omit<ClusterSessionOrder, 'issuedAt'>, issuedAt = new Date()) {
  const sealed: ClusterSessionOrder = { ...order, issuedAt: issuedAt.toISOString() }
  return seal(accountKey, sealed)
}

/**
 * The order as the session's agent checks it: sealed with the account key, for this session and this cluster. The relay
 * could hand an order to another session; it could not make one.
 */
export async function openClusterSessionOrder(
  accountKey: AccountKey,
  sealed: Sealed,
  sessionId: string,
  clusterId: string,
): Promise<ClusterSessionOrder | null> {
  const order = await open<Partial<ClusterSessionOrder>>(accountKey, sealed).catch(() => null)
  if (!order || order.sessionId !== sessionId || order.clusterId !== clusterId) return null
  if (typeof order.key !== 'string' || !KEY.test(order.key) || !isVersion(order.version) || typeof order.issuedAt !== 'string') return null
  return defined({
    clusterId,
    sessionId,
    key: order.key,
    version: order.version,
    issuedAt: order.issuedAt,
    delivery: DELIVERIES.includes(order.delivery as ClusterDelivery) ? order.delivery : undefined,
    liveWithoutPrompts: order.liveWithoutPrompts === true ? true : undefined,
  })
}

/**
 * How the session takes posts: what its owner chose, or by default live, and a digest for a session that skips
 * permission prompts unless its owner turned live delivery on for it (docs/cluster.md, The rule).
 */
export function clusterDelivery(
  order: Pick<ClusterSessionOrder, 'delivery' | 'liveWithoutPrompts'>,
  skipsPrompts: boolean,
): ClusterDelivery {
  const chosen = order.delivery ?? 'live'
  return chosen === 'live' && skipsPrompts && !order.liveWithoutPrompts ? 'digest' : chosen
}

/**
 * What a session's agent puts in its profile about how it takes posts, for every member to see: the delivery it really
 * gets, and that it skips permission prompts while it does.
 */
export function clusterDeliveryProfile(
  order: Pick<ClusterSessionOrder, 'delivery' | 'liveWithoutPrompts'>,
  skipsPrompts: boolean,
): Pick<ClusterSessionProfile, 'delivery' | 'skipsPrompts'> {
  return { delivery: clusterDelivery(order, skipsPrompts), ...(skipsPrompts ? { skipsPrompts: true as const } : {}) }
}

/** Why a session its owner set to live gets digests, as its agent says. */
export type ClusterDigestReason = 'prompts' | 'codex'

/**
 * Why a session its owner chose live for gets digests, as its agent says: it skips permission prompts (`prompts`: Live
 * anyway turns live delivery on), or it is a codex nothing drives (`codex`: a plain `codex` reads posts only at its next
 * prompt, `tonton codex` takes them live). Null when it gets what was chosen, or for an older agent, which says neither.
 */
export function clusterDigestReason(
  choice: Pick<ClusterSessionOrder, 'delivery' | 'liveWithoutPrompts'>,
  profile: Pick<ClusterSessionProfile, 'delivery' | 'skipsPrompts' | 'tool'> | null | undefined,
): ClusterDigestReason | null {
  if ((choice.delivery ?? 'live') !== 'live' || profile?.delivery !== 'digest') return null
  if (profile.skipsPrompts && !choice.liveWithoutPrompts) return 'prompts'
  return profile.tool === 'codex' ? 'codex' : null
}

const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1

// MARK: Payloads another member sealed

type Fields = Record<string, unknown>
const fields = (value: unknown): Fields | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null
const text = (value: unknown, max = MAX_TEXT): string | undefined => (typeof value === 'string' ? value.slice(0, max) : undefined)
const texts = (value: unknown, max = 1024): string[] | undefined =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .slice(0, MAX_LIST)
        .map(item => item.slice(0, max))
    : undefined
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
const date = (value: unknown): string | undefined => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined)
/** Leaves out the fields that are missing, as the sealing side does. */
const defined = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T

export function decodeClusterInfo(value: unknown): ClusterInfo | null {
  const f = fields(value)
  const name = text(f?.name, 200)
  return f && name !== undefined ? defined({ name, about: text(f.about, 2000) }) : null
}

export function decodeClusterMemberProfile(value: unknown): ClusterMemberProfile | null {
  const name = text(fields(value)?.name, 200)
  return name === undefined ? null : { name }
}

export function decodeClusterSessionProfile(value: unknown): ClusterSessionProfile | null {
  const f = fields(value)
  if (!f) return null
  return defined({
    name: text(f.name, 200),
    project: text(f.project, 200),
    machine: text(f.machine, 200),
    tool: isCodingTool(f.tool) ? (f.tool as ClusterTool) : undefined,
    model: text(f.model, 200),
    branch: text(f.branch, 200),
    status: text(f.status, 500),
    statusAt: date(f.statusAt),
    delivery: DELIVERIES.includes(f.delivery as ClusterDelivery) ? (f.delivery as ClusterDelivery) : undefined,
    skipsPrompts: f.skipsPrompts === true ? (true as const) : undefined,
  })
}

function target(value: unknown): ClusterTarget | null {
  const f = fields(value)
  if (typeof f?.account !== 'string') return null
  return typeof f.session === 'string' ? { account: f.account, session: f.session } : { account: f.account }
}

function event(value: unknown): ClusterEvent | undefined {
  const f = fields(value)
  const type = text(f?.type, 64)
  if (!f || !type) return undefined
  return defined({
    type,
    ok: typeof f.ok === 'boolean' ? f.ok : undefined,
    ref: text(f.ref, 500),
    paths: texts(f.paths),
    count: count(f.count),
  })
}

function fileRef(value: unknown): ClusterFileRef | undefined {
  const f = fields(value)
  if (!f || typeof f.id !== 'string' || typeof f.name !== 'string' || count(f.size) === undefined || typeof f.type !== 'string')
    return undefined
  if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return undefined
  return { id: f.id.slice(0, 64), name: f.name.slice(0, 255), size: f.size as number, type: f.type.slice(0, 127), sha256: f.sha256 }
}

export function decodeClusterPostBody(value: unknown): ClusterPostBody | null {
  const f = fields(value)
  if (!f || !KINDS.includes(f.kind as ClusterPostKind) || typeof f.text !== 'string') return null
  const to = Array.isArray(f.to) ? f.to.slice(0, MAX_LIST).flatMap(item => target(item) ?? []) : undefined
  return defined({
    kind: f.kind as ClusterPostKind,
    text: f.text.slice(0, MAX_TEXT),
    to: to?.length ? to : undefined,
    topic: text(f.topic, 64),
    replyTo: text(f.replyTo, 64),
    event: event(f.event),
    file: fileRef(f.file),
  })
}

export function decodeClusterNotes(value: unknown): ClusterNotes | null {
  const notes = text(fields(value)?.text, 1024 * 1024)
  return notes === undefined ? null : { text: notes }
}

function claim(value: unknown): ClusterClaim | null {
  const f = fields(value)
  const paths = texts(f?.paths)
  const at = date(f?.at)
  if (!f || typeof f.id !== 'string' || !paths?.length || typeof f.account !== 'string' || typeof f.session !== 'string' || !at) return null
  return defined({
    id: f.id.slice(0, 64),
    paths,
    reason: text(f.reason, 500),
    account: f.account,
    session: f.session,
    at,
    until: date(f.until),
  })
}

export function decodeClusterClaims(value: unknown): ClusterClaims | null {
  const list = fields(value)?.claims
  return Array.isArray(list) ? { claims: list.slice(0, 1000).flatMap(item => claim(item) ?? []) } : null
}

function milestone(value: unknown): ClusterMilestone | null {
  const f = fields(value)
  const name = text(f?.name, 200)
  const at = date(f?.at)
  return name && at ? { name, at } : null
}

export function decodeClusterClock(value: unknown): ClusterClock | null {
  const f = fields(value)
  if (!f) return null
  const milestones = Array.isArray(f.milestones) ? f.milestones.slice(0, 50).flatMap(item => milestone(item) ?? []) : undefined
  return defined({ startedAt: date(f.startedAt), deadline: date(f.deadline), milestones })
}

/** True when a post is for this session: for everyone, for every session of its account, or for it by name. */
export function clusterPostIsFor(body: Pick<ClusterPostBody, 'to'>, account: string, session: string): boolean {
  if (!body.to?.length) return true
  return body.to.some(to => to.account === account && (to.session === undefined || to.session === session))
}

// MARK: The cluster's state

export interface ClusterMember {
  account: string
  role: ClusterRole
  joinedAt: string
  profile: ClusterMemberProfile | null
  /** Its public key, sealed with each version it was published under: opened when a key is wrapped for it. */
  publicKeys: Sealed[]
}

export interface ClusterSession {
  account: string
  session: string
  machine?: string
  joinedAt: string
  profile: ClusterSessionProfile | null
  online: boolean
  ready: boolean
  /** As the relay sees it; null while it has none. */
  status: SessionStatus | null
}

export interface ClusterPostItem extends ClusterAuthor {
  id: string
  seq: number
  ts: string
  /** Null when it does not open with the cluster key or has the wrong shape. */
  body: ClusterPostBody | null
}

/** A document as last written, still sealed: open it with `ClusterVault.doc` and the decoder for its name. */
export interface ClusterDocItem extends ClusterAuthor {
  name: string
  rev: number
  updatedAt: string
  blob: Sealed
}

export interface ClusterState {
  id: string
  createdAt: string
  keyVersion: number
  info: ClusterInfo | null
  members: ClusterMember[]
  sessions: ClusterSession[]
  /** The latest ones, oldest first. */
  posts: ClusterPostItem[]
  docs: ClusterDocItem[]
  /** This member's private key for the cluster (sealed with its account key) and the cluster keys wrapped for it. */
  own: { secret: Sealed | null; wraps: PoolKeyWrapWire[] }
}

/** How many posts a client keeps in memory. */
const KEPT_POSTS = 500

/**
 * Seals with the latest cluster key it holds, and opens with whichever version sealed a blob: after a rotation, what was
 * written before stays readable.
 */
export class ClusterVault {
  readonly keyring: PoolKeyring

  /** A key alone is version 1 of the cluster key. */
  constructor(key: string | PoolKeyring) {
    this.keyring = typeof key === 'string' ? new PoolKeyring(key, 1) : key
  }

  seal(
    value:
      | ClusterInfo
      | ClusterMemberProfile
      | ClusterSessionProfile
      | ClusterPostBody
      | ClusterNotes
      | ClusterClaims
      | ClusterClock
      | { heroes: unknown[] },
  ): Promise<Sealed> {
    return this.keyring.seal(value)
  }

  async read<T>(blob: unknown, decode: (value: unknown) => T | null): Promise<T | null> {
    if (typeof blob !== 'string') return null
    try {
      return decode(await this.keyring.open<unknown>(blob))
    } catch {
      return null
    }
  }

  /** A document of the state, opened with the decoder for its name; null when it is missing or does not open. */
  doc<T>(state: Pick<ClusterState, 'docs'>, name: string, decode: (value: unknown) => T | null): Promise<T | null> {
    const item = state.docs.find(doc => doc.name === name)
    return item ? this.read(item.blob, decode) : Promise.resolve(null)
  }

  async snapshot(cluster: ClusterSnapshot): Promise<ClusterState> {
    const [info, members, sessions, posts] = await Promise.all([
      this.read(cluster.info, decodeClusterInfo),
      Promise.all(cluster.members.map(member => this.member(member))),
      Promise.all(cluster.sessions.map(session => this.session(session))),
      Promise.all(cluster.posts.map(post => this.post(post))),
    ])
    return {
      id: cluster.id,
      createdAt: cluster.createdAt,
      keyVersion: cluster.keyVersion,
      info,
      members,
      sessions,
      posts: posts.slice(-KEPT_POSTS),
      docs: cluster.docs.map(toDocItem),
      own: cluster.own ?? { secret: null, wraps: [] },
    }
  }

  /** The next state, or null when the cluster is gone for this client. Pure: the state passed in is never changed. */
  async apply(state: ClusterState, update: ClusterUpdate): Promise<ClusterState | null> {
    if (update.t === 'cluster_snapshot') return update.cluster.id === state.id ? this.snapshot(update.cluster) : state
    if (update.clusterId !== state.id) return state
    switch (update.t) {
      case 'cluster_post': {
        if (state.posts.some(post => post.id === update.post.id)) return state
        return { ...state, posts: [...state.posts, await this.post(update.post)].slice(-KEPT_POSTS) }
      }
      case 'cluster_doc': {
        const item = toDocItem(update.doc)
        return { ...state, docs: [...state.docs.filter(doc => doc.name !== item.name), item] }
      }
      case 'cluster_info':
        return { ...state, info: await this.read(update.info, decodeClusterInfo), keyVersion: update.keyVersion }
      case 'cluster_member': {
        const member = await this.member(update.member)
        return { ...state, members: [...state.members.filter(m => m.account !== member.account), member] }
      }
      case 'cluster_member_left':
        return {
          ...state,
          members: state.members.filter(m => m.account !== update.account),
          sessions: state.sessions.filter(s => s.account !== update.account),
        }
      case 'cluster_session': {
        const session = await this.session(update.session)
        const others = state.sessions.filter(s => s.account !== session.account || s.session !== session.session)
        return { ...state, sessions: [...others, session] }
      }
      case 'cluster_session_left':
        return { ...state, sessions: state.sessions.filter(s => s.account !== update.account || s.session !== update.session) }
      case 'cluster_key': {
        const others = state.own.wraps.filter(wrap => wrap.version !== update.wrap.version)
        return { ...state, own: { ...state.own, wraps: [...others, update.wrap].sort((a, b) => a.version - b.version) } }
      }
      case 'cluster_removed':
        return null
      case 'cluster_conflict':
      case 'cluster_error':
        return state
    }
  }

  private async member(member: ClusterSnapshot['members'][number]): Promise<ClusterMember> {
    return {
      account: member.account,
      role: isClusterRole(member.role) ? member.role : 'member',
      joinedAt: member.joinedAt,
      profile: await this.read(member.profile, decodeClusterMemberProfile),
      publicKeys: member.publicKeys,
    }
  }

  private async session(session: ClusterSnapshot['sessions'][number]): Promise<ClusterSession> {
    const { account, joinedAt, online, ready } = session
    return {
      account,
      session: session.session,
      ...(session.machine ? { machine: session.machine } : {}),
      joinedAt,
      online,
      ready,
      status: STATUSES.includes(session.status as SessionStatus) ? (session.status as SessionStatus) : null,
      profile: await this.read(session.profile, decodeClusterSessionProfile),
    }
  }

  private async post(post: ClusterPostWire): Promise<ClusterPostItem> {
    const { id, seq, ts, account, session } = post
    return {
      id,
      seq,
      ts,
      account,
      session,
      ...(post.machine ? { machine: post.machine } : {}),
      body: await this.read(post.blob, decodeClusterPostBody),
    }
  }
}

const toDocItem = (doc: ClusterDocWire): ClusterDocItem => ({
  name: doc.name,
  rev: doc.rev,
  updatedAt: doc.updatedAt,
  account: doc.account,
  session: doc.session,
  ...(doc.machine ? { machine: doc.machine } : {}),
  blob: doc.blob,
})
