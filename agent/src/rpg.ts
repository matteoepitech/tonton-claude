// Sealed, durable work rewards. Gameplay failure must never stop a coding session.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { open, seal } from '../../shared/crypto'
import type { PoolState } from '../../shared/pool'
import type { PoolKeyring } from '../../shared/pool-keys'
import type { Entry } from '../../shared/protocol'
import { awardRPG, isRPGReward, type RPGReward, rpgReward } from '../../shared/rpg'
import { RPGClient } from '../../shared/rpg-client'
import { claimRPGMilestones } from '../../shared/rpg-loot'
import { claimRPGTeam, RPGPoolClient, syncRPGPool } from '../../shared/rpg-pool'
import { type AgentConfig, paths } from './config'

/** Only successful checklist writes count; an assistant response or an idle status is not a task. */
export async function taskRewards(session: string, entries: readonly Entry[], results: readonly Entry[] = entries): Promise<RPGReward[]> {
  const succeeded = new Set(
    results.filter(e => e.kind === 'tool_result' && !e.isError).map(e => (e.kind === 'tool_result' ? e.toolUseId : '')),
  )
  const rewards: RPGReward[] = []
  for (const entry of entries) {
    if (entry.kind !== 'tool' || entry.name !== 'TodoWrite' || !succeeded.has(entry.toolUseId)) continue
    for (const todo of entry.todos ?? []) {
      if (todo.status !== 'completed' || !todo.content.trim()) continue
      const content = todo.content.trim().replace(/\s+/g, ' ')
      rewards.push(await rpgReward('task', `${session}\n${content}`, entry.ts))
    }
  }
  return rewards.filter(isRPGReward)
}

export class AgentRPG {
  private readonly directory: string
  private readonly client: RPGClient
  private queue = Promise.resolve()
  private draining: Promise<void> | null = null
  private readonly timer: ReturnType<typeof setInterval>
  private readonly poolPending = new Map<string, { state: PoolState; keys: PoolKeyring; account: string }>()
  private syncingPools = false
  private readonly seen = new Set<string>()

  constructor(
    private readonly config: AgentConfig,
    home = paths.home,
  ) {
    const identity = createHash('sha256').update(`${config.server}\n${config.key}`).digest('hex')
    this.directory = join(home, 'rpg', identity)
    this.client = new RPGClient(`${config.server}/api/agent/rpg`, config.token, config.key)
    this.timer = setInterval(() => {
      this.flush()
      void this.syncPools()
    }, 15_000)
    this.timer.unref?.()
    this.flush()
  }

  observe(session: string, entries: readonly Entry[], inPool: boolean, results: readonly Entry[] = entries) {
    if (inPool || !results.some(entry => entry.kind === 'tool_result' && !entry.isError)) return
    this.enqueue(async () => {
      for (const reward of await taskRewards(session, entries, results)) await this.save(reward)
      this.flush()
    })
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
      for (const item of state.tasks) {
        const completion = item.task?.completion
        if (!completion || typeof completion.at !== 'string' || typeof completion.assignee?.account !== 'string') continue
        if (completion.assignee.account === account) await this.save(await rpgReward('poolTask', `${poolId}\n${item.id}`, completion.at))
        if (completion.reviewer?.account === account) await this.save(await rpgReward('review', `${poolId}\n${item.id}`, completion.at))
      }
      this.flush()
      void this.syncPools()
    })
  }

  private enqueue(work: () => Promise<void>) {
    // No decrypted content or transport error body is logged.
    this.queue = this.queue.then(work).catch(() => {})
  }
  private async save(reward: RPGReward) {
    if (!isRPGReward(reward) || this.seen.has(reward.id)) return
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if (readdirSync(this.directory).length >= 10_000) return
    const blob = await seal(this.config.key, reward)
    // A killed process can leave a temporary file, never a half-written reward that blocks future retries.
    const temporary = join(this.directory, `${reward.id}.${crypto.randomUUID()}.tmp`)
    writeFileSync(temporary, blob, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, join(this.directory, reward.id))
    if (this.seen.size >= 10_000) this.seen.clear()
    this.seen.add(reward.id)
  }
  private async drain() {
    let files: string[]
    try {
      files = readdirSync(this.directory)
    } catch {
      return
    }
    const pending: RPGReward[] = []
    for (const file of files.filter(file => /^[a-f0-9]{64}$/.test(file)).slice(0, 100)) {
      try {
        const reward = await open<unknown>(this.config.key, readFileSync(join(this.directory, file), 'utf8'))
        if (isRPGReward(reward) && reward.id === file) pending.push(reward)
      } catch {
        /* Another process may have committed this receipt already. */
      }
    }
    if (!pending.length) return
    await this.client.change(state => claimRPGMilestones(pending.reduce(awardRPG, state)))
    for (const reward of pending) {
      try {
        unlinkSync(join(this.directory, reward.id))
      } catch {}
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
