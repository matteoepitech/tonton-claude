// Pool machines in the client core (docs/pool-autopilot.md): the profile the members see, sealed with the pool key; the
// order its owner seals with the account key for the machine's agent service, which is what the agent applies; and the
// dispatch setting. What another member sealed is checked like anything from the relay: a field of the wrong type is
// dropped, never trusted. Mirrors app/Sources/TontonCore/PoolMachine.swift.

import { type AccountKey, open, seal } from './crypto'
import type { PoolDispatch, PoolMachineMode, PoolMachineOrder, PoolMachineProfile, PoolMachineRef, PoolTaskSize } from './pool-protocol'
import type { Sealed } from './protocol'

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
  })
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
