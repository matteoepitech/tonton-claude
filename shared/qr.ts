// A QR code for a text, as a square of dark and light modules: byte mode, error correction level M, the smallest version
// that fits. Enough for the pool invites the website shows; the Mac app draws its codes with CoreImage instead
// (app/Sources/TontonCore/QRCode.swift). Written from ISO/IEC 18004, with no dependency.

/** Codewords of error correction per block, and number of blocks, at level M, for versions 1 to 40. */
const ECC_PER_BLOCK = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28,
]
const BLOCKS = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45,
  47, 49,
]
/** Level M in the format bits. */
const LEVEL_M = 0

export interface QRCode {
  version: number
  size: number
  /** `modules[y][x]`, true for dark. */
  modules: boolean[][]
}

/** Null when the text does not fit in a version 40 code. */
export function qrCode(text: string): QRCode | null {
  const data = new TextEncoder().encode(text)
  for (let version = 1; version <= 40; version++) {
    const countBits = version < 10 ? 8 : 16
    const capacity = dataCodewords(version) * 8
    if (4 + countBits + data.length * 8 > capacity) continue
    return draw(version, withErrorCorrection(version, encode(data, countBits, capacity)))
  }
  return null
}

// MARK: Data

function encode(data: Uint8Array, countBits: number, capacity: number): number[] {
  const bits: number[] = []
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(data.length, countBits)
  for (const byte of data) push(byte, 8)
  push(0, Math.min(4, capacity - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  const bytes: number[] = []
  for (let i = 0; i < bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0))
  for (let pad = 0xec; bytes.length < capacity / 8; pad ^= 0xec ^ 0x11) bytes.push(pad)
  return bytes
}

function rawModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2
    result -= (25 * align - 10) * align - 55
    if (version >= 7) result -= 36
  }
  return result
}

const dataCodewords = (version: number) => Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version - 1] * BLOCKS[version - 1]

/** The data split in blocks, each with its Reed-Solomon codewords, then interleaved. */
function withErrorCorrection(version: number, data: number[]): number[] {
  const blocks = BLOCKS[version - 1]
  const eccLength = ECC_PER_BLOCK[version - 1]
  const raw = Math.floor(rawModules(version) / 8)
  const shortBlocks = blocks - (raw % blocks)
  const shortLength = Math.floor(raw / blocks)
  const divisor = rsDivisor(eccLength)
  const all: number[][] = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1))
    k += block.length
    const ecc = rsRemainder(block, divisor)
    if (i < shortBlocks) block.push(0)
    all.push([...block, ...ecc])
  }
  const result: number[] = []
  for (let i = 0; i < all[0].length; i++) {
    for (let j = 0; j < all.length; j++) {
      // The short blocks' placeholder byte is not sent.
      if (i !== shortLength - eccLength || j >= shortBlocks) result.push(all[j][i])
    }
  }
  return result
}

function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0)
    result.push(0)
    divisor.forEach((coefficient, i) => {
      result[i] ^= gfMultiply(coefficient, factor)
    })
  }
  return result
}

// MARK: Modules

function draw(version: number, codewords: number[]): QRCode {
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark
    fixed[y][x] = true
  }

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4)
      }
    }
  }
  const positions = alignmentPositions(version, size)
  const last = positions.length - 1
  positions.forEach((cx, i) => {
    positions.forEach((cy, j) => {
      // Not over the finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    })
  })
  drawFormat(set, size, 0)
  if (version >= 7) drawVersion(set, size, version)

  // The codewords, two columns at a time from the right, up then down, around what is fixed.
  let bit = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vertical : vertical
        if (fixed[y][x] || bit >= codewords.length * 8) continue
        modules[y][x] = ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1
        bit++
      }
    }
  }

  // The mask that leaves the fewest patterns a reader could take for something else.
  let best: boolean[][] = modules
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row, y) => row.map((dark, x) => (!fixed[y][x] && masked(mask, x, y) ? !dark : dark)))
    drawFormat(
      (x, y, dark) => {
        candidate[y][x] = dark
      },
      size,
      mask,
    )
    const score = penalty(candidate)
    if (score < bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return { version, size, modules: best }
}

function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2
  const result = [6]
  for (let position = size - 7; result.length < count; position -= step) result.splice(1, 0, position)
  return result
}

type Setter = (x: number, y: number, dark: boolean) => void

function drawFormat(set: Setter, size: number, mask: number) {
  const data = (LEVEL_M << 3) | mask
  let remainder = data
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
  const bits = ((data << 10) | remainder) ^ 0x5412
  const bitAt = (i: number) => ((bits >>> i) & 1) === 1
  for (let i = 0; i <= 5; i++) set(8, i, bitAt(i))
  set(8, 7, bitAt(6))
  set(8, 8, bitAt(7))
  set(7, 8, bitAt(8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, bitAt(i))
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bitAt(i))
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bitAt(i))
  set(8, size - 8, true)
}

function drawVersion(set: Setter, size: number, version: number) {
  let remainder = version
  for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
  const bits = (version << 12) | remainder
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1
    const a = size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    set(a, b, dark)
    set(b, a, dark)
  }
}

function masked(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

const FINDER_LIKE = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
]

function penalty(modules: boolean[][]): number {
  const size = modules.length
  let score = 0
  const lines = [...modules, ...modules.map((_, x) => modules.map(row => row[x]))]
  for (const line of lines) {
    for (let start = 0; start < size; ) {
      let end = start
      while (end < size && line[end] === line[start]) end++
      if (end - start >= 5) score += end - start - 2
      start = end
    }
    for (let i = 0; i + 11 <= size; i++) {
      if (FINDER_LIKE.some(pattern => pattern.every((dark, k) => line[i + k] === dark))) score += 40
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const dark = modules[y][x]
      if (modules[y][x + 1] === dark && modules[y + 1][x] === dark && modules[y + 1][x + 1] === dark) score += 3
    }
  }
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10
  return score
}
