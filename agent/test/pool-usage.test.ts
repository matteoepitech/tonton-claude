import { expect, test } from 'bun:test'
import type { PoolUsage } from '../../shared/pool-protocol'
import { poolUsage, UsageSharing, usageMark } from '../src/channel/pool-usage'

test("a session's meta becomes what the pool sees: cache counted in, the windows as they are", () => {
  expect(
    poolUsage({
      costUSD: 2.5,
      tokens: { input: 1000, output: 200, cacheRead: 50_000, cacheWrite: 3000 },
      fiveHourLimit: { usedPercent: 61, resetsAt: '2026-10-27T18:00:00.000Z' },
    }),
  ).toEqual({ costUSD: 2.5, tokens: { input: 54_000, output: 200 }, fiveHour: { usedPercent: 61, resetsAt: '2026-10-27T18:00:00.000Z' } })
  // OpenCode: no plan windows.
  expect(poolUsage({ costUSD: 0.1 })).toEqual({ costUSD: 0.1 })
  expect(poolUsage({})).toBeUndefined()
})

test('readings that would show the same have the same mark', () => {
  const a: PoolUsage = { costUSD: 1.231, tokens: { input: 52_100, output: 999 }, fiveHour: { usedPercent: 40.2 } }
  const b: PoolUsage = { costUSD: 1.229, tokens: { input: 51_900, output: 1001 }, fiveHour: { usedPercent: 39.8 } }
  expect(usageMark(a)).toBe(usageMark(b))
  expect(usageMark({ ...a, costUSD: 1.26 })).not.toBe(usageMark(a))
})

test('posts at once, then at most once a minute with the latest reading, and nothing for a reading already posted', async () => {
  let now = 0
  const posted: [string, PoolUsage][] = []
  const sharing = new UsageSharing(
    (poolId, usage) => posted.push([poolId, usage]),
    () => now,
    40,
  )
  sharing.share('p1', { costUSD: 1 })
  expect(posted).toEqual([['p1', { costUSD: 1 }]])
  now = 10
  sharing.share('p1', { costUSD: 2 })
  sharing.share('p1', { costUSD: 3 })
  // Another pool keeps its own pace.
  sharing.share('p2', { costUSD: 9 })
  expect(posted).toHaveLength(2)
  now = 50
  await Bun.sleep(60)
  expect(posted.slice(2)).toEqual([['p1', { costUSD: 3 }]])
  // Back to what was posted last: nothing to say.
  now = 200
  sharing.share('p1', { costUSD: 3 })
  expect(posted).toHaveLength(3)
  // Leaving the pool forgets it: joining again posts at once.
  sharing.forget('p1')
  sharing.share('p1', { costUSD: 3 })
  expect(posted).toHaveLength(4)
})
