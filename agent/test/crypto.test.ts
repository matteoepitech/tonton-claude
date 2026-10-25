import { describe, expect, test } from 'bun:test'
import { open, seal } from '../src/crypto'

const newKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')

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
})
