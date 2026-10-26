import { describe, expect, test } from 'bun:test'
import { importAccountKey, newAccountKey, open, seal } from '../crypto'

const newKey = newAccountKey

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
})
