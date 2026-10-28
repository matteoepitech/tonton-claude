// A pool as a client reads it: its key, kept wrapped with the account key; the order that puts a session in it; and its
// tasks, notes, messages and events, opened with the pool key and folded into an immutable state. What other members
// sealed is checked like anything from the relay: a field of the wrong type is dropped, never trusted.

import { bytesToBase64Url } from './base64'
import { type AccountKey, newAccountKey, open, seal } from './crypto'
import { PoolKeyring, type PoolKeyWrapWire } from './pool-keys'
import type {
  PoolArea,
  PoolAuditWire,
  PoolAuthor,
  PoolBudget,
  PoolBudgets,
  PoolEventBody,
  PoolInfo,
  PoolKeyGrant,
  PoolLimits,
  PoolLimitWindow,
  PoolMemberProfile,
  PoolMessageBody,
  PoolNotes,
  PoolNotesSection,
  PoolPolicyWire,
  PoolRole,
  PoolRules,
  PoolRulesAcceptance,
  PoolSessionOrder,
  PoolSessionProfile,
  PoolSessionRef,
  PoolSnapshot,
  PoolTask,
  PoolTaskSize,
  PoolTaskState,
  PoolUpdate,
  PoolUsage,
} from './pool-protocol'
import type { PermissionRule, Sealed, SessionStatus } from './protocol'

const KEY = /^[A-Za-z0-9_-]{43}$/
const TASK_STATES: readonly PoolTaskState[] = ['todo', 'assigned', 'in_progress', 'review', 'done', 'blocked']
const ROLES: readonly PoolRole[] = ['owner', 'admin', 'member', 'viewer']
const STATUSES: readonly SessionStatus[] = ['starting', 'working', 'waiting', 'permission', 'idle', 'error', 'ended', 'offline']
export const POOL_NOTES_SECTIONS: readonly PoolNotesSection[] = ['goal', 'stack', 'contracts', 'decisions']
const isSize = (value: unknown): value is PoolTaskSize => value === 'simple' || value === 'large'
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

/** What a machine owner accepted of the pool rules, for one of its sessions: only its agent opens it. */
export function sealPoolRulesAcceptance(accountKey: AccountKey, acceptance: Omit<PoolRulesAcceptance, 'issuedAt'>, issuedAt = new Date()) {
  const sealed: PoolRulesAcceptance = { ...acceptance, issuedAt: issuedAt.toISOString() }
  return seal(accountKey, sealed)
}

/** The acceptance, as the session's agent checks it: sealed with the account key, for this session and this pool. */
export async function openPoolRulesAcceptance(
  accountKey: AccountKey,
  sealed: Sealed,
  sessionId: string,
  poolId: string,
): Promise<PoolRulesAcceptance | null> {
  const acceptance = await open<Partial<PoolRulesAcceptance>>(accountKey, sealed).catch(() => null)
  if (!acceptance || acceptance.sessionId !== sessionId || acceptance.poolId !== poolId) return null
  if (!isCount(acceptance.rev) || typeof acceptance.issuedAt !== 'string' || !Array.isArray(acceptance.rules)) return null
  return { poolId, sessionId, rev: acceptance.rev, rules: permissionRules(acceptance.rules), issuedAt: acceptance.issuedAt }
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const MAX_POOL_RULES = 100

/** The rules of a list another member sealed, as the agent's matcher takes them (agent/src/rules.ts). */
function permissionRules(value: unknown[]): PermissionRule[] {
  return value
    .map(fields)
    .filter((rule): rule is Fields => rule !== null)
    .filter(rule => typeof rule.tool === 'string' && rule.tool.length > 0 && rule.tool.length <= 128)
    .filter(rule => rule.pattern === undefined || (typeof rule.pattern === 'string' && rule.pattern.length <= 1000))
    .slice(0, MAX_POOL_RULES)
    .map(rule => (typeof rule.pattern === 'string' ? { tool: rule.tool as string, pattern: rule.pattern } : { tool: rule.tool as string }))
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
  if (!f || name === undefined) return null
  const date = (value: unknown) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined)
  return defined({
    name,
    goal: text(f.goal),
    template: f.template === 'hackathon' ? ('hackathon' as const) : undefined,
    repo: text(f.repo),
    deadline: date(f.deadline),
    startedAt: date(f.startedAt),
  })
}

export function decodePoolMemberProfile(value: unknown): PoolMemberProfile | null {
  const name = text(fields(value)?.name)
  return name !== undefined ? { name } : null
}

export function decodePoolSessionProfile(value: unknown): PoolSessionProfile | null {
  const f = fields(value)
  if (!f) return null
  const tool: PoolSessionProfile['tool'] = f.tool === 'claude' || f.tool === 'opencode' ? f.tool : undefined
  const takes: PoolSessionProfile['takes'] = f.takes === 'simple' || f.takes === 'large' ? f.takes : undefined
  return defined({
    area: text(f.area),
    skills: text(f.skills),
    repo: text(f.repo),
    project: text(f.project),
    machine: text(f.machine),
    tool,
    orchestrator: f.orchestrator === true ? true : undefined,
    takes,
  })
}

/** What kind of task a session takes: its owner's choice, or by its tool when it made none. */
export function poolTaskSize(profile: PoolSessionProfile | null, tool: 'claude' | 'opencode'): PoolTaskSize {
  return profile?.takes ?? (tool === 'opencode' ? 'simple' : 'large')
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
    size: isSize(f.size) ? f.size : undefined,
    paths: texts(f.paths),
    hours: typeof f.hours === 'number' && Number.isFinite(f.hours) && f.hours > 0 && f.hours <= 1000 ? f.hours : undefined,
    reviewer: sessionRef(f.reviewer),
    review: text(f.review),
  })
}

/** The shared notes: free text, the sections, the areas with the paths they own. */
export function decodePoolNotes(value: unknown): PoolNotes | null {
  const f = fields(value)
  const body = text(f?.text)
  if (!f || body === undefined) return null
  const raw = fields(f.sections)
  const sections = raw
    ? defined(Object.fromEntries(POOL_NOTES_SECTIONS.map(name => [name, text(raw[name])])) as Partial<Record<PoolNotesSection, string>>)
    : undefined
  const areas = Array.isArray(f.areas)
    ? f.areas.flatMap((area): PoolArea[] => {
        const a = fields(area)
        const name = text(a?.name)
        return a && name !== undefined ? [{ name, paths: texts(a.paths) ?? [] }] : []
      })
    : undefined
  return defined({ text: body, sections: sections && Object.keys(sections).length ? sections : undefined, areas })
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
  return defined({
    kind,
    text: text(f.text),
    taskId: text(f.taskId),
    tool,
    model: text(f.model),
    costUSD: amount(f.costUSD),
    seconds: amount(f.seconds),
    limits: decodePoolLimits(f.limits),
    usage: decodePoolUsage(f.usage),
  })
}

const amount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

export function decodePoolRules(value: unknown): PoolRules | null {
  const f = fields(value)
  if (!f || !Array.isArray(f.rules)) return null
  return defined({ rules: permissionRules(f.rules), note: text(f.note) })
}

function decodeBudget(value: unknown): PoolBudget | undefined {
  const f = fields(value)
  if (!f) return undefined
  const budget = defined({ costUSD: amount(f.costUSD), hours: amount(f.hours) })
  return budget.costUSD === undefined && budget.hours === undefined ? undefined : budget
}

export function decodePoolBudgets(value: unknown): PoolBudgets | null {
  const f = fields(value)
  if (!f) return null
  const listed = fields(f.members)
  const members = listed
    ? Object.fromEntries(
        Object.entries(listed)
          .map(([account, budget]) => [account, decodeBudget(budget)] as const)
          .filter((entry): entry is readonly [string, PoolBudget] => entry[1] !== undefined),
      )
    : undefined
  return defined({
    pool: decodeBudget(f.pool),
    member: decodeBudget(f.member),
    members: members && Object.keys(members).length ? members : undefined,
  })
}

function decodeLimitWindow(value: unknown): PoolLimitWindow | undefined {
  const f = fields(value)
  const used = f?.usedPercent
  const resets = text(f?.resetsAt)
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100 || !resets || Number.isNaN(Date.parse(resets))) {
    return undefined
  }
  return { usedPercent: used, resetsAt: resets }
}

export function decodePoolLimits(value: unknown): PoolLimits | undefined {
  const f = fields(value)
  if (!f) return undefined
  const runsOut = text(f.runsOutAt)
  const limits = defined({
    fiveHour: decodeLimitWindow(f.fiveHour),
    sevenDay: decodeLimitWindow(f.sevenDay),
    runsOutAt: runsOut && !Number.isNaN(Date.parse(runsOut)) ? runsOut : undefined,
  })
  return Object.keys(limits).length ? limits : undefined
}

function decodeWindow(value: unknown): { usedPercent: number; resetsAt?: string } | undefined {
  const f = fields(value)
  const usedPercent = amount(f?.usedPercent)
  return f && usedPercent !== undefined ? defined({ usedPercent: Math.min(usedPercent, 100), resetsAt: text(f.resetsAt) }) : undefined
}

/** A session's tokens and windows, as its agent posted them: a field of the wrong type is left out. Undefined when nothing is left. */
export function decodePoolUsage(value: unknown): PoolUsage | undefined {
  const f = fields(value)
  if (!f) return undefined
  const tokens = fields(f.tokens)
  const input = amount(tokens?.input)
  const output = amount(tokens?.output)
  const usage = defined({
    tokens: input !== undefined && output !== undefined ? { input, output } : undefined,
    fiveHour: decodeWindow(f.fiveHour),
    sevenDay: decodeWindow(f.sevenDay),
  })
  return Object.keys(usage).length ? usage : undefined
}

const isSessionStatus = (value: unknown): value is SessionStatus => STATUSES.includes(value as SessionStatus)

// MARK: The pool's state

export interface PoolMember {
  account: string
  role: PoolRole
  joinedAt: string
  profile: PoolMemberProfile | null
  /** Its public key, sealed with each version it was published under: opened when a key is wrapped for it. */
  publicKeys: Sealed[]
}

export interface PoolSession {
  account: string
  session: string
  joinedAt: string
  profile: PoolSessionProfile | null
  online: boolean
  ready: boolean
  /** As the relay sees it; null from older relays. */
  status: SessionStatus | null
  /** The revision of the pool rules its owner accepted for it, 0 for none. */
  accepted: number
}

/** The pool's rules or budgets as last set, opened; `value` is null when the blob does not open. */
export interface PoolPolicyItem<T> extends PoolAuthor {
  rev: number
  updatedAt: string
  value: T | null
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
  /** `text` is null when the notes do not open with the pool key. */
  notes: (PoolAuthor & { rev: number; updatedAt: string; text: string | null } & Pick<PoolNotes, 'sections' | 'areas'>) | null
  messages: PoolPostItem<PoolMessageBody>[]
  events: PoolPostItem<PoolEventBody>[]
  /** This member's private key for the pool (sealed with its account key) and the pool keys wrapped for it. */
  own: { secret: Sealed | null; wraps: PoolKeyWrapWire[] }
  /** Auto-approve rules proposed to the sessions: they apply where a machine owner accepted them. */
  rules: PoolPolicyItem<PoolRules> | null
  budgets: PoolPolicyItem<PoolBudgets> | null
  /** The latest lines of the audit log, oldest first. */
  audit: PoolAuditWire[]
  /** The session that plans and assigns, as an owner or an admin set it on the relay. */
  orchestrator: PoolSessionRef | null
}

/** How many messages and events a client keeps in memory. */
const KEPT_POSTS = 500

/**
 * Seals with the latest pool key it holds, and opens with whichever version sealed a blob: after a rotation, what was
 * written before stays readable.
 */
export class PoolVault {
  readonly keyring: PoolKeyring

  /** A key alone is version 1 of the pool key. */
  constructor(key: string | PoolKeyring) {
    this.keyring = typeof key === 'string' ? new PoolKeyring(key, 1) : key
  }

  seal(
    value:
      | PoolInfo
      | PoolMemberProfile
      | PoolSessionProfile
      | PoolTask
      | PoolNotes
      | { text: string }
      | PoolMessageBody
      | PoolEventBody
      | PoolRules
      | PoolBudgets,
  ) {
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
      own: pool.own ?? { secret: null, wraps: [] },
      rules: pool.rules ? await this.policy(pool.rules, decodePoolRules) : null,
      budgets: pool.budgets ? await this.policy(pool.budgets, decodePoolBudgets) : null,
      audit: (pool.audit ?? []).slice(-KEPT_POSTS),
      orchestrator: pool.orchestrator ?? null,
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
      case 'pool_orchestrator':
        return { ...state, orchestrator: update.orchestrator }
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
          // The relay drops an orchestrator whose session left: so does the client.
          orchestrator: state.orchestrator?.account === update.account ? null : state.orchestrator,
        }
      case 'pool_session': {
        const session = await this.session(update.session)
        const others = state.sessions.filter(s => s.account !== session.account || s.session !== session.session)
        return { ...state, sessions: [...others, session] }
      }
      case 'pool_session_left': {
        const lead = state.orchestrator
        const gone = lead?.account === update.account && lead.session === update.session
        return {
          ...state,
          sessions: state.sessions.filter(s => s.account !== update.account || s.session !== update.session),
          orchestrator: gone ? null : lead,
        }
      }
      case 'pool_key': {
        const others = state.own.wraps.filter(wrap => wrap.version !== update.wrap.version)
        return { ...state, own: { ...state.own, wraps: [...others, update.wrap].sort((a, b) => a.version - b.version) } }
      }
      case 'pool_rules':
        return { ...state, rules: await this.policy(update.rules, decodePoolRules) }
      case 'pool_budgets':
        return { ...state, budgets: await this.policy(update.budgets, decodePoolBudgets) }
      case 'pool_audit':
        return { ...state, audit: [...state.audit, update.entry].slice(-KEPT_POSTS) }
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
      publicKeys: member.publicKeys,
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
      status: isSessionStatus(session.status) ? session.status : null,
      accepted: session.accepted ?? 0,
      profile: await this.read(session.profile, decodePoolSessionProfile),
    }
  }

  private async policy<T>(policy: PoolPolicyWire, decode: (value: unknown) => T | null): Promise<PoolPolicyItem<T>> {
    const { rev, updatedAt, account, session } = policy
    return { rev, updatedAt, account, session, value: await this.read(policy.blob, decode) }
  }

  private async task(task: PoolSnapshot['tasks'][number]): Promise<PoolTaskItem> {
    const { id, rev, updatedAt, account, session } = task
    return { id, rev, updatedAt, account, session, task: await this.read(task.blob, decodePoolTask) }
  }

  private async notes(notes: NonNullable<PoolSnapshot['notes']>) {
    const { rev, updatedAt, account, session } = notes
    const opened = await this.read(notes.blob, decodePoolNotes)
    return { rev, updatedAt, account, session, text: opened?.text ?? null, sections: opened?.sections, areas: opened?.areas }
  }

  private async post<T>(post: PoolSnapshot['messages'][number], decode: (value: unknown) => T | null): Promise<PoolPostItem<T>> {
    const { id, seq, ts, account, session } = post
    return { id, seq, ts, account, session, body: await this.read(post.blob, decode) }
  }
}

// MARK: Budgets

/** What a session spent in the pool, from the latest `spend` event its agent posted. */
export interface PoolSpend {
  costUSD: number
  seconds: number
}

/** The latest spend of each session, by `account/session`. */
export function poolSpend(state: Pick<PoolState, 'events'>): Map<string, PoolSpend & { account: string; session: string }> {
  const spend = new Map<string, PoolSpend & { account: string; session: string }>()
  for (const event of state.events) {
    if (event.body?.kind !== 'spend' || !event.session) continue
    spend.set(`${event.account}/${event.session}`, {
      account: event.account,
      session: event.session,
      costUSD: event.body.costUSD ?? 0,
      seconds: event.body.seconds ?? 0,
    })
  }
  return spend
}

/** The cap that applies to one member: its own if the budgets name it, else the one for every member. */
export function memberBudget(budgets: PoolBudgets | null | undefined, account: string): PoolBudget | undefined {
  return budgets?.members?.[account] ?? budgets?.member
}

/**
 * Why a member's sessions may take no more pool tasks, or null: past its own cap or past the pool's. `fresh` is what one
 * session spent by now, newer than its last `spend` event: its own agent knows it before the pool does.
 */
export function overBudget(
  state: Pick<PoolState, 'events' | 'budgets'>,
  account: string,
  fresh?: { session: string } & PoolSpend,
): string | null {
  const budgets = state.budgets?.value
  if (!budgets) return null
  const spend = poolSpend(state)
  if (fresh) spend.set(`${account}/${fresh.session}`, { account, ...fresh })
  const total = (list: PoolSpend[]) =>
    list.reduce((sum, s) => ({ costUSD: sum.costUSD + s.costUSD, seconds: sum.seconds + s.seconds }), { costUSD: 0, seconds: 0 })
  const past = (budget: PoolBudget | undefined, used: PoolSpend, whose: string): string | null => {
    if (budget?.costUSD !== undefined && used.costUSD >= budget.costUSD) return `${whose} budget of $${budget.costUSD} is spent`
    if (budget?.hours !== undefined && used.seconds >= budget.hours * 3600) return `${whose} budget of ${budget.hours} h is used up`
    return null
  }
  const all = [...spend.values()]
  return (
    past(memberBudget(budgets, account), total(all.filter(s => s.account === account)), "This member's") ??
    past(budgets.pool, total(all), "The pool's")
  )
}
