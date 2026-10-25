import { describe, expect, test } from 'bun:test'
import { issueToken, newJoinSecret, parseToken, safeEqual } from '../src/tokens'

describe('tokens', () => {
  test('an issued token parses back to the same id and secret hash', () => {
    const issued = issueToken('ta')
    const parsed = parseToken(issued.token, 'ta')
    expect(parsed?.id).toBe(issued.id)
    expect(parsed && safeEqual(parsed.secretHash, issued.secretHash)).toBe(true)
  })

  test('a token of another kind or a mangled token does not parse', () => {
    const { token } = issueToken('tm')
    expect(parseToken(token, 'ta')).toBeNull()
    expect(parseToken(`${token}x`, 'tm')).toBeNull()
    expect(parseToken('', 'tm')).toBeNull()
  })

  test('join secrets are 256 random bits', () => {
    expect(newJoinSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newJoinSecret()).not.toBe(newJoinSecret())
  })
})
