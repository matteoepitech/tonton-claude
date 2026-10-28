// Pool machines in the client core (docs/pool-autopilot.md): the profile the members see, sealed with the pool key; the
// order its owner seals with the account key for the machine's agent service, which is what the agent applies; and the
// dispatch setting. What another member sealed is checked like anything from the relay: a field of the wrong type is
// dropped, never trusted. Mirrors app/Sources/TontonCore/PoolMachine.swift.

import { type AccountKey, open, seal } from './crypto'
import type { PoolMachine } from './pool'
import { decodeModelPolicy } from './pool-model'
import type {
  PoolDispatch,
  PoolMachineMode,
  PoolMachineOrder,
  PoolMachineProfile,
  PoolMachineRef,
  PoolModelPolicy,
  PoolTaskSize,
} from './pool-protocol'
import type { ClaudePlan, MachineHealth, Sealed } from './protocol'
import type { Machine } from './session'

export const POOL_MACHINE_MODES: readonly PoolMachineMode[] = ['ask', 'edits', 'full']
/** How many sessions a machine runs at once for one pool, at most. */
export const MAX_POOL_MACHINE_CAPACITY = 8
/** Agents from this version run pool machines; older ones ignore the order (MachineInfo.poolMachinesSince). */
export const POOL_MACHINES_SINCE = '0.9.0'

const MAX_NAME = 200
const MAX_PATH = 1024
const MAX_AREAS = 20
const KEY = /^[A-Za-z0-9_-]{43}$/

type Fields = Record<string, unknown>
const fields = (value: unknown): Fields | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null
const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' ? value.slice(0, max) : undefined)
const defined = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T

export const isPoolMachineMode = (value: unknown): value is PoolMachineMode => POOL_MACHINE_MODES.includes(value as PoolMachineMode)
const isTool = (value: unknown): value is PoolMachineProfile['tool'] => value === 'claude' || value === 'opencode'
const isSize = (value: unknown): value is PoolTaskSize => value === 'simple' || value === 'large'
const PLAN = /^[a-z0-9_]{1,40}$/
const isCapacity = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_POOL_MACHINE_CAPACITY

/** `/srv/pool`, `~/pool`, `C:\pool`: a folder from the root or the home folder, never relative. */
export const isPoolWorkdir = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= MAX_PATH &&
  /^(\/|~\/|[A-Za-z]:[\\/])./.test(value) &&
  !value.split(/[\\/]/).includes('..') &&
  !/[\0\n\r]/.test(value)

/** A machine's profile as another member sealed it, or null when a field the agent needs is wrong. */
export function decodePoolMachineProfile(value: unknown): PoolMachineProfile | null {
  const f = fields(value)
  if (!f || !isTool(f.tool) || !isCapacity(f.capacity) || !isPoolWorkdir(f.workdir) || !isPoolMachineMode(f.mode)) return null
  const areas = Array.isArray(f.areas)
    ? f.areas
        .filter((area): area is string => typeof area === 'string' && area.length > 0)
        .slice(0, MAX_AREAS)
        .map(area => area.slice(0, MAX_NAME))
    : undefined
  return defined({
    name: text(f.name, MAX_NAME),
    tool: f.tool,
    capacity: f.capacity,
    workdir: f.workdir,
    mode: f.mode,
    takes: isSize(f.takes) ? f.takes : undefined,
    areas: areas?.length ? areas : undefined,
    models: decodeModelPolicy(f.models),
    plan: typeof f.plan === 'string' && PLAN.test(f.plan) ? (f.plan as ClaudePlan) : undefined,
  })
}

/** What a form fills in to put a machine in a pool: the profile, or why it can't be one. */
export function poolMachineProfile(input: {
  name?: string
  tool: string
  capacity: number
  workdir: string
  mode: string
  takes?: string
  areas?: string[]
  /** Kept as it is, checked like a sealed one. */
  models?: PoolModelPolicy
  plan?: ClaudePlan
}): PoolMachineProfile | string {
  const workdir = input.workdir.trim()
  if (!isTool(input.tool)) return 'Choose Claude Code or OpenCode.'
  if (!isCapacity(input.capacity)) return `Run 1 to ${MAX_POOL_MACHINE_CAPACITY} sessions at once.`
  if (!isPoolWorkdir(workdir)) return 'The work folder is a full path on that machine, such as ~/pool or /srv/pool.'
  if (!isPoolMachineMode(input.mode)) return 'Choose what its sessions may do: ask, edits or full.'
  const areas = (input.areas ?? []).map(area => area.trim().toLowerCase()).filter(Boolean)
  return defined({
    name: input.name?.trim() ? input.name.trim().slice(0, MAX_NAME) : undefined,
    tool: input.tool,
    capacity: input.capacity,
    workdir,
    mode: input.mode,
    takes: isSize(input.takes) ? input.takes : undefined,
    areas: areas.length ? [...new Set(areas)].slice(0, MAX_AREAS) : undefined,
    models: decodeModelPolicy(input.models),
    plan: input.tool === 'claude' && input.plan && PLAN.test(input.plan) ? input.plan : undefined,
  })
}

/** How many sessions a Claude Code machine runs at once by its plan: what the plan's windows sustain. */
const PLAN_SESSIONS: Record<ClaudePlan, number> = { max_20x: 3, max_5x: 2, team: 2, enterprise: 2, api: 2, pro: 1 }
/** OpenCode has no plan windows: its provider's limits are its owner's business. */
const OPENCODE_SESSIONS = 2
/** Memory each session needs, with its worktree's build and tests. */
const SESSION_MEMORY = 8 * 1024 ** 3

/** `Basel Hack` → `basel-hack`: a folder name every system takes. */
const slug = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')

/**
 * How one of the account's machines works for a pool when its owner says nothing (docs/pool-autopilot.md, Joining):
 * everything comes from what its agent reports. Claude Code when it is there and signed in, else OpenCode; as many
 * sessions at once as its plan sustains and its memory holds; a folder of its own per pool; the tier each task needs.
 * Null when the machine has no coding tool to run. The mode stays its owner's choice. Mirrors
 * `PoolMachineProfile.automatic` in app/Sources/TontonCore/PoolMachine.swift; both check shared/test/pool-auto-profile.json.
 */
export function autoPoolMachineProfile(
  machine: { name?: string; health: Pick<MachineHealth, 'tools' | 'plan' | 'memoryTotal'> | null },
  pool: { id: string; name?: string },
  mode: PoolMachineMode = 'edits',
): PoolMachineProfile | null {
  const health = machine.health
  // Older agents report no tools: they run Claude Code.
  const tools = health?.tools ?? ['claude']
  const plan = health?.plan && PLAN.test(health.plan) ? health.plan : undefined
  const tool = tools.includes('claude') && (plan || !tools.includes('opencode')) ? 'claude' : tools.includes('opencode') ? 'opencode' : null
  if (!tool) return null
  const wanted = tool === 'opencode' ? OPENCODE_SESSIONS : ((plan && PLAN_SESSIONS[plan]) ?? 1)
  const memory = health?.memoryTotal ? Math.max(1, Math.floor(health.memoryTotal / SESSION_MEMORY)) : MAX_POOL_MACHINE_CAPACITY
  const folder = [slug(pool.name ?? ''), pool.id.slice(0, 6).toLowerCase()].filter(Boolean).join('-')
  const profile = poolMachineProfile({
    name: machine.name,
    tool,
    capacity: Math.min(MAX_POOL_MACHINE_CAPACITY, wanted, memory),
    workdir: `~/tonton-pools/${folder}`,
    mode,
    plan: tool === 'claude' ? plan : undefined,
  })
  return typeof profile === 'string' ? null : profile
}

/** Its agent runs pool machines: from POOL_MACHINES_SINCE, or a development build (0.0.0), which runs the current code. */
export function runsPoolMachines(machine: Pick<Machine, 'agentVersion'>): boolean {
  const version = machine.agentVersion
  if (!version) return false
  if (version === '0.0.0') return true
  const [have, need] = [version, POOL_MACHINES_SINCE].map(v => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if ((have[i] ?? 0) !== (need[i] ?? 0)) return (have[i] ?? 0) > (need[i] ?? 0)
  return true
}

/** One of the account's machines, and how it would work for the pool. */
export interface MachinePick {
  machine: Machine
  profile: PoolMachineProfile
}

/**
 * The account's machines that can work for the pool and are not in it yet, each with its automatic profile, online ones
 * first: what joining or making a pool offers, every online one picked unless its owner unticks it.
 */
export function machinesToAdd(
  machines: readonly Machine[],
  pool: { id: string; name?: string; machines?: readonly Pick<PoolMachine, 'machine'>[] | null },
  mode: PoolMachineMode = 'edits',
): MachinePick[] {
  const inPool = new Set((pool.machines ?? []).map(machine => machine.machine))
  return machines
    .filter(machine => !inPool.has(machine.id) && runsPoolMachines(machine))
    .map(machine => ({ machine, profile: autoPoolMachineProfile(machine, pool, mode) }))
    .filter((pick): pick is MachinePick => pick.profile !== null)
    .sort((a, b) => Number(b.machine.online) - Number(a.machine.online))
}

/** Larger plans first, for the orchestrator as for large tasks. Not known: as a middle one. */
const PLAN_RANK: Partial<Record<string, number>> = { max_20x: 0, max_5x: 1, team: 1, enterprise: 1, api: 1, pro: 2 }
export const planRank = (profile: Pick<PoolMachineProfile, 'plan'> | null | undefined): number => PLAN_RANK[profile?.plan ?? ''] ?? 1

/**
 * Which of an admin's machines runs the orchestrator when nobody chose: Claude Code, which the orchestrator session
 * runs on, online first, then the largest plan, since planning and merging run on its account all along.
 */
export function bestOrchestrator<T extends { online: boolean; profile: PoolMachineProfile | null }>(machines: readonly T[]): T | null {
  return (
    machines
      .filter(machine => machine.profile?.tool === 'claude')
      .sort((a, b) => Number(b.online) - Number(a.online) || planRank(a.profile) - planRank(b.profile))[0] ?? null
  )
}

const PLAN_LABELS: Record<ClaudePlan, string> = {
  max_20x: 'Claude Max 20x',
  max_5x: 'Claude Max 5x',
  pro: 'Claude Pro',
  team: 'Claude Team',
  enterprise: 'Claude Enterprise',
  api: 'Claude API key',
}

/** `Claude Max 20x`, `OpenCode`, `Claude Code` when its plan is not known: what a machine brings to the pool. */
export function machinePlanLabel(profile: Pick<PoolMachineProfile, 'tool' | 'plan'> | null | undefined): string {
  if (profile?.tool === 'opencode') return 'OpenCode'
  return (profile?.plan && PLAN_LABELS[profile.plan]) ?? 'Claude Code'
}

/** The order for the machine's agent service, sealed with the account key: only that machine's owner can make one. */
export function sealPoolMachineOrder(
  accountKey: AccountKey,
  order: Omit<PoolMachineOrder, 'issuedAt'>,
  issuedAt = new Date(),
): Promise<Sealed> {
  const sealed: PoolMachineOrder = { ...order, issuedAt: issuedAt.toISOString() }
  return seal(accountKey, sealed)
}

/**
 * The order, as the machine's agent checks it: sealed with the account key, for this machine and this pool, with a
 * profile it can apply. The relay could hand an order to another machine; it could not make one, nor change its mode.
 */
export async function openPoolMachineOrder(
  accountKey: AccountKey,
  sealed: Sealed,
  machineId: string,
  poolId: string,
): Promise<PoolMachineOrder | null> {
  const order = await open<Partial<PoolMachineOrder>>(accountKey, sealed).catch(() => null)
  if (!order || order.machineId !== machineId || order.poolId !== poolId) return null
  if (typeof order.key !== 'string' || !KEY.test(order.key) || typeof order.issuedAt !== 'string') return null
  if (typeof order.version !== 'number' || !Number.isInteger(order.version) || order.version < 1) return null
  const profile = decodePoolMachineProfile(order.profile)
  if (!profile) return null
  return { poolId, machineId, key: order.key, version: order.version, issuedAt: order.issuedAt, profile }
}

export function decodePoolDispatch(value: unknown): PoolDispatch | null {
  const f = fields(value)
  if (!f || typeof f.on !== 'boolean') return null
  return defined({ on: f.on, note: text(f.note, 500) })
}

/** A machine named in a task or by the relay: undefined when its shape is wrong. */
export function decodePoolMachineRef(value: unknown): PoolMachineRef | undefined {
  const f = fields(value)
  return f && typeof f.account === 'string' && typeof f.machine === 'string' ? { account: f.account, machine: f.machine } : undefined
}
