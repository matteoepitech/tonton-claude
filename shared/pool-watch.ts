// A member's pools as a client follows them: the list with each pool's name, and the pools it opened, live. Each pool's
// key comes from the member's own copy and the later versions wrapped for it (shared/pool-keys.ts); a rotation brings a
// new snapshot, read with the new key. What the client changes (tasks, the pool's name) is sealed here, and every
// action the relay may refuse comes back as an error to show. Used by the website (web/pools.ts).

import type { AccountKey } from './crypto'
import { decodePoolInfo, newPoolItemId, openPoolGrant, type PoolState, PoolVault } from './pool'
import type { InviteSummary, PoolApi } from './pool-api'
import { taskEvent } from './pool-board'
import {
  needsRepublish,
  type PoolKeyring,
  type PoolMemberSecret,
  resolvePoolKeyring,
  sealPoolMemberKey,
  sealPoolMemberSecret,
} from './pool-keys'
import { formatPoolInvite, parsePoolInvite } from './pool-link'
import type {
  PoolAppMessage,
  PoolInfo,
  PoolMemberProfile,
  PoolRole,
  PoolSummary,
  PoolTask,
  PoolTaskWire,
  PoolUpdate,
} from './pool-protocol'

/** The part of a relay client pools need: `RelayClient` fits it. */
export interface PoolLink {
  subscribePool(poolId: string): void
  unsubscribePool(poolId: string): void
  sendPool(message: PoolAppMessage): boolean
}

export interface ListedPool {
  summary: PoolSummary
  /** Null until opened, or when the pool's name does not open with the keys this member holds. */
  info: PoolInfo | null
}

export interface OpenPool {
  id: string
  role: PoolRole
  /** Null until the first snapshot. */
  state: PoolState | null
  /** Tasks someone else changed while this member was changing them: the board shows theirs, and says so. */
  conflicts: ReadonlySet<string>
  /** The last thing the relay refused, to show once. */
  problem: string | null
}

interface Opened {
  summary: PoolSummary
  keyring: PoolKeyring | null
  secret: PoolMemberSecret | null
  vault: PoolVault | null
  state: PoolState | null
  conflicts: Set<string>
  problem: string | null
}

export interface PoolWatchOptions {
  api: PoolApi
  accountKey: AccountKey
  /** This account's id: public keys are bound to it. */
  account: string
  relay: string
  link: PoolLink
  onChange: () => void
}

export class PoolWatch {
  private listed: ListedPool[] = []
  private readonly opened = new Map<string, Opened>()
  /** Updates are opened one after the other, in the order they came. */
  private queue: Promise<void> = Promise.resolve()
  private listProblem: string | null = null

  constructor(private readonly options: PoolWatchOptions) {}

  get pools(): readonly ListedPool[] {
    return this.listed
  }

  get problem(): string | null {
    return this.listProblem
  }

  pool(poolId: string): OpenPool | null {
    const opened = this.opened.get(poolId)
    if (!opened) return null
    return { id: poolId, role: opened.summary.role, state: opened.state, conflicts: opened.conflicts, problem: opened.problem }
  }

  /** The pools of the account, each with its name opened with the member's keys. */
  async refresh(): Promise<void> {
    try {
      const summaries = await this.options.api.list()
      this.listed = await Promise.all(summaries.map(async summary => ({ summary, info: await this.infoOf(summary) })))
      this.listProblem = null
      for (const summary of summaries) {
        const opened = this.opened.get(summary.id)
        if (opened) opened.summary = summary
      }
    } catch (error) {
      this.listProblem = messageOf(error)
    }
    this.options.onChange()
  }

  /** Follows a pool live: its snapshot, then each change. */
  open(poolId: string) {
    const summary = this.listed.find(pool => pool.summary.id === poolId)?.summary
    if (!summary || this.opened.has(poolId)) return
    this.opened.set(poolId, { summary, keyring: null, secret: null, vault: null, state: null, conflicts: new Set(), problem: null })
    this.options.link.subscribePool(poolId)
    this.options.onChange()
  }

  close(poolId: string) {
    if (!this.opened.delete(poolId)) return
    this.options.link.unsubscribePool(poolId)
    this.options.onChange()
  }

  /** What the relay client hands over from `onPoolUpdate`. */
  handle(update: PoolUpdate): Promise<void> {
    this.queue = this.queue.then(() => this.apply(update)).catch(() => {})
    return this.queue
  }

  // MARK: Pools

  async create(info: PoolInfo, profile?: PoolMemberProfile): Promise<string | null> {
    return this.act(async () => {
      const { pool } = await this.options.api.create(this.options.accountKey, this.options.account, info, profile)
      await this.refresh()
      return pool.id
    })
  }

  /** Joins with a pasted or scanned invite. */
  async join(text: string, profile?: PoolMemberProfile): Promise<string | null> {
    const invite = parsePoolInvite(text)
    if (!invite) {
      this.listProblem = 'This is not a pool invite: it starts with tontonpool1.'
      this.options.onChange()
      return null
    }
    if (new URL(invite.relay).origin !== new URL(this.options.relay).origin) {
      this.listProblem = `This invite is for another relay: ${new URL(invite.relay).host}.`
      this.options.onChange()
      return null
    }
    return this.act(async () => {
      const pool = await this.options.api.join(this.options.accountKey, this.options.account, invite, profile)
      await this.refresh()
      return pool.id
    })
  }

  leave(poolId: string) {
    return this.act(async () => {
      await this.options.api.leave(poolId)
      this.close(poolId)
      await this.refresh()
      return true
    })
  }

  remove(poolId: string) {
    return this.act(async () => {
      await this.options.api.remove(poolId)
      this.close(poolId)
      await this.refresh()
      return true
    })
  }

  /** Owner and admins: a new name and goal, sealed with the latest key. */
  async updateInfo(poolId: string, info: PoolInfo): Promise<boolean> {
    const opened = this.opened.get(poolId)
    if (!opened?.vault) return false
    return this.options.link.sendPool({ t: 'pool_info', poolId, info: await opened.vault.seal(info) })
  }

  /** This member's own name in the pool. */
  async updateProfile(poolId: string, profile: PoolMemberProfile): Promise<boolean> {
    const opened = this.opened.get(poolId)
    if (!opened?.vault) return false
    return this.options.link.sendPool({ t: 'pool_profile', poolId, profile: await opened.vault.seal(profile) })
  }

  // MARK: Invites and members

  /** A new invite, as the link to share, sealed with the pool key it holds now. */
  invite(poolId: string, options: { uses: number; hours: number; role: Exclude<PoolRole, 'owner'> }) {
    return this.act(async () => {
      const opened = this.opened.get(poolId)
      const keyring = opened?.keyring
      const key = keyring?.key(keyring.version)
      if (!keyring || !key) throw new Error('The pool is still opening: try again in a moment.')
      const created = await this.options.api.createInvite(poolId, options)
      return {
        ...created,
        link: formatPoolInvite({ relay: this.options.relay, pool: poolId, token: created.token, key, version: keyring.version }),
      }
    })
  }

  invites(poolId: string): Promise<InviteSummary[] | null> {
    return this.act(() => this.options.api.invites(poolId))
  }

  revokeInvite(poolId: string, inviteId: string) {
    return this.act(async () => {
      await this.options.api.revokeInvite(poolId, inviteId)
      return true
    })
  }

  setRole(poolId: string, account: string, role: Exclude<PoolRole, 'owner'>) {
    return this.act(async () => {
      await this.options.api.setRole(poolId, account, role)
      return true
    })
  }

  transferOwnership(poolId: string, account: string) {
    return this.act(async () => {
      await this.options.api.transferOwnership(poolId, account)
      await this.refresh()
      return true
    })
  }

  /** Kicks a member and rotates the pool key; the new snapshot is read with it. Returns who needs a new invite. */
  kick(poolId: string, member: string) {
    return this.act(async () => {
      const { skipped } = await this.options.api.kick(this.options.accountKey, this.options.account, poolId, member)
      await this.refresh()
      this.options.link.subscribePool(poolId)
      return skipped
    })
  }

  // MARK: Tasks

  /**
   * Creates the task when `id` is null, else replaces it over the revision this member saw. The relay refuses a change
   * over an older revision: the board then shows the current task, marked as changed meanwhile.
   */
  async saveTask(poolId: string, id: string | null, task: PoolTask): Promise<string | null> {
    const opened = this.opened.get(poolId)
    if (!opened?.vault || !opened.state) return null
    const known = id ? opened.state.tasks.find(item => item.id === id) : undefined
    const taskId = id ?? newPoolItemId()
    const sent = this.options.link.sendPool({
      t: 'pool_task',
      poolId,
      id: taskId,
      rev: known?.rev ?? 0,
      blob: await opened.vault.seal(task),
    })
    if (!sent) {
      opened.problem = 'Not connected to the relay: the task was not saved.'
      this.options.onChange()
      return null
    }
    opened.conflicts.delete(taskId)
    const event = taskEvent(known?.task ?? null, task, taskId)
    this.options.link.sendPool({ t: 'pool_event', poolId, id: newPoolItemId(), blob: await opened.vault.seal(event) })
    return taskId
  }

  clearProblem(poolId?: string) {
    if (poolId) {
      const opened = this.opened.get(poolId)
      if (opened) opened.problem = null
    } else this.listProblem = null
    this.options.onChange()
  }

  // MARK: Updates

  private async apply(update: PoolUpdate) {
    const poolId = update.t === 'pool_snapshot' ? update.pool.id : update.poolId
    const opened = this.opened.get(poolId)
    if (!opened) return
    if (update.t === 'pool_snapshot') {
      await this.unlock(opened, update.pool.members, update.pool.own)
      opened.state = opened.vault ? await opened.vault.snapshot(update.pool) : null
      opened.conflicts.clear()
      await this.republish(poolId, opened)
    } else if (update.t === 'pool_key') {
      // A rotation: the new key opens what is written from now on. A new snapshot reads everything with it.
      this.options.link.subscribePool(poolId)
      return
    } else if (update.t === 'pool_removed') {
      this.opened.delete(poolId)
      await this.refresh()
      return
    } else if (update.t === 'pool_error') {
      opened.problem = update.message
    } else if (update.t === 'pool_conflict') {
      if (update.kind === 'task' && update.id && update.current && opened.state && opened.vault) {
        opened.conflicts.add(update.id)
        opened.state = await opened.vault.apply(opened.state, { t: 'pool_task', poolId, task: update.current as PoolTaskWire })
      }
    } else if (opened.state && opened.vault) {
      const next = await opened.vault.apply(opened.state, update)
      if (!next) {
        this.opened.delete(poolId)
        await this.refresh()
        return
      }
      opened.state = next
      if (update.t === 'pool_info') {
        const listed = this.listed.find(pool => pool.summary.id === poolId)
        if (listed) listed.info = next.info
      }
    }
    this.options.onChange()
  }

  /** The keys of the pool: the member's own copy, then every later version wrapped for it that opens. */
  private async unlock(opened: Opened, members: Parameters<typeof resolvePoolKeyring>[0]['members'], own: PoolState['own'] | undefined) {
    const { summary } = opened
    const grant = await openPoolGrant(this.options.accountKey, summary.key, summary.id)
    if (!grant) {
      opened.problem = 'The pool key does not open with this account key.'
      return
    }
    const { keyring, secret } = await resolvePoolKeyring({
      accountKey: this.options.accountKey,
      poolId: summary.id,
      account: this.options.account,
      grant,
      secret: own?.secret ?? summary.secret,
      wraps: own?.wraps ?? summary.wraps,
      members,
    })
    opened.keyring = keyring
    opened.secret = secret
    opened.vault = new PoolVault(keyring)
  }

  /** After a rotation, publishes this member's public key under the new version, so admins can wrap the next one. */
  private async republish(poolId: string, opened: Opened) {
    const me = opened.state?.members.find(member => member.account === this.options.account)
    if (!opened.keyring || !opened.secret || !me || !needsRepublish(opened.keyring, me.publicKeys)) return
    this.options.link.sendPool({
      t: 'pool_member_key',
      poolId,
      publicKey: await sealPoolMemberKey(opened.keyring, poolId, this.options.account, opened.secret),
      secret: await sealPoolMemberSecret(this.options.accountKey, opened.secret),
    })
  }

  private async infoOf(summary: PoolSummary): Promise<PoolInfo | null> {
    const opened = this.opened.get(summary.id)
    if (opened?.state) return opened.state.info
    const grant = await openPoolGrant(this.options.accountKey, summary.key, summary.id)
    if (!grant) return null
    // The name may be sealed with a later key: the members' public keys open the wraps.
    const members = summary.wraps.length ? await this.options.api.members(summary.id).catch(() => []) : []
    const { keyring } = await resolvePoolKeyring({
      accountKey: this.options.accountKey,
      poolId: summary.id,
      account: this.options.account,
      grant,
      secret: summary.secret,
      wraps: summary.wraps,
      members,
    })
    return new PoolVault(keyring).read(summary.info, decodePoolInfo)
  }

  /** Runs an action, keeping what the relay said when it refuses. */
  private async act<T>(run: () => Promise<T>): Promise<T | null> {
    try {
      return await run()
    } catch (error) {
      this.listProblem = messageOf(error)
      this.options.onChange()
      return null
    }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // Relays from before pools answer 404 to every pool route.
    if ('status' in error && error.status === 404 && error.message === 'not found') return 'This relay has no pools yet: it needs updating.'
    return error.message
  }
  return String(error)
}
