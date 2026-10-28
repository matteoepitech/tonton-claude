// Encrypted compare-and-swap transactions. A timeout can be retried with the same reward id on any device.
import { type AccountKey, open, seal } from './crypto'
import { newRPGState, parseRPGState, type RPGDocument, type RPGState } from './rpg'

export class RPGUnavailable extends Error {}
export class RPGClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly key: AccountKey,
    private readonly request: typeof fetch = fetch,
  ) {}

  async read(): Promise<{ document: RPGDocument; state: RPGState }> {
    const response = await this.request(this.url, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 404) throw new RPGUnavailable('Update the relay to enable RPG')
    if (!response.ok) throw new Error(`Hero request failed (${response.status})`)
    const document = (await response.json()) as RPGDocument
    if (
      !Number.isSafeInteger(document.rev) ||
      document.rev < 0 ||
      (document.blob !== null && typeof document.blob !== 'string') ||
      (document.rev === 0) !== (document.blob === null)
    )
      throw new Error('Invalid hero document')
    return { document, state: document.blob === null ? newRPGState() : parseRPGState(await open(this.key, document.blob)) }
  }

  async change(apply: (state: RPGState) => RPGState): Promise<RPGState> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { document, state } = await this.read()
      const next = apply(state)
      if (next === state || JSON.stringify(next) === JSON.stringify(state)) return state
      parseRPGState(next)
      const response = await this.request(this.url, {
        method: 'PUT',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ rev: document.rev, blob: await seal(this.key, next) }),
        signal: AbortSignal.timeout(15_000),
      })
      if (response.status === 409) continue
      if (!response.ok) throw new Error(`Hero update failed (${response.status})`)
      return next
    }
    throw new Error('Hero is busy; retry the same operation')
  }
}
