import { expect, test } from 'bun:test'
import { utf8ToBase64Url } from '../base64'
import { newAccountKey } from '../crypto'
import { parseShareLink, shareSocket } from '../share-link'

const token = `ts_abcdefghijkl_${'t'.repeat(43)}`
const link = (fields: object) => `tontonshare1.${utf8ToBase64Url(JSON.stringify(fields))}`

test('a share key is the relay, a share token and a key, nothing else', () => {
  const key = newAccountKey()
  expect(parseShareLink(link({ relay: 'https://tonton.example.com/', token, key }))).toEqual({
    relay: 'https://tonton.example.com',
    token,
    key,
  })
  // An account token or a recovery key is not a share.
  expect(parseShareLink(link({ relay: 'https://tonton.example.com', token: 'ta_abcdefghijkl_x', key }))).toBeNull()
  expect(parseShareLink(`tonton1.${utf8ToBase64Url(JSON.stringify({ relay: 'https://x.y', token, key }))}`)).toBeNull()
  expect(parseShareLink(link({ relay: 'javascript:alert(1)', token, key }))).toBeNull()
  expect(parseShareLink(link({ relay: 'https://tonton.example.com', token, key: 'short' }))).toBeNull()
  expect(parseShareLink('tontonshare1.%%%')).toBeNull()
})

test('the socket opens the share endpoint with the token as a subprotocol', () => {
  let opened: { url: string; protocols: string[] } | undefined
  shareSocket({ relay: 'https://tonton.example.com/base', token, key: newAccountKey() }, (url, protocols) => {
    opened = { url, protocols }
    return {} as never
  })
  expect(opened).toEqual({ url: 'wss://tonton.example.com/base/ws/share', protocols: ['tonton', `bearer.${token}`] })
})
