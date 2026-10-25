import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tailer } from '../src/transcript/tailer'

const dirs: string[] = []
const tailers: Tailer[] = []

afterEach(() => {
  for (const tailer of tailers.splice(0)) tailer.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function follow(content: string | Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'tonton-tailer-'))
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, content)
  const batches: { lines: string[]; initial: boolean }[] = []
  let resets = 0
  const tailer = new Tailer(file, { lines: (lines, initial) => batches.push({ lines, initial }), reset: () => resets++ })
  tailers.push(tailer)
  tailer.start()
  return { file, batches, resets: () => resets }
}

describe('Tailer', () => {
  test('reads existing lines, then new ones, holding back an unfinished line', async () => {
    const { file, batches } = follow('a\nb\npart')
    expect(batches[0]).toEqual({ lines: ['a', 'b'], initial: true })
    appendFileSync(file, 'ial\nc\n')
    await Bun.sleep(500)
    expect(batches.at(-1)).toEqual({ lines: ['partial', 'c'], initial: false })
  })

  test('never splits a multi-byte character across reads', async () => {
    const word = Buffer.from('réponse\n')
    const { file, batches } = follow(word.subarray(0, 2))
    appendFileSync(file, word.subarray(2))
    await Bun.sleep(500)
    expect(batches.flatMap(b => b.lines)).toEqual(['réponse'])
  })

  test('starts over when the file is truncated', async () => {
    const { file, batches, resets } = follow('a\nb\n')
    writeFileSync(file, 'c\n')
    await Bun.sleep(500)
    expect(resets()).toBe(1)
    expect(batches.at(-1)?.lines).toEqual(['c'])
  })

  test('only reads the end of a very large file on start', () => {
    const line = `${'x'.repeat(1023)}\n`
    const { batches } = follow(line.repeat(10 * 1024))
    const first = batches[0]
    expect(first.lines.length).toBeLessThan(9 * 1024)
    expect(first.lines.every(l => l.length === 1023)).toBe(true)
  })
})
