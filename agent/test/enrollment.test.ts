import { expect, test } from 'bun:test'
import { normalizeServer, parseEnrollment } from '../../shared/enrollment'

const KEY = 'a'.repeat(43)

test('connection codes carry the relay', () => {
  expect(parseEnrollment(`ABCDEFGHJKMN.${KEY}@https://relay.example.com/`)).toEqual({
    code: 'ABCDEFGHJKMN',
    key: KEY,
    server: 'https://relay.example.com',
  })
})

test('codes from apps before 0.4.0 have no relay', () => {
  expect(parseEnrollment(` ABCDEFGHJKMN.${KEY} `)).toEqual({ code: 'ABCDEFGHJKMN', key: KEY, server: null })
})

test('anything else is not a code', () => {
  for (const text of ['https://relay.example.com', `abcdefghjkmn.${KEY}`, `ABCDEFGHJKMN.${KEY}@ftp://x`, `ABCDEFGHJKMN.short@https://x`]) {
    expect(parseEnrollment(text)).toBeNull()
  }
})

test('relay addresses are normalized', () => {
  expect(normalizeServer(' https://relay.example.com/ ')).toBe('https://relay.example.com')
  expect(normalizeServer('http://10.0.0.2:7777')).toBe('http://10.0.0.2:7777')
  expect(normalizeServer('https://example.com/tonton/')).toBe('https://example.com/tonton')
  expect(normalizeServer('relay.example.com')).toBeNull()
  expect(normalizeServer('file:///etc/passwd')).toBeNull()
})
