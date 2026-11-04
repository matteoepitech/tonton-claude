// Sealed, durable work rewards. Gameplay failure must never stop a coding session.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { open, seal } from '../../shared/crypto'
import type { PoolState } from '../../shared/pool'
import type { PoolKeyring } from '../../shared/pool-keys'
import { awardRPG, isRPGReward, type RPGReward, rpgReward } from '../../shared/rpg'
import { RPGClient } from '../../shared/rpg-client'
import { claimRPGMilestones } from '../../shared/rpg-loot'
import { claimRPGTeam, RPGPoolClient, syncRPGPool } from '../../shared/rpg-pool'
import { type AgentConfig, paths } from './config'
import { type BackfillSources, backfillRewards, backfillSources } from './rpg-backfill'
import { RPGLedger } from './rpg-ledger'
import { type SessionWork, workRewards } from './rpg-work'

/** Rewards sent to the hero in one transaction. The backfill brings a few thousand: they go oldest first, in batches. */
const DRAIN_BATCH = 500
/** Pending rewards kept on disk at most, as before. */
const PENDING_LIMIT = 10_000
/** Written once the welcome backfill of rules version 2 is done for this relay and account. */
const BACKFILL_DONE = 'backfill-v2'
/** A backfill that held its lock this long died: another process may take over. */
const BACKFILL_STALE_MS = 30 * 60_000

export class AgentRPG {
  private readonly directory: string
  private readonly client: RPGClient
  private queue = Promise.resolve()
  private draining: Promise<void> | null = null
  private readonly timer: ReturnType<typeof setInterval>
  private readonly poolPending = new Map<string, { state: PoolState; keys: PoolKeyring; account: string }>()
  private syncingPools = false
  private readonly seen = new Set<string>()
  private readonly ledger: RPGLedger

  constructor(
    private readonly config: AgentConfig,
    home = paths.home,
  ) {
    const identity = createHash('sha256').update(`${config.server}\n${config.key}`).digest('hex')
    this.directory = join(home, 'rpg', identity)
    this.client = new RPGClient(`${config.server}/api/agent/rpg`, config.token, config.key)
    this.ledger = new RPGLedger(this.directory, config.key)
    this.timer = setInterval(() => {
      this.flush()
      void this.syncPools()
    }, 15_000)
    this.timer.unref?.()
    this.flush()
  }

  /**
   * Turns, pushes and checklist tasks of a session. Pool sessions earn their turns and pushes too: their checklist is the
   * pool's, so `inPool` leaves it out, and a turn a pool post started earns work time only.
   */
  work(session: string, work: SessionWork, inPool: boolean) {
    if (!work.turns?.length && !work.tasks?.length && !work.vcs?.length) return
    this.enqueue(async () => {
      await this.saveAll(await workRewards(session, work, inPool))
      this.flush()
    })
  }

  /** Rewards already made, such as the backfill's. Fails when one could not be kept, so the backfill runs again. */
  earn(rewards: readonly RPGReward[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.enqueue(async () => {
        try {
          const dropped = await this.saveAll(rewards)
          this.flush()
          if (dropped) reject(new Error('No room left for pending rewards'))
          else resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  /**
   * The welcome backfill, once per relay and account on this machine: two weeks of Claude Code and OpenCode work, as
   * pending rewards like any other. False when it already ran, or another process of the machine is running it.
   */
  async backfill(sources: BackfillSources = backfillSources(), now = Date.now()): Promise<boolean> {
    const done = join(this.directory, BACKFILL_DONE)
    const lock = `${done}.lock`
    if (existsSync(done)) return false
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
    } catch {
      try {
        if (now - statSync(lock).mtimeMs < BACKFILL_STALE_MS) return false
        writeFileSync(lock, String(process.pid), { mode: 0o600 })
      } catch {
        return false
      }
    }
    try {
      await this.earn(await backfillRewards(sources, now))
      writeFileSync(done, new Date(now).toISOString(), { mode: 0o600 })
      return true
    } finally {
      rmSync(lock, { force: true })
    }
  }

  pool(poolId: string, state: PoolState, sessionId: string, keys?: PoolKeyring) {
    const account = this.config.account ?? state.sessions.find(session => session.session === sessionId)?.account
    if (!account) return
    if (keys) this.poolPending.set(poolId, { state, keys, account })
    this.enqueue(async () => {
      if (keys) {
        const directory = this.poolDirectory(poolId)
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        for (const item of state.tasks) {
          if (!item.task?.completion) continue
          const path = join(directory, createHash('sha256').update(item.id).digest('hex'))
          if (existsSync(path) || readdirSync(directory).length >= 10_000) continue
          const temporary = `${path}.${crypto.randomUUID()}.tmp`
          writeFileSync(temporary, await seal(this.config.key, { id: item.id, completion: item.task.completion }), {
            flag: 'wx',
            mode: 0o600,
          })
          renameSync(temporary, path)
        }
      }
      const rewards: RPGReward[] = []
      for (const item of state.tasks) {
        const completion = item.task?.completion
        if (!completion || typeof completion.at !== 'string' || typeof completion.assignee?.account !== 'string') continue
        if (completion.assignee.account === account) rewards.push(await rpgReward('poolTask', `${poolId}\n${item.id}`, completion.at))
        if (completion.reviewer?.account === account) rewards.push(await rpgReward('review', `${poolId}\n${item.id}`, completion.at))
      }
      await this.saveAll(rewards)
      this.flush()
      void this.syncPools()
    })
  }

  private enqueue(work: () => Promise<void>) {
    // No decrypted content or transport error body is logged.
    this.queue = this.queue.then(work).catch(() => {})
  }
  /** Seals each reward not known yet. Returns how many found no room: the folder keeps PENDING_LIMIT files at most. */
  private async saveAll(rewards: readonly RPGReward[]): Promise<number> {
    if (!rewards.length) return 0
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    let room = PENDING_LIMIT - readdirSync(this.directory).length
    let dropped = 0
    for (const reward of rewards) {
      if (!isRPGReward(reward) || this.seen.has(reward.id) || (await this.ledger.has(reward.id))) continue
      if (room <= 0) {
        dropped++
        continue
      }
      const blob = await seal(this.config.key, reward)
      // A killed process can leave a temporary file, never a half-written reward that blocks future retries.
      const temporary = join(this.directory, `${reward.id}.${crypto.randomUUID()}.tmp`)
      writeFileSync(temporary, blob, { flag: 'wx', mode: 0o600 })
      renameSync(temporary, join(this.directory, reward.id))
      room--
      if (this.seen.size >= 10_000) this.seen.clear()
      this.seen.add(reward.id)
    }
    return dropped
  }
  private async drain() {
    let files: string[]
    try {
      files = readdirSync(this.directory)
    } catch {
      return
    }
    const pending: RPGReward[] = []
    for (const file of files.filter(file => /^[a-f0-9]{64}$/.test(file)).slice(0, PENDING_LIMIT)) {
      try {
        const reward = await open<unknown>(this.config.key, readFileSync(join(this.directory, file), 'utf8'))
        if (isRPGReward(reward) && reward.id === file) pending.push(reward)
      } catch {
        /* Another process may have committed this receipt already. */
      }
    }
    await this.ledger.reload()
    const fresh: RPGReward[] = []
    for (const reward of pending) {
      if (!(await this.ledger.has(reward.id))) fresh.push(reward)
      else
        try {
          unlinkSync(join(this.directory, reward.id))
        } catch {}
    }
    // Oldest first: a day's streak looks at the days before it, and each day fills its own cap in the order it was earned.
    fresh.sort((a, b) => (a.at ?? a.day).localeCompare(b.at ?? b.day) || a.id.localeCompare(b.id))
    for (let start = 0; start < fresh.length; start += DRAIN_BATCH) {
      const batch = fresh.slice(start, start + DRAIN_BATCH)
      await this.client.change(state => claimRPGMilestones(batch.reduce(awardRPG, state)))
      // A reward that earned nothing (a full day, a day past the horizon) is done too: sending it again earns nothing.
      await this.ledger.add(batch)
      for (const reward of batch) {
        try {
          unlinkSync(join(this.directory, reward.id))
        } catch {}
      }
    }
  }
  private poolDirectory(id: string) {
    return join(this.directory, `pool-${createHash('sha256').update(id).digest('hex')}`)
  }
  private async syncPools() {
    if (this.syncingPools) return
    this.syncingPools = true
    try {
      for (const [id, pending] of this.poolPending) {
        try {
          const { state: hero } = await this.client.read()
          const client = new RPGPoolClient(`${this.config.server}/api/agent/pools/${id}/rpg`, this.config.token, pending.keys)
          const archived: Record<string, NonNullable<PoolState['tasks'][number]['task']>['completion']> = {}
          try {
            const directory = this.poolDirectory(id)
            for (const file of readdirSync(directory)
              .filter(name => /^[a-f0-9]{64}$/.test(name))
              .slice(0, 10_000)) {
              const record = await open<{ id: string; completion: (typeof archived)[string] }>(
                this.config.key,
                readFileSync(join(directory, file), 'utf8'),
              )
              archived[record.id] = record.completion
            }
          } catch {
            /* The live snapshot still syncs when no archive has been written yet. */
          }
          const ledger = await client.change(ledger => {
            const completions = { ...archived, ...ledger.completions } as typeof ledger.completions
            return syncRPGPool({ ...ledger, completions }, pending.state, pending.account, hero)
          })
          await this.client.change(hero => claimRPGMilestones(claimRPGTeam(hero, ledger, pending.account)))
        } catch {
          /* The next timer retries; failures never interrupt work or expose plaintext. */
        }
      }
    } finally {
      this.syncingPools = false
    }
  }
  flush() {
    if (!this.draining)
      this.draining = this.drain()
        .catch(() => {})
        .finally(() => {
          this.draining = null
        })
  }
  async settled() {
    await this.queue
    await this.draining
  }
  stop() {
    clearInterval(this.timer)
  }
}
