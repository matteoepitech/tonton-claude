import { describe, expect, test } from 'bun:test'
import { utf8ToBase64Url } from '../base64'
import { appSocketUrl, browserSocket, encodeRecoveryKey, parseRecoveryKey } from '../recovery-key'

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

  test('keeps the join secret of the account token when the key has one', () => {
    const joinSecret = 'S3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS'
    const encode = (value: object) => `tonton1.${utf8ToBase64Url(JSON.stringify(value))}`
    expect(parseRecoveryKey(encode({ ...swiftAccount, joinSecret }))?.joinSecret).toBe(joinSecret)
    // One of the wrong shape is left out, and the account still signs in.
    expect(parseRecoveryKey(encode({ ...swiftAccount, joinSecret: 'short' }))).toEqual(parseRecoveryKey(encode(swiftAccount)))
  })

  test('writes the key the Mac app restores', () => {
    const account = { relay: 'https://tonton.d3l.tech', accountId: 'acct12345678', token: 'ta_AbCdEf0123456789', key }
    const joinSecret = 'S3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS'
    // AccountTests.testRestoresAKeyWrittenByTheClientCore opens this exact text.
    expect(encodeRecoveryKey({ ...account, joinSecret })).toBe(
      'tonton1.eyJyZWxheSI6Imh0dHBzOi8vdG9udG9uLmQzbC50ZWNoIiwiYWNjb3VudElkIjoiYWNjdDEyMzQ1Njc4IiwidG9rZW4iOiJ0YV9BYkNkRWYwMTIzNDU2Nzg5Iiwia2V5Ijoib3plNkxiTlhlU0lpRW5qd0VMZ2o2TjJPbHVnbjBsYjVPZ1VaeEJUVkpucyIsImpvaW5TZWNyZXQiOiJTM2NyM3RTM2NyM3RTM2NyM3RTM2NyM3RTM2NyM3RTM2NyM3RTM2NyM3RTIn0',
    )
    expect(parseRecoveryKey(encodeRecoveryKey(account))).toEqual(account)
    expect(parseRecoveryKey(encodeRecoveryKey({ ...account, joinSecret }))).toEqual({ ...account, joinSecret })
  })

  test("the app socket is the relay's /ws/app, over ws or wss", () => {
    expect(appSocketUrl('https://tonton.d3l.tech')).toBe('wss://tonton.d3l.tech/ws/app')
    expect(appSocketUrl('http://127.0.0.1:7777/')).toBe('ws://127.0.0.1:7777/ws/app')
    expect(appSocketUrl('https://example.com/tonton')).toBe('wss://example.com/tonton/ws/app')
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
