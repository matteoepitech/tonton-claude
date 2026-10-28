// Browsers reject native fetch with a class instance as its receiver; Bun alone does not catch that.
import { expect, test } from 'bun:test'
import { newAccountKey } from '../crypto'
import { RPGClient } from '../rpg-client'

test('the default transport never binds native fetch to the RPG client', async () => {
  const original = globalThis.fetch
  const browserFetch = function (this: unknown): Promise<Response> {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
    return Promise.resolve(Response.json({ rev: 0, blob: null }))
  }
  globalThis.fetch = Object.assign(browserFetch, { preconnect: original.preconnect })
  try {
    const client = new RPGClient('https://example.test/api/rpg', 'test', newAccountKey())
    expect((await client.read()).state.xp).toBe(0)
  } finally {
    globalThis.fetch = original
  }
})
