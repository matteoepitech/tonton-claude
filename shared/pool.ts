// A pool as a client reads it: its key, kept wrapped with the account key; the order that puts a session in it; and its
// tasks, notes, messages and events, opened with the pool key and folded into an immutable state. What other members
// sealed is checked like anything from the relay: a field of the wrong type is dropped, never trusted.

import { bytesToBase64Url } from './base64'
import { type AccountKey, newAccountKey, open, seal } from './crypto'
import type {
  PoolAuthor,
  PoolEventBody,
  PoolInfo,
  PoolKeyGrant,
  PoolMemberProfile,
  PoolMessageBody,
  PoolRole,
  PoolSessionOrder,
  PoolSessionProfile,
  PoolSnapshot,
  PoolTask,
  PoolTaskState,
  PoolUpdate,
} from './pool-protocol'
import type { Sealed } from './protocol'

const KEY = /^[A-Za-z0-9_-]{43}$/
const TASK_STATES: readonly PoolTaskState[] = ['todo', 'assigned', 'in_progress', 'review', 'done', 'blocked']
const ROLES: readonly PoolRole[] = ['owner', 'admin', 'member', 'viewer']
/** The longest text kept from a field another member wrote. */
const MAX_TEXT = 64 * 1024

/** A new pool key, made by whoever creates the pool. It never goes to the relay unwrapped. */
export const newPoolKey = newAccountKey

/** A random id for a task, a message or an event. */
export const newPoolItemId = (): string => bytesToBase64Url(crypto.getRandomValues(new Uint8Array(12)))

/** A new pool's id: 12 base64url characters, like the relay's own ids. */
export const newPoolId = (): string => bytesToBase64Url(crypto.getRandomValues(new Uint8Array(9)))

export const isPoolRole = (value: unknown): value is PoolRole => ROLES.includes(value as PoolRole)

// MARK: Keys and orders, with the account key

/** The member's own copy of the pool key, for the relay to keep. */
export function grantPoolKey(accountKey: AccountKey, poolId: string, key: string, version: number): Promise<Sealed> {
  const grant: PoolKeyGrant = { poolId, key, version }
  return seal(accountKey, grant)
}

/** The pool key from the member's copy, if it opens with the account key and is for this pool. */
export async function openPoolGrant(accountKey: AccountKey, sealed: Sealed, poolId: string): Promise<PoolKeyGrant | null> {
  const grant = await open<Partial<PoolKeyGrant>>(accountKey, sealed).catch(() => null)
  if (grant?.poolId !== poolId || typeof grant.key !== 'string' || !KEY.test(grant.key) || !isVersion(grant.version)) return null
  return { poolId, key: grant.key, version: grant.version }
}

export function sealPoolSessionOrder(accountKey: AccountKey, order: Omit<PoolSessionOrder, 'issuedAt'>, issuedAt = new Date()) {
  const sealed: PoolSessionOrder = { ...order, issuedAt: issuedAt.toISOString() }
  return seal(accountKey, sealed)
}

/**
 * The order from the member's app, as its agent checks it: sealed with the account key, for this session and this pool.
 * The relay could hand an order to another session; it could not make one.
 */
export async function openPoolSessionOrder(
  accountKey: AccountKey,
  sealed: Sealed,
  sessionId: string,
  poolId: string,
): Promise<PoolSessionOrder | null> {
  const order = await open<Partial<PoolSessionOrder>>(accountKey, sealed).catch(() => null)
  if (!order || order.sessionId !== sessionId || order.poolId !== poolId) return null
  if (typeof order.key !== 'string' || !KEY.test(order.key) || !isVersion(order.version) || typeof order.issuedAt !== 'string') return null
  const autoStart = order.autoStart === true ? { autoStart: true } : {}
  return { poolId, sessionId, key: order.key, version: order.version, issuedAt: order.issuedAt, ...autoStart }
}

const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1

// MARK: Payloads another member sealed

type Fields = Record<string, unknown>
const fields = (value: unknown): Fields | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : undefined)
const texts = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.slice(0, MAX_TEXT)) : undefined
const sessionRef = (value: unknown): { account: string; session: string } | undefined => {
  const f = fields(value)
  return f && typeof f.account === 'string' && typeof f.session === 'string' ? { account: f.account, session: f.session } : undefined
}
/** Leaves out the fields that are missing, as the sealing side does. */
const defined = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T

export function decodePoolInfo(value: unknown): PoolInfo | null {
  const f = fields(value)
  const name = text(f?.name)
  return f && name !== undefined ? defined({ name, goal: text(f.goal) }) : null
}

export function decodePoolMemberProfile(value: unknown): PoolMemberProfile | null {
  const name = text(fields(value)?.name)
  return name !== undefined ? { name } : null
}

export function decodePoolSessionProfile(value: unknown): PoolSessionProfile | null {
  const f = fields(value)
  if (!f) return null
  const tool: PoolSessionProfile['tool'] = f.tool === 'claude' || f.tool === 'opencode' ? f.tool : undefined
  return defined({
    area: text(f.area),
    skills: text(f.skills),
    repo: text(f.repo),
    project: text(f.project),
    machine: text(f.machine),
    tool,
    orchestrator: f.orchestrator === true ? true : undefined,
  })
}

export function decodePoolTask(value: unknown): PoolTask | null {
  const f = fields(value)
  const title = text(f?.title)
  if (!f || title === undefined || !TASK_STATES.includes(f.state as PoolTaskState)) return null
  return defined({
    title,
    goal: text(f.goal),
    criteria: texts(f.criteria),
    area: text(f.area),
    state: f.state as PoolTaskState,
    assignee: sessionRef(f.assignee),
    dependsOn: texts(f.dependsOn),
    branch: text(f.branch),
    summary: text(f.summary),
  })
}

export function decodePoolMessageBody(value: unknown): PoolMessageBody | null {
  const f = fields(value)
  const body = text(f?.text)
  if (!f || body === undefined) return null
  const to = fields(f.to)
  const target = to ? defined({ session: sessionRef(to.session), area: text(to.area) }) : undefined
  return defined({ text: body, to: target && (target.session || target.area) ? target : undefined })
}

export function decodePoolEventBody(value: unknown): PoolEventBody | null {
  const f = fields(value)
  const kind = text(f?.kind)
  if (!f || kind === undefined) return null
  const tool: PoolEventBody['tool'] = f.tool === 'claude' || f.tool === 'opencode' ? f.tool : undefined
  return defined({ kind, text: text(f.text), taskId: text(f.taskId), tool, model: text(f.model) })
}

// MARK: The pool's state

export interface PoolMember {
  account: string
  role: PoolRole
  joinedAt: string
  profile: PoolMemberProfile | null
}

export interface PoolSession {
  account: string
  session: string
  joinedAt: string
  profile: PoolSessionProfile | null
  online: boolean
  ready: boolean
}

export interface PoolTaskItem extends PoolAuthor {
  id: string
  rev: number
  updatedAt: string
  /** Null when it does not open with the pool key or has the wrong shape. */
  task: PoolTask | null
}

export interface PoolPostItem<T> extends PoolAuthor {
  id: string
  seq: number
  ts: string
  body: T | null
}

export interface PoolState {
  id: string
  createdAt: string
  paused: boolean
  keyVersion: number
  info: PoolInfo | null
  members: PoolMember[]
  sessions: PoolSession[]
  /** In the order the relay listed them, then the order they were made. */
  tasks: PoolTaskItem[]
  notes: (PoolAuthor & { rev: number; updatedAt: string; text: string | null }) | null
  messages: PoolPostItem<PoolMessageBody>[]
  events: PoolPostItem<PoolEventBody>[]
}

/** How many messages and events a client keeps in memory. */
const KEPT_POSTS = 500

/** Seals and opens with the pool key. */
export class PoolVault {
  constructor(private readonly key: AccountKey) {}

  seal(value: PoolInfo | PoolMemberProfile | PoolSessionProfile | PoolTask | { text: string } | PoolMessageBody | PoolEventBody) {
    return seal(this.key, value)
  }

  async read<T>(blob: unknown, decode: (value: unknown) => T | null): Promise<T | null> {
    if (typeof blob !== 'string') return null
    try {
      return decode(await open<unknown>(this.key, blob))
    } catch {
      return null
    }
  }

  async snapshot(pool: PoolSnapshot): Promise<PoolState> {
    const [info, members, sessions, tasks, messages, events] = await Promise.all([
      this.read(pool.info, decodePoolInfo),
      Promise.all(pool.members.map(member => this.member(member))),
      Promise.all(pool.sessions.map(session => this.session(session))),
      Promise.all(pool.tasks.map(task => this.task(task))),
      Promise.all(pool.messages.map(post => this.post(post, decodePoolMessageBody))),
      Promise.all(pool.events.map(post => this.post(post, decodePoolEventBody))),
    ])
    return {
      id: pool.id,
      createdAt: pool.createdAt,
      paused: pool.paused,
      keyVersion: pool.keyVersion,
      info,
      members,
      sessions,
      tasks,
      notes: pool.notes ? await this.notes(pool.notes) : null,
      messages,
      events,
    }
  }

  /** The next state, or null when the pool is gone for this client. Pure: the state passed in is never changed. */
  async apply(state: PoolState, update: PoolUpdate): Promise<PoolState | null> {
    if (update.t === 'pool_snapshot') return update.pool.id === state.id ? this.snapshot(update.pool) : state
    if (update.poolId !== state.id) return state
    switch (update.t) {
      case 'pool_task': {
        const item = await this.task(update.task)
        const known = state.tasks.some(task => task.id === item.id)
        return { ...state, tasks: known ? state.tasks.map(task => (task.id === item.id ? item : task)) : [...state.tasks, item] }
      }
      case 'pool_notes':
        return { ...state, notes: await this.notes(update.notes) }
      case 'pool_message':
        return { ...state, messages: [...state.messages, await this.post(update.message, decodePoolMessageBody)].slice(-KEPT_POSTS) }
      case 'pool_event':
        return { ...state, events: [...state.events, await this.post(update.event, decodePoolEventBody)].slice(-KEPT_POSTS) }
      case 'pool_info':
        return { ...state, info: await this.read(update.info, decodePoolInfo), paused: update.paused, keyVersion: update.keyVersion }
      case 'pool_member': {
        const member = await this.member(update.member)
        const others = state.members.filter(m => m.account !== member.account)
        return { ...state, members: [...others, member] }
      }
      case 'pool_member_left':
        return {
          ...state,
          members: state.members.filter(m => m.account !== update.account),
          sessions: state.sessions.filter(s => s.account !== update.account),
        }
      case 'pool_session': {
        const session = await this.session(update.session)
        const others = state.sessions.filter(s => s.account !== session.account || s.session !== session.session)
        return { ...state, sessions: [...others, session] }
      }
      case 'pool_session_left':
        return { ...state, sessions: state.sessions.filter(s => s.account !== update.account || s.session !== update.session) }
      case 'pool_removed':
        return null
      case 'pool_conflict':
      case 'pool_error':
        return state
    }
  }

  private async member(member: PoolSnapshot['members'][number]): Promise<PoolMember> {
    return {
      account: member.account,
      role: member.role,
      joinedAt: member.joinedAt,
      profile: await this.read(member.profile, decodePoolMemberProfile),
    }
  }

  private async session(session: PoolSnapshot['sessions'][number]): Promise<PoolSession> {
    const { account, joinedAt, online, ready } = session
    return {
      account,
      session: session.session,
      joinedAt,
      online,
      ready,
      profile: await this.read(session.profile, decodePoolSessionProfile),
    }
  }

  private async task(task: PoolSnapshot['tasks'][number]): Promise<PoolTaskItem> {
    const { id, rev, updatedAt, account, session } = task
    return { id, rev, updatedAt, account, session, task: await this.read(task.blob, decodePoolTask) }
  }

  private async notes(notes: NonNullable<PoolSnapshot['notes']>) {
    const { rev, updatedAt, account, session } = notes
    const opened = await this.read(notes.blob, value => text(fields(value)?.text) ?? null)
    return { rev, updatedAt, account, session, text: opened }
  }

  private async post<T>(post: PoolSnapshot['messages'][number], decode: (value: unknown) => T | null): Promise<PoolPostItem<T>> {
    const { id, seq, ts, account, session } = post
    return { id, seq, ts, account, session, body: await this.read(post.blob, decode) }
  }
}
