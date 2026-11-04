import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLine } from '../src/transcript/parser'
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

  describe('a line longer than the end read on start', () => {
    const prompts = Array.from({ length: 50 }, (_, index) =>
      JSON.stringify({ type: 'user', uuid: `u${index}`, timestamp: '2026-11-04T10:00:00Z', message: { content: `prompt ${index}` } }),
    )
    // A tool result of 30 MB, which Claude Code writes on one line.
    const output = JSON.stringify({
      type: 'user',
      uuid: 'big',
      timestamp: '2026-11-04T10:01:00Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(30 * 1024 * 1024) }] },
    })

    test('the conversation before it shows, and the line itself is read whole', () => {
      const { batches } = follow(`${prompts.join('\n')}\n${output}\n`)
      expect(batches[0].initial).toBe(true)
      expect(batches[0].lines.slice(0, 50)).toEqual(prompts)
      const entries = batches[0].lines.flatMap(line => parseLine(line).entries)
      expect(entries.filter(entry => entry.kind === 'user')).toHaveLength(50)
      const result = entries.find(entry => entry.kind === 'tool_result')
      expect(result?.kind === 'tool_result' && result.text).toContain('characters truncated')
    })

    test('in a larger file too, and a long line still being written comes whole once it ends', async () => {
      const earlier = `${'x'.repeat(1023)}\n`.repeat(9 * 1024)
      const { file, batches } = follow(`${earlier}${prompts.join('\n')}\n${output}`)
      // Some of the earlier lines, whole, then the prompts.
      const before = batches[0].lines.slice(0, -50)
      expect(before.length).toBeGreaterThan(0)
      expect(before.length).toBeLessThan(9 * 1024)
      expect(before.every(line => line.length === 1023)).toBe(true)
      expect(batches[0].lines.slice(-50)).toEqual(prompts)
      appendFileSync(file, '\n')
      for (let i = 0; i < 20 && batches.length < 2; i++) await Bun.sleep(100)
      expect(batches[1].lines).toEqual([output])
    })
  })
})
