import { describe, expect, test } from 'bun:test'
import { RateLimiter } from '../src/rate-limit'

describe('RateLimiter', () => {
  test('blocks a key once it goes over the limit, independently of other keys', () => {
    const limiter = new RateLimiter(2, 60_000)
    expect(limiter.hit('a')).toBe(true)
    expect(limiter.hit('a')).toBe(true)
    expect(limiter.hit('a')).toBe(false)
    expect(limiter.isBlocked('a')).toBe(true)
    expect(limiter.isBlocked('b')).toBe(false)
  })

  test('a new window starts after the previous one expires', async () => {
    const limiter = new RateLimiter(1, 20)
    limiter.hit('a')
    expect(limiter.hit('a')).toBe(false)
    await Bun.sleep(30)
    expect(limiter.hit('a')).toBe(true)
  })
})
