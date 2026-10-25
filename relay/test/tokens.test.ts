import { describe, expect, test } from 'bun:test'
import { issueToken, newEnrollmentCode, parseToken, safeEqual } from '../src/tokens'

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

  test('enrollment codes are 12 unambiguous characters', () => {
    const code = newEnrollmentCode()
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{12}$/)
  })
})
