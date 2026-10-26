import { expect, test } from 'bun:test'
import { encodeAccountToken, normalizeRelay, parseAccountToken } from '../account-token'

const token = { relay: 'https://relay.example.com', account: 'abcdefghijkl', secret: 's'.repeat(43), key: 'k'.repeat(43) }

test('a token round-trips, with its relay normalized', () => {
  expect(parseAccountToken(encodeAccountToken(token))).toEqual(token)
  expect(parseAccountToken(` ${encodeAccountToken({ ...token, relay: 'https://relay.example.com/' })}\n`)).toEqual(token)
})

test('reads the tokens the app makes (JSON with the same keys, any order)', () => {
  const fromApp = `tonton_${Buffer.from(JSON.stringify({ key: token.key, secret: token.secret, account: token.account, relay: token.relay })).toString('base64url')}`
  expect(parseAccountToken(fromApp)).toEqual(token)
})

test('anything else is not a token', () => {
  for (const text of [
    'https://relay.example.com',
    encodeAccountToken(token).slice(0, -4),
    encodeAccountToken({ ...token, relay: 'file:///etc/passwd' }),
    encodeAccountToken({ ...token, secret: 'short' }),
    `tonton_${Buffer.from('{}').toString('base64url')}`,
    'tonton_not-base64-json',
  ]) {
    expect(parseAccountToken(text)).toBeNull()
  }
})

test('relay addresses are normalized', () => {
  expect(normalizeRelay('http://10.0.0.2:7777/')).toBe('http://10.0.0.2:7777')
  expect(normalizeRelay('https://example.com/tonton/')).toBe('https://example.com/tonton')
  expect(normalizeRelay('relay.example.com')).toBeNull()
})
