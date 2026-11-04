// The rewards this machine already committed to the hero, sealed on disk for as long as the hero keeps its gains. An app
// older than rules version 2 drops `gains` when it rewrites the hero: without this record, a transcript read again would
// pay its turns twice.

import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { open, seal } from '../../shared/crypto'
import { RPG_GAIN_DAYS, type RPGReward, rpgShiftDay } from '../../shared/rpg'

export const LEDGER_FILE = 'committed'
/** Held while one process merges its ids into the file. A process killed while holding it leaves it this long at most. */
const LOCK_STALE_MS = 10_000
const LOCK_TRIES = 40
/** Far more than RPG_GAINS_PER_DAY × RPG_GAIN_DAYS: version 1 receipts are recorded too. */
const LIMIT = 50_000

export class RPGLedger {
  private ids: Map<string, string> | null = null

  constructor(
    private readonly directory: string,
    private readonly key: string,
  ) {}

  async has(id: string): Promise<boolean> {
    this.ids ??= await this.read()
    return this.ids.has(id)
  }

  /** Reads again what every process of the machine committed. */
  async reload() {
    this.ids = new Map([...(this.ids ?? []), ...(await this.read())])
  }

  /** Several processes of the machine commit rewards: what another one recorded meanwhile is kept. */
  async add(rewards: readonly RPGReward[], now = Date.now()) {
    if (!rewards.length) return
    const locked = await this.lock()
    try {
      await this.merge(rewards, now)
    } finally {
      if (locked)
        try {
          rmdirSync(this.lockPath())
        } catch {}
    }
  }

  private async merge(rewards: readonly RPGReward[], now: number) {
    const ids = new Map([...(await this.read()), ...(this.ids ?? [])])
    for (const reward of rewards) ids.set(reward.id, reward.day)
    const oldest = rpgShiftDay(new Date(now).toISOString().slice(0, 10), -RPG_GAIN_DAYS)
    const kept = [...ids]
      .filter(([, day]) => day >= oldest)
      .sort(([, a], [, b]) => a.localeCompare(b))
      .slice(-LIMIT)
    this.ids = new Map(kept)
    const temporary = join(this.directory, `${LEDGER_FILE}.${crypto.randomUUID()}.tmp`)
    writeFileSync(temporary, await seal(this.key, Object.fromEntries(kept)), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, join(this.directory, LEDGER_FILE))
  }

  private lockPath() {
    return join(this.directory, `${LEDGER_FILE}.lock`)
  }

  /** Best effort: after a second, the merge goes on without it, and at worst loses another process's latest ids. */
  private async lock(): Promise<boolean> {
    for (let attempt = 0; attempt < LOCK_TRIES; attempt++) {
      try {
        mkdirSync(this.lockPath())
        return true
      } catch {
        try {
          if (Date.now() - statSync(this.lockPath()).mtimeMs > LOCK_STALE_MS) rmdirSync(this.lockPath())
        } catch {}
        await Bun.sleep(25)
      }
    }
    return false
  }

  private async read(): Promise<Map<string, string>> {
    try {
      const record = await open<unknown>(this.key, readFileSync(join(this.directory, LEDGER_FILE), 'utf8'))
      if (!record || typeof record !== 'object' || Array.isArray(record)) return new Map()
      return new Map(Object.entries(record).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
    } catch {
      // None yet, or unreadable: the hero's own receipts still catch most replays.
      return new Map()
    }
  }
}
