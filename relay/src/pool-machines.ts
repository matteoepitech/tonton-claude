// Pool machines (docs/pool-autopilot.md): members put whole machines in a pool, and each machine's agent service starts
// sessions for the tasks dispatched to it. The relay keeps a machine's profile, sealed with the pool key, and the order
// that put it there, sealed with its owner's account key, which only that machine's service gets. It knows in clear
// which of the admin's machines runs the orchestrator; whether the control loop hands out tasks is a sealed policy, like
// the rules and the budgets.

import type { Database } from 'bun:sqlite'
import type { PoolMachineRef, PoolMachineWire, PoolRole } from '../../shared/pool-protocol'
import type { RelayContext } from './context'
import type { Socket } from './hub'
import { MAX_POOL_DISPATCH_BYTES, MAX_POOL_INFO_BYTES, MAX_POOL_MACHINES } from './limits'
import type { Author } from './pools'
import { isMachineId, isMachineRef, isRevision, isSealed } from './validate'

/** A machine in a pool, with the sealed order its service needs, to send again whenever the service connects. */
export interface PoolMachineRow {
  poolId: string
  accountId: string
  machineId: string
  addedAt: string
  profile: string
  order: string
  /** Its owner or an admin stopped it: it takes no work until one of them starts it again. */
  stopped: boolean
}

interface MachineRow {
  pool_id: string
  account_id: string
  machine_id: string
  added_at: string
  profile_blob: string
  order_blob: string
  stopped: number
}

const COLUMNS = 'pool_id, account_id, machine_id, added_at, profile_blob, order_blob'
const READ = `${COLUMNS}, stopped`

const toRow = (row: MachineRow): PoolMachineRow => ({
  poolId: row.pool_id,
  accountId: row.account_id,
  machineId: row.machine_id,
  addedAt: row.added_at,
  profile: row.profile_blob,
  order: row.order_blob,
  stopped: row.stopped === 1,
})

/** What the members see of a machine, with whether it is online and its service took the order. */
export const toMachineWire = (row: PoolMachineRow, live: { online: boolean; ready: boolean }): PoolMachineWire => ({
  account: row.accountId,
  machine: row.machineId,
  addedAt: row.addedAt,
  profile: row.profile,
  online: live.online,
  ready: live.ready,
  ...(row.stopped ? { stopped: true } : {}),
})

export class PoolMachineStore {
  constructor(private readonly db: Database) {}

  /**
   * Puts a member's machine in the pool, or replaces its profile and order. Null when the pool has as many machines as
   * it may. The caller checks the machine is the account's: machine ids are the relay's own.
   */
  add(poolId: string, accountId: string, machineId: string, order: string, profile: string): PoolMachineRow | null {
    return this.db.transaction(() => {
      const known = this.get(poolId, machineId)
      if (known) {
        this.db
          .query('UPDATE pool_machines SET order_blob = ?, profile_blob = ? WHERE pool_id = ? AND machine_id = ?')
          .run(order, profile, poolId, machineId)
        return { ...known, order, profile }
      }
      const { count } = this.db.query('SELECT COUNT(*) AS count FROM pool_machines WHERE pool_id = ?').get(poolId) as { count: number }
      if (count >= MAX_POOL_MACHINES) return null
      const addedAt = new Date().toISOString()
      this.db
        .query(`INSERT INTO pool_machines (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(poolId, accountId, machineId, addedAt, profile, order)
      return { poolId, accountId, machineId, addedAt, profile, order, stopped: false }
    })()
  }

  /** Stops the machine or lets it work again: false when it was so already. */
  setStopped(poolId: string, machineId: string, stopped: boolean): boolean {
    return (
      this.db
        .query('UPDATE pool_machines SET stopped = ? WHERE pool_id = ? AND machine_id = ? AND stopped != ?')
        .run(stopped ? 1 : 0, poolId, machineId, stopped ? 1 : 0).changes > 0
    )
  }

  remove(poolId: string, machineId: string): boolean {
    return this.db.query('DELETE FROM pool_machines WHERE pool_id = ? AND machine_id = ?').run(poolId, machineId).changes > 0
  }

  get(poolId: string, machineId: string): PoolMachineRow | null {
    const row = this.db
      .query(`SELECT ${READ} FROM pool_machines WHERE pool_id = ? AND machine_id = ?`)
      .get(poolId, machineId) as MachineRow | null
    return row ? toRow(row) : null
  }

  list(poolId: string): PoolMachineRow[] {
    const rows = this.db.query(`SELECT ${READ} FROM pool_machines WHERE pool_id = ? ORDER BY added_at`).all(poolId) as MachineRow[]
    return rows.map(toRow)
  }

  /** The machine ids of the pool, as `Hub.sendToPool` reaches their services. */
  ids(poolId: string): string[] {
    return (this.db.query('SELECT machine_id FROM pool_machines WHERE pool_id = ?').all(poolId) as { machine_id: string }[]).map(
      row => row.machine_id,
    )
  }

  /** Every pool the machine is in. */
  poolsOf(machineId: string): PoolMachineRow[] {
    const rows = this.db.query(`SELECT ${READ} FROM pool_machines WHERE machine_id = ?`).all(machineId) as MachineRow[]
    return rows.map(toRow)
  }

  ofAccount(poolId: string, accountId: string): PoolMachineRow[] {
    return this.list(poolId).filter(row => row.accountId === accountId)
  }

  setOrchestrator(poolId: string, machineId: string | null) {
    this.db.query('UPDATE pools SET orchestrator_machine = ? WHERE id = ?').run(machineId, poolId)
  }

  /** The machine chosen to run the orchestrator, whether or not it is still in the pool. */
  orchestratorId(poolId: string): string | null {
    const row = this.db.query('SELECT orchestrator_machine FROM pools WHERE id = ?').get(poolId) as {
      orchestrator_machine: string | null
    } | null
    return row?.orchestrator_machine ?? null
  }

  /** The machine that runs the orchestrator, while it is still in the pool. */
  orchestrator(poolId: string): PoolMachineRef | null {
    const row = this.db
      .query(
        `SELECT m.account_id, m.machine_id FROM pools p JOIN pool_machines m ON m.pool_id = p.id AND m.machine_id = p.orchestrator_machine
         WHERE p.id = ?`,
      )
      .get(poolId) as { account_id: string; machine_id: string } | null
    return row ? { account: row.account_id, machine: row.machine_id } : null
  }
}

const MACHINE_APP_MESSAGES = new Set([
  'pool_add_machine',
  'pool_remove_machine',
  'pool_stop_machine',
  'pool_orchestrator_machine',
  'pool_dispatch',
])

type MachineAppMessage =
  | { t: 'pool_add_machine'; poolId: string; machineId?: unknown; order?: unknown; profile?: unknown }
  | { t: 'pool_remove_machine'; poolId: string; machineId?: unknown }
  | { t: 'pool_stop_machine'; poolId: string; machine?: unknown; stopped?: unknown }
  | { t: 'pool_orchestrator_machine'; poolId: string; machine?: unknown }
  | { t: 'pool_dispatch'; poolId: string; rev?: unknown; blob?: unknown }

export const isMachineAppMessage = (t: unknown): boolean => MACHINE_APP_MESSAGES.has(t as string)

/** An app's message about the pool's machines or its dispatch. What it may not do is refused with a `pool_error`. */
export function handleMachineAppMessage(ctx: RelayContext, socket: Socket, poolId: string, role: PoolRole, message: MachineAppMessage) {
  const { accountId } = socket.data
  const author: Author = { accountId, sessionId: null }
  const manages = role === 'owner' || role === 'admin'
  const refuse = (text: string) => ctx.hub.send(socket, { t: 'pool_error', poolId, message: text })

  switch (message.t) {
    case 'pool_add_machine': {
      const { machineId, order, profile } = message
      if (!isMachineId(machineId) || !isSealed(order, MAX_POOL_INFO_BYTES) || !isSealed(profile, MAX_POOL_INFO_BYTES)) return
      if (role === 'viewer') return refuse('Viewers cannot put a machine in the pool.')
      // Only a machine of the account: the relay knows which are.
      if (!ctx.registry.machines(accountId).some(machine => machine.id === machineId)) return refuse('No such machine on this account.')
      const added = ctx.poolMachines.add(poolId, accountId, machineId, order, profile)
      if (!added) return refuse('This pool has as many machines as it may.')
      ctx.poolMachineJoined(added)
      ctx.auditPool(poolId, author, 'machine_added', { account: accountId, machine: machineId })
      return
    }
    case 'pool_remove_machine': {
      if (!isMachineId(message.machineId)) return
      const row = ctx.poolMachines.get(poolId, message.machineId)
      if (!row) return refuse('No such machine in this pool.')
      // Its owner can always take it out; the owner and admins too, as they stop sessions.
      if (row.accountId !== accountId && !manages) return refuse('Only its owner, and the pool’s owner and admins, take a machine out.')
      ctx.poolMachineLeft(row)
      ctx.auditPool(poolId, author, 'machine_removed', { account: row.accountId, machine: row.machineId })
      return
    }
    case 'pool_stop_machine': {
      const { machine, stopped } = message
      if ((machine !== null && !isMachineId(machine)) || typeof stopped !== 'boolean') return
      // Every machine at once is the owner's and the admins'; one machine, its owner's too.
      if (machine === null && !manages) return refuse('Only the owner and admins stop every machine.')
      const rows = machine === null ? ctx.poolMachines.list(poolId) : [ctx.poolMachines.get(poolId, machine)]
      if (!rows[0] && machine !== null) return refuse('No such machine in this pool.')
      for (const row of rows) {
        if (!row) continue
        if (row.accountId !== accountId && !manages) return refuse('Only its owner, and the pool’s owner and admins, stop a machine.')
        ctx.poolMachineStopped(row, stopped, author)
      }
      return
    }
    case 'pool_orchestrator_machine': {
      const ref = message.machine
      if (ref !== null && !isMachineRef(ref)) return
      if (!manages) return refuse('Only the owner and admins choose the orchestrator.')
      // One of their own machines: the orchestrator session it starts is theirs, and only they read and drive it.
      if (ref && (ref.account !== accountId || ctx.poolMachines.get(poolId, ref.machine)?.accountId !== accountId)) {
        return refuse('Only one of your own machines in this pool can run the orchestrator.')
      }
      ctx.poolMachines.setOrchestrator(poolId, ref?.machine ?? null)
      // One orchestrator: a session that machine did not start plans no more.
      const lead = ctx.pools.orchestrator(poolId)
      if (lead && (!ref || ctx.pools.sessionMachine(poolId, lead.account, lead.session) !== ref.machine))
        ctx.pools.setOrchestrator(poolId, null)
      ctx.poolOrchestratorChanged(poolId)
      return
    }
    case 'pool_dispatch':
      if (!isRevision(message.rev) || !isSealed(message.blob, MAX_POOL_DISPATCH_BYTES)) return
      if (!manages) return refuse('Only the owner and admins start or stop the dispatch.')
      setDispatch(ctx, socket, poolId, author, message.rev, message.blob)
      return
  }
}

/**
 * A new sealed `PoolDispatch` over revision `rev`, from the owner or an admin, the orchestrator session or the
 * orchestrator machine's control loop: kept, logged, and sent to every member.
 */
export function setDispatch(ctx: RelayContext, socket: Socket, poolId: string, author: Author, rev: unknown, blob: unknown) {
  if (!isRevision(rev) || !isSealed(blob, MAX_POOL_DISPATCH_BYTES)) return
  const put = ctx.poolSafety.putPolicy(poolId, 'dispatch', rev, blob, author)
  if (!put.ok) {
    if (put.reason === 'conflict') ctx.hub.send(socket, { t: 'pool_conflict', poolId, kind: 'dispatch', current: put.current })
    return
  }
  ctx.auditPool(poolId, author, 'dispatch_set', {}, put.value.rev)
  ctx.broadcastPool(poolId, { t: 'pool_dispatch', poolId, dispatch: put.value })
}

/** A machine's service connected: it gets the orders of its pools again, as a session's agent gets its own. */
export function poolMachineConnected(ctx: RelayContext, socket: Socket) {
  const { machineId, accountId } = socket.data
  if (!machineId || !socket.data.service) return
  for (const row of ctx.poolMachines.poolsOf(machineId)) {
    if (row.accountId !== accountId) continue
    ctx.hub.setPoolMachineReady(row.poolId, machineId, false)
    ctx.hub.send(socket, { t: 'pool_machine_join', machineId, poolId: row.poolId, order: row.order })
  }
}

/** The machine's service went away: its pool machines are not ready any more. */
export function poolMachineDisconnected(ctx: RelayContext, machineId: string) {
  for (const row of ctx.poolMachines.poolsOf(machineId)) ctx.hub.setPoolMachineReady(row.poolId, machineId, false)
}
