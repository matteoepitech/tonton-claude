// Reads the pool messages the relay sends, like shared/wire.ts for the rest: the relay is not trusted, so a message whose
// shape is wrong is dropped, a record whose shape is wrong is left out, and unknown fields are ignored.

import { isPoolRole } from './pool'
import type { PoolKeyWrapWire } from './pool-keys'
import type {
  PoolAuditAction,
  PoolAuditWire,
  PoolMachineRef,
  PoolMachineWire,
  PoolMemberWire,
  PoolNotesWire,
  PoolPostWire,
  PoolSessionWire,
  PoolSnapshot,
  PoolTaskWire,
  PoolToAgent,
  PoolToMachine,
  PoolUpdate,
} from './pool-protocol'

type Fields = Record<string, unknown>

const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const isNullableText = (value: unknown): value is string | null => value === null || isText(value)
const isOptionalText = (value: unknown): value is string | undefined => value === undefined || isText(value)
/** The machine is the relay's attestation of who wrote it: a wrong shape drops the record rather than mislabel it. */
const isAuthor = (value: Fields) => isText(value.account) && isNullableText(value.session) && isOptionalText(value.machine)
const isSessionRef = (value: unknown): value is { account: string; session: string } =>
  isFields(value) && isText(value.account) && isText(value.session)
/** Null for none, undefined for a wrong shape. */
const orchestrator = (value: unknown) =>
  value === null ? null : isSessionRef(value) ? { account: value.account, session: value.session } : undefined
const isMachineRef = (value: unknown): value is PoolMachineRef => isFields(value) && isText(value.account) && isText(value.machine)
/** Null for none, undefined for a wrong shape. */
const machineRef = (value: unknown): PoolMachineRef | null | undefined =>
  value === null ? null : isMachineRef(value) ? { account: value.account, machine: value.machine } : undefined

const isMachine = (value: unknown): value is PoolMachineWire =>
  isFields(value) &&
  isMachineRef(value) &&
  isText(value.addedAt) &&
  isNullableText(value.profile) &&
  typeof value.online === 'boolean' &&
  typeof value.ready === 'boolean' &&
  (value.stopped === undefined || typeof value.stopped === 'boolean')

const isMember = (value: unknown): value is PoolMemberWire =>
  isFields(value) &&
  isText(value.account) &&
  isPoolRole(value.role) &&
  isText(value.joinedAt) &&
  isNullableText(value.profile) &&
  Array.isArray(value.publicKeys) &&
  value.publicKeys.every(isText)

const isWrap = (value: unknown): value is PoolKeyWrapWire =>
  isFields(value) && isCount(value.version) && value.version >= 2 && isText(value.from) && isText(value.blob)

/** The member's own keys in a snapshot: left out when their shape is wrong. */
function own(value: unknown): PoolSnapshot['own'] {
  if (!isFields(value) || !isNullableText(value.secret)) return undefined
  return { secret: value.secret, wraps: list(value.wraps, isWrap) ?? [] }
}

const isSession = (value: unknown): value is PoolSessionWire =>
  isFields(value) &&
  isText(value.account) &&
  isText(value.session) &&
  isText(value.joinedAt) &&
  isNullableText(value.profile) &&
  typeof value.online === 'boolean' &&
  typeof value.ready === 'boolean' &&
  (value.accepted === undefined || isCount(value.accepted)) &&
  isOptionalText(value.machine)

const isTask = (value: unknown): value is PoolTaskWire =>
  isFields(value) && isText(value.id) && isCount(value.rev) && isText(value.updatedAt) && isText(value.blob) && isAuthor(value)

const isNotes = (value: unknown): value is PoolNotesWire =>
  isFields(value) && isCount(value.rev) && isText(value.updatedAt) && isText(value.blob) && isAuthor(value)

const isPost = (value: unknown): value is PoolPostWire =>
  isFields(value) && isText(value.id) && isCount(value.seq) && isText(value.ts) && isText(value.blob) && isAuthor(value)

const AUDIT_ACTIONS: ReadonlySet<string> = new Set<PoolAuditAction>([
  'created',
  'joined',
  'left',
  'kicked',
  'role',
  'owner',
  'rotated',
  'invite_created',
  'invite_revoked',
  'session_joined',
  'session_left',
  'paused',
  'resumed',
  'stopped',
  'rules_proposed',
  'rules_accepted',
  'budgets_set',
  'machine_added',
  'machine_removed',
  'machine_stopped',
  'machine_started',
  'dispatch_set',
])

/** A line of the audit log, its unknown fields dropped; an action this client does not know is left out. */
function audit(value: unknown): PoolAuditWire | null {
  if (!isFields(value) || !isCount(value.seq) || !isText(value.ts) || !isAuthor(value) || !AUDIT_ACTIONS.has(String(value.action))) {
    return null
  }
  const target = isFields(value.target)
    ? {
        ...(isText(value.target.account) ? { account: value.target.account } : {}),
        ...(isText(value.target.session) ? { session: value.target.session } : {}),
        ...(isText(value.target.machine) ? { machine: value.target.machine } : {}),
      }
    : undefined
  return {
    seq: value.seq,
    ts: value.ts,
    account: value.account as string,
    session: value.session as string | null,
    ...(isText(value.machine) ? { machine: value.machine } : {}),
    action: value.action as PoolAuditAction,
    ...(target ? { target } : {}),
    ...(isCount(value.rev) ? { rev: value.rev } : {}),
  }
}

/** A policy of the snapshot: null when there is none, undefined when its shape is wrong or an older relay left it out. */
const policy = (value: unknown) => (value === null ? null : isNotes(value) ? value : undefined)

const list = <T>(value: unknown, check: (item: unknown) => item is T): T[] | null => (Array.isArray(value) ? value.filter(check) : null)

function snapshot(value: unknown): PoolSnapshot | null {
  if (!isFields(value) || !isText(value.id) || !isText(value.createdAt) || typeof value.paused !== 'boolean') return null
  if (!isCount(value.keyVersion) || !isText(value.info)) return null
  const members = list(value.members, isMember)
  const sessions = list(value.sessions, isSession)
  const tasks = list(value.tasks, isTask)
  const messages = list(value.messages, isPost)
  const events = list(value.events, isPost)
  if (!members || !sessions || !tasks || !messages || !events) return null
  const notes = value.notes === null ? null : isNotes(value.notes) ? value.notes : undefined
  if (notes === undefined) return null
  const { id, createdAt, paused, keyVersion, info } = value
  const mine = own(value.own)
  const rules = policy(value.rules)
  const budgets = policy(value.budgets)
  const log = Array.isArray(value.audit) ? value.audit.map(audit).filter((entry): entry is PoolAuditWire => entry !== null) : undefined
  // Older relays send none, and a wrong shape is left out rather than trusted: the state reads either as no orchestrator.
  const lead = orchestrator(value.orchestrator)
  // Likewise for the pool machines (docs/pool-autopilot.md): older relays have none.
  const machines = list(value.machines, isMachine)
  const leadMachine = machineRef(value.orchestratorMachine)
  const dispatch = policy(value.dispatch)
  return {
    id,
    createdAt,
    paused,
    keyVersion,
    info,
    members,
    sessions,
    tasks,
    notes,
    messages,
    events,
    ...(mine ? { own: mine } : {}),
    ...(rules !== undefined ? { rules } : {}),
    ...(budgets !== undefined ? { budgets } : {}),
    ...(log ? { audit: log } : {}),
    ...(lead !== undefined ? { orchestrator: lead } : {}),
    ...(machines ? { machines } : {}),
    ...(leadMachine !== undefined ? { orchestratorMachine: leadMachine } : {}),
    ...(dispatch !== undefined ? { dispatch } : {}),
  }
}

/** A pool message from the relay, or null for one this client does not know or with the wrong shape. */
export function parsePoolUpdate(value: unknown): PoolUpdate | null {
  if (!isFields(value) || !isText(value.t)) return null
  if (value.t === 'pool_snapshot') {
    const pool = snapshot(value.pool)
    return pool ? { t: 'pool_snapshot', pool } : null
  }
  const poolId = value.poolId
  if (!isText(poolId)) return null
  switch (value.t) {
    case 'pool_task':
      return isTask(value.task) ? { t: 'pool_task', poolId, task: value.task } : null
    case 'pool_notes':
      return isNotes(value.notes) ? { t: 'pool_notes', poolId, notes: value.notes } : null
    case 'pool_message':
      return isPost(value.message) ? { t: 'pool_message', poolId, message: value.message } : null
    case 'pool_event':
      return isPost(value.event) ? { t: 'pool_event', poolId, event: value.event } : null
    case 'pool_info':
      return isText(value.info) && typeof value.paused === 'boolean' && isCount(value.keyVersion)
        ? { t: 'pool_info', poolId, info: value.info, paused: value.paused, keyVersion: value.keyVersion }
        : null
    case 'pool_orchestrator': {
      const lead = orchestrator(value.orchestrator)
      const machine = value.machine === undefined ? undefined : machineRef(value.machine)
      if (lead === undefined || (value.machine !== undefined && machine === undefined)) return null
      return { t: 'pool_orchestrator', poolId, orchestrator: lead, ...(machine !== undefined ? { machine } : {}) }
    }
    case 'pool_member':
      return isMember(value.member) ? { t: 'pool_member', poolId, member: value.member } : null
    case 'pool_member_left':
      return isText(value.account) ? { t: 'pool_member_left', poolId, account: value.account } : null
    case 'pool_session':
      return isSession(value.session) ? { t: 'pool_session', poolId, session: value.session } : null
    case 'pool_session_left':
      return isText(value.account) && isText(value.session)
        ? { t: 'pool_session_left', poolId, account: value.account, session: value.session }
        : null
    case 'pool_machine':
      return isMachine(value.machine) ? { t: 'pool_machine', poolId, machine: value.machine } : null
    case 'pool_machine_left':
      return isText(value.account) && isText(value.machine)
        ? { t: 'pool_machine_left', poolId, account: value.account, machine: value.machine }
        : null
    case 'pool_dispatch':
      return isNotes(value.dispatch) ? { t: 'pool_dispatch', poolId, dispatch: value.dispatch } : null
    case 'pool_rules':
      return isNotes(value.rules) ? { t: 'pool_rules', poolId, rules: value.rules } : null
    case 'pool_budgets':
      return isNotes(value.budgets) ? { t: 'pool_budgets', poolId, budgets: value.budgets } : null
    case 'pool_audit': {
      const entry = audit(value.entry)
      return entry ? { t: 'pool_audit', poolId, entry } : null
    }
    case 'pool_conflict': {
      if (!['task', 'notes', 'rules', 'budgets', 'dispatch'].includes(value.kind as string)) return null
      const current =
        value.current === null
          ? null
          : value.kind === 'task'
            ? isTask(value.current)
              ? value.current
              : undefined
            : isNotes(value.current)
              ? value.current
              : undefined
      if (current === undefined) return null
      const kind = value.kind as Extract<PoolUpdate, { t: 'pool_conflict' }>['kind']
      return { t: 'pool_conflict', poolId, kind, ...(isText(value.id) ? { id: value.id } : {}), current }
    }
    case 'pool_key':
      return isWrap(value.wrap) ? { t: 'pool_key', poolId, wrap: value.wrap } : null
    case 'pool_removed':
      return { t: 'pool_removed', poolId }
    case 'pool_error':
      return isText(value.message) ? { t: 'pool_error', poolId, message: value.message } : null
    default:
      return null
  }
}

/** A join, leave, stop or acceptance for an agent, or null. */
export function parsePoolToAgent(value: unknown): PoolToAgent | null {
  if (!isFields(value) || !isText(value.sessionId) || !isText(value.poolId)) return null
  const { sessionId, poolId } = value
  if (value.t === 'pool_join') {
    if (!isText(value.order)) return null
    return { t: 'pool_join', sessionId, poolId, order: value.order, ...(isText(value.acceptance) ? { acceptance: value.acceptance } : {}) }
  }
  if (value.t === 'pool_left') return { t: 'pool_left', sessionId, poolId }
  if (value.t === 'pool_stop') return { t: 'pool_stop', sessionId, poolId }
  if (value.t === 'pool_accept')
    return isText(value.acceptance) ? { t: 'pool_accept', sessionId, poolId, acceptance: value.acceptance } : null
  return null
}

/** A pool machine's order for its agent service, or null. */
export function parsePoolToMachine(value: unknown): PoolToMachine | null {
  if (!isFields(value) || !isText(value.machineId) || !isText(value.poolId)) return null
  const { machineId, poolId } = value
  if (value.t === 'pool_machine_join') return isText(value.order) ? { t: 'pool_machine_join', machineId, poolId, order: value.order } : null
  if (value.t === 'pool_machine_leave') return { t: 'pool_machine_leave', machineId, poolId }
  return null
}

/** The relay's messages for an agent that are orders to it rather than changes of a pool. */
export const isPoolOrderType = (t: unknown): boolean =>
  t === 'pool_join' ||
  t === 'pool_left' ||
  t === 'pool_stop' ||
  t === 'pool_accept' ||
  t === 'pool_machine_join' ||
  t === 'pool_machine_leave'

export const isPoolMessageType = (t: unknown): boolean => typeof t === 'string' && t.startsWith('pool_')
