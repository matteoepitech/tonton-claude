// Pool safety (docs/pools.md, Control): the owner and admins pause the pool, stop a session's work or everything, propose
// auto-approve rules and set budgets; each machine owner accepts the rules for its own sessions or not; and the audit log
// keeps who did what. Rules and budgets are sealed with the pool key, an acceptance with the machine owner's account key:
// the relay enforces roles and pauses from what it sees in clear, and never applies a rule itself.

import type { Database } from 'bun:sqlite'
import type { PoolAuditAction, PoolAuditWire, PoolPolicyWire, PoolRole } from '../../shared/pool-protocol'
import type { RelayContext } from './context'
import type { Socket } from './hub'
import { MAX_POOL_AUDIT, MAX_POOL_BUDGETS_BYTES, MAX_POOL_RULES_BYTES } from './limits'
import { type Author, byMachine, type Put } from './pools'
import { isAccountId, isRevision, isSealed, isSessionId } from './validate'

/** `dispatch`: whether the control loop hands out tasks (docs/pool-autopilot.md), sealed like the rules and the budgets. */
export type PolicyKind = 'rules' | 'budgets' | 'dispatch'

interface PolicyRow {
  rev: number
  updated_at: string
  account_id: string
  session_id: string | null
  machine_id: string | null
  blob: string
}

interface AuditRow {
  seq: number
  ts: string
  account_id: string
  session_id: string | null
  machine_id: string | null
  action: PoolAuditAction
  target_account: string | null
  target_session: string | null
  target_machine: string | null
  rev: number | null
}

const toPolicy = (row: PolicyRow): PoolPolicyWire => ({
  rev: row.rev,
  updatedAt: row.updated_at,
  account: row.account_id,
  session: row.session_id,
  ...byMachine(row.machine_id),
  blob: row.blob,
})

const toAudit = (row: AuditRow): PoolAuditWire => {
  const target = {
    ...(row.target_account ? { account: row.target_account } : {}),
    ...(row.target_session ? { session: row.target_session } : {}),
    ...(row.target_machine ? { machine: row.target_machine } : {}),
  }
  return {
    seq: row.seq,
    ts: row.ts,
    account: row.account_id,
    session: row.session_id,
    ...byMachine(row.machine_id),
    action: row.action,
    ...(Object.keys(target).length ? { target } : {}),
    ...(row.rev !== null ? { rev: row.rev } : {}),
  }
}

const now = () => new Date().toISOString()

export class PoolSafetyStore {
  constructor(private readonly db: Database) {}

  isPaused(poolId: string): boolean {
    const row = this.db.query('SELECT paused FROM pools WHERE id = ?').get(poolId) as { paused: number } | null
    return row?.paused === 1
  }

  /** False when it was so already. */
  setPaused(poolId: string, paused: boolean): boolean {
    return this.db.query('UPDATE pools SET paused = ? WHERE id = ? AND paused != ?').run(paused ? 1 : 0, poolId, paused ? 1 : 0).changes > 0
  }

  policy(poolId: string, kind: PolicyKind): PoolPolicyWire | null {
    const row = this.db
      .query('SELECT rev, updated_at, account_id, session_id, machine_id, blob FROM pool_policies WHERE pool_id = ? AND kind = ?')
      .get(poolId, kind) as PolicyRow | null
    return row ? toPolicy(row) : null
  }

  /** Writes the rules, the budgets or the dispatch over revision `rev` (0 at first). Refused when someone changed them since. */
  putPolicy(poolId: string, kind: PolicyKind, rev: number, blob: string, author: Author): Put<PoolPolicyWire> {
    return this.db.transaction((): Put<PoolPolicyWire> => {
      const current = this.policy(poolId, kind)
      if ((current?.rev ?? 0) !== rev) return { ok: false, reason: 'conflict', current }
      const row: PolicyRow = {
        rev: rev + 1,
        updated_at: now(),
        account_id: author.accountId,
        session_id: author.sessionId,
        machine_id: author.machineId ?? null,
        blob,
      }
      this.db
        .query(
          `INSERT INTO pool_policies (pool_id, kind, rev, updated_at, account_id, session_id, machine_id, blob) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (pool_id, kind) DO UPDATE SET rev = excluded.rev, updated_at = excluded.updated_at,
             account_id = excluded.account_id, session_id = excluded.session_id, machine_id = excluded.machine_id, blob = excluded.blob`,
        )
        .run(poolId, kind, row.rev, row.updated_at, row.account_id, row.session_id, row.machine_id, row.blob)
      return { ok: true, value: toPolicy(row) }
    })()
  }

  /** The machine owner's sealed acceptance of the rules for one of its sessions. Gone with the pool session. */
  acceptance(poolId: string, accountId: string, sessionId: string): string | null {
    const row = this.db
      .query('SELECT blob FROM pool_acceptances WHERE pool_id = ? AND account_id = ? AND session_id = ?')
      .get(poolId, accountId, sessionId) as { blob: string } | null
    return row?.blob ?? null
  }

  setAcceptance(poolId: string, accountId: string, sessionId: string, rev: number, blob: string) {
    this.db
      .query(
        `INSERT INTO pool_acceptances (pool_id, account_id, session_id, rev, blob) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (pool_id, account_id, session_id) DO UPDATE SET rev = excluded.rev, blob = excluded.blob`,
      )
      .run(poolId, accountId, sessionId, rev, blob)
  }

  /** A line of the audit log, written in clear: the relay knows each of these, as it enforces them. Oldest go first. */
  audit(
    poolId: string,
    author: Author,
    action: PoolAuditAction,
    target: { account?: string; session?: string; machine?: string } = {},
    rev?: number,
  ): PoolAuditWire {
    return this.db.transaction(() => {
      const row = {
        ts: now(),
        account_id: author.accountId,
        session_id: author.sessionId,
        machine_id: author.machineId ?? null,
        action,
        target_account: target.account ?? null,
        target_session: target.session ?? null,
        target_machine: target.machine ?? null,
        rev: rev ?? null,
      }
      const { lastInsertRowid } = this.db
        .query(
          `INSERT INTO pool_audit (pool_id, ts, account_id, session_id, machine_id, action, target_account, target_session, target_machine, rev)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          poolId,
          row.ts,
          row.account_id,
          row.session_id,
          row.machine_id,
          row.action,
          row.target_account,
          row.target_session,
          row.target_machine,
          row.rev,
        )
      this.db
        .query(
          `DELETE FROM pool_audit WHERE pool_id = ? AND seq <= (
             SELECT seq FROM pool_audit WHERE pool_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
        )
        .run(poolId, poolId, MAX_POOL_AUDIT)
      return toAudit({ seq: Number(lastInsertRowid), ...row })
    })()
  }

  /** The latest `limit` lines, oldest first. */
  auditLog(poolId: string, limit: number): PoolAuditWire[] {
    const rows = this.db
      .query(
        `SELECT seq, ts, account_id, session_id, machine_id, action, target_account, target_session, target_machine, rev FROM pool_audit
         WHERE pool_id = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(poolId, limit) as AuditRow[]
    return rows.reverse().map(toAudit)
  }
}

const SAFETY_MESSAGES = new Set(['pool_pause', 'pool_stop', 'pool_rules', 'pool_budgets', 'pool_accept_rules'])

type SafetyMessage =
  | { t: 'pool_pause'; poolId: string; paused?: unknown }
  | { t: 'pool_stop'; poolId: string; target?: unknown }
  | { t: 'pool_rules' | 'pool_budgets'; poolId: string; rev?: unknown; blob?: unknown }
  | { t: 'pool_accept_rules'; poolId: string; sessionId?: unknown; rev?: unknown; acceptance?: unknown }

export const isSafetyMessage = (t: unknown): boolean => SAFETY_MESSAGES.has(t as string)

/** An app's safety message for a pool it is in. Everything it may not do is refused with a `pool_error`. */
export function handleSafetyMessage(ctx: RelayContext, socket: Socket, poolId: string, role: PoolRole, message: SafetyMessage) {
  const { accountId } = socket.data
  const author: Author = { accountId, sessionId: null }
  const manages = role === 'owner' || role === 'admin'
  const refuse = (text: string) => ctx.hub.send(socket, { t: 'pool_error', poolId, message: text })

  switch (message.t) {
    case 'pool_pause': {
      if (typeof message.paused !== 'boolean') return
      if (!manages) return refuse('Only the owner and admins pause the pool.')
      if (!ctx.poolSafety.setPaused(poolId, message.paused)) return
      ctx.auditPool(poolId, author, message.paused ? 'paused' : 'resumed')
      const state = ctx.pools.state(poolId)
      if (state) ctx.broadcastPool(poolId, { t: 'pool_info', poolId, ...state })
      // What the sessions did not get while it was paused: the pool as it is now.
      if (!message.paused) ctx.resendPoolToAgents(poolId)
      return
    }
    case 'pool_stop': {
      const target = message.target
      if (target === null) {
        if (!manages) return refuse('Only the owner and admins stop every session.')
        stopSessions(ctx, poolId, author, ctx.poolSessions(poolId))
        return
      }
      const t = target as { account?: unknown; session?: unknown } | undefined
      if (!isAccountId(t?.account) || !isSessionId(t.session)) return
      // A member stops its own sessions; the owner and admins stop anyone's.
      if (!manages && t.account !== accountId) return refuse('Only the owner and admins stop another member’s sessions.')
      if (!ctx.pools.isPoolSession(poolId, t.account, t.session)) return refuse('No such session in this pool.')
      stopSessions(ctx, poolId, author, [{ accountId: t.account, sessionId: t.session }])
      return
    }
    case 'pool_rules':
    case 'pool_budgets': {
      const kind: PolicyKind = message.t === 'pool_rules' ? 'rules' : 'budgets'
      const max = kind === 'rules' ? MAX_POOL_RULES_BYTES : MAX_POOL_BUDGETS_BYTES
      if (!isRevision(message.rev) || !isSealed(message.blob, max)) return
      if (!manages) return refuse(kind === 'rules' ? 'Only the owner and admins propose rules.' : 'Only the owner and admins set budgets.')
      const put = ctx.poolSafety.putPolicy(poolId, kind, message.rev, message.blob, author)
      if (!put.ok) {
        if (put.reason === 'conflict') ctx.hub.send(socket, { t: 'pool_conflict', poolId, kind, current: put.current })
        return
      }
      ctx.auditPool(poolId, author, kind === 'rules' ? 'rules_proposed' : 'budgets_set', {}, put.value.rev)
      if (kind === 'rules') ctx.broadcastPool(poolId, { t: 'pool_rules', poolId, rules: put.value })
      else ctx.broadcastPool(poolId, { t: 'pool_budgets', poolId, budgets: put.value })
      return
    }
    case 'pool_accept_rules': {
      const { sessionId, rev, acceptance } = message
      if (!isSessionId(sessionId) || !isRevision(rev) || !isSealed(acceptance, MAX_POOL_RULES_BYTES)) return
      // Only the machine owner, for its own session: the relay knows which sessions are the account's.
      if (!ctx.pools.isPoolSession(poolId, accountId, sessionId)) return refuse('No such session of yours in this pool.')
      const current = ctx.poolSafety.policy(poolId, 'rules')?.rev ?? 0
      if (rev > current) return refuse('These rules were never proposed.')
      ctx.poolSafety.setAcceptance(poolId, accountId, sessionId, rev, acceptance)
      const agent = ctx.hub.agentOf(accountId, sessionId)
      if (agent) ctx.hub.send(agent, { t: 'pool_accept', sessionId, poolId, acceptance })
      ctx.auditPool(poolId, author, 'rules_accepted', { account: accountId, session: sessionId }, rev)
      ctx.poolSessionChanged(poolId, accountId, sessionId)
      return
    }
  }
}

/** Interrupts the sessions' turns, then takes them out of the pool. */
function stopSessions(ctx: RelayContext, poolId: string, author: Author, sessions: { accountId: string; sessionId: string }[]) {
  for (const { accountId, sessionId } of sessions) {
    const agent = ctx.hub.agentOf(accountId, sessionId)
    if (agent) ctx.hub.send(agent, { t: 'pool_stop', sessionId, poolId })
    if (ctx.pools.removeSession(poolId, accountId, sessionId)) ctx.sessionLeftPool({ poolId, accountId, sessionId }, true)
    ctx.auditPool(poolId, author, 'stopped', { account: accountId, session: sessionId })
  }
}
