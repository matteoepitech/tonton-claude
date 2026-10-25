import { describe, expect, test } from 'bun:test'
import { parseLine, toolSummary } from '../src/transcript/parser'

const line = (fields: object) => JSON.stringify({ uuid: 'u1', timestamp: '2026-10-25T10:00:00Z', ...fields })

describe('parseLine', () => {
  test('user prompt as a string', () => {
    expect(parseLine(line({ type: 'user', message: { content: 'hello' } })).entries).toEqual([
      { id: 'u1', ts: '2026-10-25T10:00:00Z', kind: 'user', text: 'hello' },
    ])
  })

  test('assistant text and tool calls, hiding ToolSearch', () => {
    const { entries } = parseLine(
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'On it.' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm   test' } },
            { type: 'tool_use', id: 't2', name: 'ToolSearch', input: { query: 'select:Write' } },
          ],
        },
      }),
    )
    expect(entries.map(e => e.kind)).toEqual(['assistant', 'tool'])
    expect(entries[1]).toMatchObject({ toolUseId: 't1', name: 'Bash', summary: 'npm test' })
  })

  test('tool results are truncated and keep the error flag', () => {
    const { entries } = parseLine(
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(5000), is_error: true }] } }),
    )
    expect(entries[0]).toMatchObject({ kind: 'tool_result', toolUseId: 't1', isError: true })
    expect(entries[0].kind === 'tool_result' && entries[0].text).toContain('characters truncated')
  })

  test('images pasted with a prompt are kept', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0' } }
    const { entries } = parseLine(line({ type: 'user', message: { content: [{ type: 'text', text: '[Image #1] like this' }, image] } }))
    expect(entries[0]).toMatchObject({ kind: 'user', images: [{ mediaType: 'image/png', data: 'iVBORw0' }] })
  })

  test('messages sent from the notch are unwrapped', () => {
    const { entries } = parseLine(
      line({
        type: 'user',
        isMeta: true,
        origin: { kind: 'channel' },
        message: { content: '<channel source="tonton" sender="notch">\nShip it\n</channel>' },
      }),
    )
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'Ship it', viaNotch: true })
  })

  test('internal and meta messages are skipped, commands become system entries', () => {
    expect(parseLine(line({ type: 'user', isMeta: true, message: { content: 'skill text' } })).entries).toEqual([])
    expect(parseLine(line({ type: 'user', message: { content: '<system-reminder>x</system-reminder>' } })).entries).toEqual([])
    const command = parseLine(
      line({ type: 'user', message: { content: '<command-name>/model</command-name><command-args>opus</command-args>' } }),
    )
    expect(command.entries[0]).toMatchObject({ kind: 'system', text: '/model opus' })
  })

  test('title, cost and compaction', () => {
    expect(parseLine(line({ type: 'ai-title', aiTitle: 'Fix login' })).title).toBe('Fix login')
    expect(parseLine(line({ type: 'cost-state', totalCostUSD: 0.42 })).costUSD).toBe(0.42)
    expect(parseLine(line({ type: 'system', subtype: 'compact_boundary' })).entries[0]).toMatchObject({ kind: 'system' })
  })

  test('garbage and subagent lines are ignored', () => {
    expect(parseLine('{not json').entries).toEqual([])
    expect(parseLine(line({ type: 'user', isSidechain: true, message: { content: 'x' } })).entries).toEqual([])
  })
})

describe('toolSummary', () => {
  test('picks the most telling field per tool', () => {
    expect(toolSummary('Read', { file_path: 'a.ts' })).toBe('a.ts')
    expect(toolSummary('Grep', { pattern: 'TODO', path: 'src' })).toBe('TODO in src')
    expect(toolSummary('mcp__x__y', { url: 'https://x.dev' })).toBe('https://x.dev')
    expect(toolSummary('Bash', { command: 'a'.repeat(400) })).toHaveLength(301)
  })
})
