import { describe, expect, test } from 'bun:test'
import { utf8ToBase64Url } from '../base64'
import { browserSocket, parseRecoveryKey } from '../recovery-key'

// As Account.recoveryKey writes it in the Mac app: `tonton1.` and base64url of the Codable JSON.
const key = 'oze6LbNXeSIiEnjwELgj6N2Olugn0lb5OgUZxBTVJns'
const swiftAccount = { relay: 'https://tonton.d3l.tech', accountId: 'acct12345678', token: 'ta_AbCdEf0123456789', key, joinSecret: null }

describe('recovery key', () => {
  test('reads the account the Mac app exports', () => {
    expect(parseRecoveryKey(` tonton1.${utf8ToBase64Url(JSON.stringify(swiftAccount))}\n`)).toEqual({
      relay: 'https://tonton.d3l.tech',
      accountId: 'acct12345678',
      token: 'ta_AbCdEf0123456789',
      key,
    })
  })

  test('refuses anything else', () => {
    const encode = (value: object) => `tonton1.${utf8ToBase64Url(JSON.stringify(value))}`
    expect(parseRecoveryKey('tonton_abc')).toBeNull()
    expect(parseRecoveryKey('tonton1.not base64')).toBeNull()
    expect(parseRecoveryKey(encode({ ...swiftAccount, key: 'short' }))).toBeNull()
    expect(parseRecoveryKey(encode({ ...swiftAccount, relay: 'ftp://x' }))).toBeNull()
    expect(parseRecoveryKey(encode({ ...swiftAccount, token: 'with spaces in it' }))).toBeNull()
  })

  test('a browser socket carries the token as a subprotocol, next to tonton', () => {
    const opened: [string, string[]][] = []
    browserSocket('https://tonton.d3l.tech/', 'ta_AbCdEf0123456789', (url, protocols) => {
      opened.push([url, protocols])
      return { onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} }
    })
    expect(opened).toEqual([['wss://tonton.d3l.tech/ws/app', ['tonton', 'bearer.ta_AbCdEf0123456789']]])
  })
})
