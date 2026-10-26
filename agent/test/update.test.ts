import { describe, expect, test } from 'bun:test'
import { seal } from '../../shared/crypto'
import { isOlder } from '../../shared/version'
import { agentBinaryName, parseChecksums, readOrder } from '../src/update'

const newKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
const minutes = (count: number) => count * 60_000

describe('update orders', () => {
  test('are accepted when sealed with the account key and recent', async () => {
    const key = newKey()
    const order = { version: '0.4.0', issuedAt: new Date().toISOString() }
    expect(await readOrder(key, await seal(key, order))).toEqual(order)
  })

  test('are refused when sealed with another key', async () => {
    const order = await seal(newKey(), { version: '0.4.0', issuedAt: new Date().toISOString() })
    expect(readOrder(newKey(), order)).rejects.toThrow('not sealed with the account key')
  })

  test('are refused once expired or from too far in the future', async () => {
    const key = newKey()
    const order = await seal(key, { version: '0.4.0', issuedAt: new Date().toISOString() })
    expect(readOrder(key, order, Date.now() + minutes(11))).rejects.toThrow('expired')
    expect(readOrder(key, order, Date.now() - minutes(11))).rejects.toThrow('expired')
    expect(await readOrder(key, order, Date.now() + minutes(9))).toMatchObject({ version: '0.4.0' })
  })

  test('need a plain version', async () => {
    const key = newKey()
    const order = await seal(key, { version: '../../evil', issuedAt: new Date().toISOString() })
    expect(readOrder(key, order)).rejects.toThrow('valid version')
  })
})

test('binary names match the builds served by the relay', () => {
  expect(agentBinaryName('darwin', 'arm64')).toBe('tonton-darwin-arm64')
  expect(agentBinaryName('linux', 'x64')).toBe('tonton-linux-x64')
  expect(agentBinaryName('win32', 'x64')).toBe('tonton-windows-x64.exe')
})

test('versions compare numerically', () => {
  expect(isOlder('0.3.0', '0.4.0')).toBe(true)
  expect(isOlder('0.9.0', '0.10.0')).toBe(true)
  expect(isOlder('1.0.0', '0.10.0')).toBe(false)
  expect(isOlder('0.4.0', '0.4.0')).toBe(false)
})

test('release checksums are read from SHA256SUMS', () => {
  const sums = parseChecksums(`${'a'.repeat(64)}  tonton-linux-x64\n${'b'.repeat(64)} *tonton-windows-x64.exe\n\nnot a line\n`)
  expect(sums.get('tonton-linux-x64')).toBe('a'.repeat(64))
  expect(sums.get('tonton-windows-x64.exe')).toBe('b'.repeat(64))
  expect(sums.size).toBe(2)
})
