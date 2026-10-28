// Sealed, durable work rewards. Gameplay failure must never stop a coding session.
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { open, seal } from '../../shared/crypto'
import type { PoolState } from '../../shared/pool'
import type { Entry } from '../../shared/protocol'
import { awardRPG, isRPGReward, type RPGReward, rpgReward } from '../../shared/rpg'
import { RPGClient } from '../../shared/rpg-client'
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
  private readonly seen = new Set<string>()

  constructor(
    private readonly config: AgentConfig,
    home = paths.home,
  ) {
    const identity = createHash('sha256').update(`${config.server}\n${config.key}`).digest('hex')
    this.directory = join(home, 'rpg', identity)
    this.client = new RPGClient(`${config.server}/api/agent/rpg`, config.token, config.key)
    this.timer = setInterval(() => this.flush(), 15_000)
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

  pool(poolId: string, state: PoolState, sessionId: string) {
    const account = this.config.account ?? state.sessions.find(session => session.session === sessionId)?.account
    if (!account) return
    this.enqueue(async () => {
      for (const item of state.tasks) {
        const completion = item.task?.completion
        if (!completion || typeof completion.at !== 'string' || typeof completion.assignee?.account !== 'string') continue
        if (completion.assignee.account === account) await this.save(await rpgReward('poolTask', `${poolId}\n${item.id}`, completion.at))
        if (completion.reviewer?.account === account) await this.save(await rpgReward('review', `${poolId}\n${item.id}`, completion.at))
      }
      this.flush()
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
    await this.client.change(state => pending.reduce(awardRPG, state))
    for (const reward of pending) {
      try {
        unlinkSync(join(this.directory, reward.id))
      } catch {}
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
