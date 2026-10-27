// The QR codes the website draws for pool invites, read back by jsQR, the reader the web app's scanner already uses
// (they were also checked with CoreImage's CIDetector), and what a reader relies on: the size, the finder and timing
// patterns, and the format bits.
import { expect, test } from 'bun:test'
import jsQR from 'jsqr'
import { formatPoolInvite } from '../pool-link'
import { qrCode } from '../qr'

/** The format bits as a reader reads them around the top-left finder, once the mask pattern is taken off. */
function formatBits(modules: boolean[][]): number {
  const at = (x: number, y: number) => (modules[y][x] ? 1 : 0)
  let bits = 0
  for (let i = 0; i <= 5; i++) bits |= at(8, i) << i
  bits |= at(8, 7) << 6
  bits |= at(8, 8) << 7
  bits |= at(7, 8) << 8
  for (let i = 9; i < 15; i++) bits |= at(14 - i, 8) << i
  return bits ^ 0x5412
}

test('the smallest version that fits, square, with its finder and timing patterns', () => {
  expect(qrCode('hi')?.version).toBe(1)
  expect(qrCode('x'.repeat(14))?.version).toBe(1)
  expect(qrCode('x'.repeat(15))?.version).toBe(2)
  expect(qrCode('x'.repeat(2331))?.version).toBe(40)
  expect(qrCode('x'.repeat(2332))).toBeNull()
  for (const text of ['hi', 'x'.repeat(300)]) {
    const code = qrCode(text)
    if (!code) throw new Error('no code')
    expect(code.size).toBe(code.version * 4 + 17)
    expect(code.modules).toHaveLength(code.size)
    for (const row of code.modules) expect(row).toHaveLength(code.size)
    // A finder pattern in three corners: a dark ring, a light ring, a dark centre.
    for (const [cx, cy] of [
      [3, 3],
      [code.size - 4, 3],
      [3, code.size - 4],
    ]) {
      expect(code.modules[cy][cx - 3]).toBe(true)
      expect(code.modules[cy][cx - 2]).toBe(false)
      expect(code.modules[cy][cx]).toBe(true)
    }
    for (let i = 8; i < code.size - 8; i++) expect(code.modules[6][i]).toBe(i % 2 === 0)
  }
})

test('the format bits say level M, and their check bits hold', () => {
  for (const text of ['hi', 'a'.repeat(90), 'b'.repeat(700)]) {
    const code = qrCode(text)
    if (!code) throw new Error('no code')
    const bits = formatBits(code.modules)
    const data = bits >>> 10
    expect(data >>> 3).toBe(0)
    let remainder = data
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
    expect(bits & 0x3ff).toBe(remainder & 0x3ff)
  }
})

/** The code drawn as a scanner sees it: 4 pixels a module, a quiet zone of 4 modules, dark on white. */
function read(code: NonNullable<ReturnType<typeof qrCode>>): string | null {
  const scale = 4
  const side = (code.size + 8) * scale
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255)
  code.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (!dark) return
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const offset = (((y + 4) * scale + dy) * side + (x + 4) * scale + dx) * 4
          pixels.fill(0, offset, offset + 3)
        }
      }
    })
  })
  return jsQR(pixels, side, side)?.data ?? null
}

test('a reader gets the text back, from one block to several, with and without version bits', () => {
  const texts = ['hi', 'x'.repeat(30), 'é€ ✨ '.repeat(10), 'tontonpool1.'.repeat(20), 'q'.repeat(400), 'r'.repeat(700)]
  const versions: number[] = []
  for (const text of texts) {
    const code = qrCode(text)
    if (!code) throw new Error('no code')
    versions.push(code.version)
    expect(read(code)).toBe(text)
  }
  // Version 7 and later carry version bits; from version 4 at level M the data is split in blocks.
  expect(Math.min(...versions)).toBe(1)
  expect(Math.max(...versions)).toBeGreaterThanOrEqual(15)
})

test('a pool invite fits in a code a phone reads from a screen', () => {
  const invite = formatPoolInvite({
    relay: 'https://tonton.example.com',
    pool: 'AbCdEfGhIjKl',
    token: `tp_AbCdEfGhIjKl_${'t'.repeat(43)}`,
    key: 'k'.repeat(43),
    version: 3,
  })
  const code = qrCode(invite)
  if (!code) throw new Error('no code')
  expect(code.version).toBeLessThanOrEqual(14)
  expect(read(code)).toBe(invite)
})
