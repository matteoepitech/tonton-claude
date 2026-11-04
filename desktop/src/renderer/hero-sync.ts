// The island's copy of the account's hero, kept fresh. Its sealed document goes through the main process, which adds the
// relay token (src/main/relay-api.ts): the page opens and seals the blob with the account key, as the website does, and
// never holds the token. Changes are the client core's compare-and-swap transactions (shared/rpg-client.ts).

import { RPGClient, type RPGState, RPGUnavailable } from '../../../shared'
import type { IslandBridge } from '../bridge'

/** The Mac refreshes every three seconds and the website every five; an island in a corner of the screen can wait more. */
const REFRESH_MS = 10_000
const NO_BODY = new Set([204, 205, 304])

export class HeroSync {
  hero: RPGState | null = null
  /** The relay is older than progression: the island shows no ring, sessions work as before. */
  unavailable = false
  problem: string | null = null
  /** A change is being saved: the page disables what would start another. */
  busy = false
  private reading = false
  private rev = -1
  /** Counts saved changes: a reading that started before one is older than what the island shows. */
  private saves = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private readonly client: RPGClient

  constructor(
    key: CryptoKey,
    bridge: Pick<IslandBridge, 'rpg'>,
    private readonly onChange: (before: RPGState | null) => void,
  ) {
    // The URL and the token are the main process's: it only ever calls the account's own /api/rpg.
    this.client = new RPGClient('island:/api/rpg', '', key, async (_input, init) => {
      const method = init?.method === 'PUT' ? 'PUT' : 'GET'
      const answer = await bridge.rpg(method === 'PUT' ? { method, body: String(init?.body ?? '') } : { method })
      if (!answer || answer.status < 200 || answer.status > 599) throw new Error('The relay could not be reached')
      // A Response refuses a body, even empty, with the statuses that have none.
      return new Response(NO_BODY.has(answer.status) ? null : answer.body, { status: answer.status })
    })
  }

  start() {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS)
  }

  stop() {
    this.stopped = true
    clearInterval(this.timer)
  }

  async refresh() {
    if (this.reading || this.busy || this.stopped || this.unavailable) return
    this.reading = true
    const saves = this.saves
    try {
      const { document, state } = await this.client.read()
      if (this.stopped || this.busy || saves !== this.saves) return
      if (document.rev === this.rev) {
        // The same hero, but the relay answers again: what went wrong before is over.
        if (this.problem) {
          this.problem = null
          this.onChange(this.hero)
        }
        return
      }
      this.rev = document.rev
      this.set(state)
    } catch (error) {
      if (this.stopped) return
      if (error instanceof RPGUnavailable) this.unavailable = true
      else this.problem = 'Could not sync Tonton.'
      this.onChange(this.hero)
    } finally {
      this.reading = false
    }
  }

  /** Null when another change is still being saved, or when this one failed: the island then says so. */
  async change(apply: (hero: RPGState) => RPGState): Promise<RPGState | null> {
    if (this.busy || this.stopped || !this.hero) return null
    this.busy = true
    this.onChange(this.hero)
    try {
      const next = await this.client.change(apply)
      this.saves++
      if (this.stopped) return null
      // The next reading has a new revision: it shows the same hero again, so it is not news.
      this.rev = -1
      this.set(next)
      return next
    } catch {
      // The transaction may have reached the relay before the answer was lost: read the hero again whatever its revision.
      this.rev = -1
      if (!this.stopped) this.problem = 'Could not save. Check the connection and try again.'
      return null
    } finally {
      this.busy = false
      // Not busy any more: the page enables its buttons again.
      if (!this.stopped) this.onChange(this.hero)
    }
  }

  private set(state: RPGState) {
    const before = this.hero
    this.hero = state
    this.problem = null
    this.onChange(before)
  }
}
