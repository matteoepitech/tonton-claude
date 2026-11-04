import { describe, expect, test } from 'bun:test'
import { importAccountKey, newAccountKey, open, seal } from '../crypto'

const newKey = newAccountKey

/** The JSON a blob holds, as the Mac app's JSONDecoder reads it. */
async function plaintext(key: string, blob: string): Promise<string> {
  const data = Buffer.from(blob, 'base64')
  const additionalData = new TextEncoder().encode('tonton/v1')
  const opened = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.subarray(0, 12), additionalData },
    await importAccountKey(key),
    data.subarray(12),
  )
  return new TextDecoder().decode(opened)
}

/** What JSON.stringify writes for half a surrogate pair, and Swift's JSONDecoder refuses with the whole blob. */
const LONE_ESCAPE = /(?<!\\)(?:\\\\)*\\ud[89a-f]/

describe('seal / open', () => {
  test('round-trips any JSON value', async () => {
    const key = newKey()
    const value = { text: 'déploie en staging', images: [{ name: 'a.png' }] }
    expect(await open(key, await seal(key, value))).toEqual(value)
  })

  test('uses a fresh nonce every time', async () => {
    const key = newKey()
    expect(await seal(key, 'same')).not.toBe(await seal(key, 'same'))
  })

  test('rejects another key and tampered blobs', async () => {
    const key = newKey()
    const blob = await seal(key, { secret: true })
    expect(open(newKey(), blob)).rejects.toThrow()
    const tampered = Buffer.from(blob, 'base64')
    tampered[20] ^= 1
    expect(open(key, tampered.toString('base64'))).rejects.toThrow()
  })

  test('refuses keys that are not 256 bits', () => {
    expect(seal('c2hvcnQ', 'x')).rejects.toThrow('32 bytes')
  })

  test('an imported key works like its text, and cannot be read back', async () => {
    const text = newKey()
    const key = await importAccountKey(text)
    expect(key.extractable).toBe(false)
    expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
    expect(await open(text, await seal(key, { text: 'hi' }))).toEqual({ text: 'hi' })
    expect(await open(key, await seal(text, [1, 2]))).toEqual([1, 2])
  })

  test('keys are 32 bytes of base64url', async () => {
    expect(Buffer.from(newKey(), 'base64url')).toHaveLength(32)
    expect(importAccountKey('not a key')).rejects.toThrow('32 bytes')
  })

  test('half an emoji seals as U+FFFD, so the Mac and the iPhone can still decode the blob', async () => {
    const key = newKey()
    const cut = 'Déployé 🎉'.slice(0, -1)
    const value = { text: cut, list: ['\udf89 low half first', 'kept 🎉'], [`key ${cut}`]: 1, escaped: 'a \\ud83c in the text' }
    const json = await plaintext(key, await seal(key, value))
    expect(json).not.toMatch(LONE_ESCAPE)
    expect(JSON.parse(json)).toEqual({
      text: 'Déployé \uFFFD',
      list: ['\uFFFD low half first', 'kept 🎉'],
      'key Déployé \uFFFD': 1,
      escaped: 'a \\ud83c in the text',
    })
  })

  test('well-formed text seals byte for byte as JSON.stringify writes it', async () => {
    const key = newKey()
    const value = { text: 'Déployé ✅ 🎉 \\u00e9 "quoted"\n\ttab \u0001', path: 'C:\\Users\\me' }
    expect(await plaintext(key, await seal(key, value))).toBe(JSON.stringify(value))
  })
})
