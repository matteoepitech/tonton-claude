import { expect, test } from 'bun:test'
import type { PoolUsage } from '../../shared/pool-protocol'
import { poolUsage, UsageSharing, usageMark } from '../src/channel/pool-usage'

const tokens = (input: number): PoolUsage => ({ tokens: { input, output: 0 } })

test("a session's meta becomes what the pool sees: cache counted in, the windows as they are, the cost left to spend events", () => {
  expect(
    poolUsage({
      tokens: { input: 1000, output: 200, cacheRead: 50_000, cacheWrite: 3000 },
      fiveHourLimit: { usedPercent: 61, resetsAt: '2026-10-27T18:00:00.000Z' },
    }),
  ).toEqual({ tokens: { input: 54_000, output: 200 }, fiveHour: { usedPercent: 61, resetsAt: '2026-10-27T18:00:00.000Z' } })
  // OpenCode: no plan windows.
  expect(poolUsage({ tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } })).toEqual({ tokens: { input: 10, output: 5 } })
  expect(poolUsage({})).toBeUndefined()
})

test('readings that would show the same have the same mark', () => {
  const a: PoolUsage = { tokens: { input: 52_100, output: 999 }, fiveHour: { usedPercent: 40.2 } }
  const b: PoolUsage = { tokens: { input: 51_900, output: 1001 }, fiveHour: { usedPercent: 39.8 } }
  expect(usageMark(a)).toBe(usageMark(b))
  expect(usageMark({ ...a, tokens: { input: 60_000, output: 999 } })).not.toBe(usageMark(a))
})

test('posts at once, then at most once a minute with the latest reading, and nothing for a reading already posted', async () => {
  let now = 0
  const posted: [string, PoolUsage][] = []
  const sharing = new UsageSharing(
    (poolId, usage) => posted.push([poolId, usage]),
    () => now,
    40,
  )
  sharing.share('p1', tokens(1000))
  expect(posted).toEqual([['p1', tokens(1000)]])
  now = 10
  sharing.share('p1', tokens(2000))
  sharing.share('p1', tokens(3000))
  // Another pool keeps its own pace.
  sharing.share('p2', tokens(9000))
  expect(posted).toHaveLength(2)
  now = 50
  await Bun.sleep(60)
  expect(posted.slice(2)).toEqual([['p1', tokens(3000)]])
  // Back to what was posted last: nothing to say.
  now = 200
  sharing.share('p1', tokens(3000))
  expect(posted).toHaveLength(3)
  // Leaving the pool forgets it: joining again posts at once.
  sharing.forget('p1')
  sharing.share('p1', tokens(3000))
  expect(posted).toHaveLength(4)
})
