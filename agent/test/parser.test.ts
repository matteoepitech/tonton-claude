import { describe, expect, test } from 'bun:test'
import { fileEdits, parseLine, toolSummary } from '../src/transcript/parser'

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

  test('messages sent while Claude is working are read from the queue, from the notch or the terminal', () => {
    const queued = (attachment: object) => parseLine(line({ type: 'attachment', attachment: { type: 'queued_command', ...attachment } }))
    expect(
      queued({
        commandMode: 'prompt',
        origin: { kind: 'channel', server: 'tonton' },
        prompt: '<channel source="tonton" sender="notch">\nAlso run the linter\n</channel>',
      }).entries,
    ).toEqual([{ id: 'u1', ts: '2026-10-25T10:00:00Z', kind: 'user', text: 'Also run the linter', viaNotch: true }])
    // Without the wrapper, the origin is enough to tell it came from the notch.
    expect(queued({ commandMode: 'prompt', origin: { kind: 'channel' }, prompt: 'Also run the linter' }).entries[0]).toMatchObject({
      text: 'Also run the linter',
      viaNotch: true,
    })
    const typed = queued({ commandMode: 'prompt', origin: { kind: 'human' }, prompt: [{ type: 'text', text: 'and the docs' }] })
    expect(typed.entries).toEqual([{ id: 'u1', ts: '2026-10-25T10:00:00Z', kind: 'user', text: 'and the docs' }])
    // Task notifications go through the queue too; they are not messages.
    expect(queued({ commandMode: 'task-notification', prompt: '<task-notification>x</task-notification>' }).entries).toEqual([])
    expect(parseLine(line({ type: 'attachment', attachment: { type: 'date', date: '2026-10-25' } })).entries).toEqual([])
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

  test('a session stopped by the 5-hour limit is at 100 % until the reset', () => {
    const refused = (quotaLimits: object) =>
      parseLine(line({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', quotaLimits, message: { content: [] } }))
    expect(refused({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1792497600 }).fiveHourLimit).toEqual({
      usedPercent: 100,
      resetsAt: '2026-10-20T12:00:00.000Z',
    })
    expect(refused({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1792497600 }).fiveHourLimit).toBeUndefined()
    // Weekly limits, including the Opus and Sonnet shares, hold the session until the week resets.
    for (const rateLimitType of ['seven_day', 'seven_day_opus']) {
      expect(refused({ status: 'rejected', rateLimitType, resetsAt: 1792497600 }).sevenDayLimit).toEqual({
        usedPercent: 100,
        resetsAt: '2026-10-20T12:00:00.000Z',
      })
    }
    expect(refused({ status: 'rejected', rateLimitType: 'overage', resetsAt: 1792497600 }).sevenDayLimit).toBeUndefined()
    expect(refused({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 1792497600 }).fiveHourLimit).toBeUndefined()
    expect(refused({ status: 'rejected', rateLimitType: 'five_hour' }).fiveHourLimit).toBeUndefined()
  })

  test('each line of an API response carries its usage, Claude Code made-up messages none', () => {
    const usage = {
      input_tokens: 2,
      output_tokens: 669,
      cache_read_input_tokens: 24649,
      cache_creation_input_tokens: 51084,
      speed: 'standard',
    }
    const response = (fields: object) => parseLine(line({ type: 'assistant', ...fields })).usage
    expect(response({ requestId: 'req_1', message: { model: 'claude-opus-5-5', usage, content: [] } })).toEqual({
      requestId: 'req_1',
      input: 2,
      output: 669,
      cacheRead: 24649,
      cacheWrite: 51084,
    })
    // Older lines have no requestId: the message id groups them the same way.
    expect(response({ message: { id: 'msg_1', usage: { output_tokens: 5 }, content: [] } })).toEqual({
      requestId: 'msg_1',
      input: 0,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    })
    expect(response({ requestId: 'req_2', message: { model: '<synthetic>', usage, content: [] } })).toBeUndefined()
    expect(response({ requestId: 'req_3', message: { content: [] } })).toBeUndefined()
    expect(parseLine(line({ type: 'user', requestId: 'req_4', message: { usage, content: 'x' } })).usage).toBeUndefined()
  })

  test('the context window comes from the model the request asked for, and compaction starts it over', () => {
    const asked = (requestedModel?: string) =>
      parseLine(line({ type: 'assistant', requestedModel, message: { content: [] } })).contextWindow
    expect(asked('claude-opus-5-5[1m]')).toBe(1_000_000)
    expect(asked('claude-sonnet-5-5')).toBe(200_000)
    expect(asked(undefined)).toBeUndefined()
    expect(parseLine(line({ type: 'system', subtype: 'compact_boundary' })).compacted).toBe(true)
  })

  test('each response names the model that wrote it', () => {
    const model = (fields: object) => parseLine(line({ type: 'assistant', message: { content: [], ...fields } })).model
    expect(model({ model: 'claude-opus-5-5' })).toBe('claude-opus-5-5')
    expect(model({ model: 'claude-haiku-4-5-20251001' })).toBe('claude-haiku-4-5-20251001')
    expect(model({ model: '<synthetic>' })).toBeUndefined()
    expect(model({})).toBeUndefined()
    expect(parseLine(line({ type: 'user', message: { model: 'claude-opus-5-5', content: 'x' } })).model).toBeUndefined()
  })

  test('garbage and subagent lines are ignored', () => {
    expect(parseLine('{not json').entries).toEqual([])
    expect(parseLine(line({ type: 'user', isSidechain: true, message: { content: 'x' } })).entries).toEqual([])
  })
})

describe('fileEdits', () => {
  test('Edit and MultiEdit calls carry their replacements for the diff', () => {
    const { entries } = parseLine(
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' } }],
        },
      }),
    )
    expect(entries[0]).toMatchObject({ kind: 'tool', summary: '/a.ts', edits: [{ oldText: 'a', newText: 'b' }] })
    const multi = {
      file_path: '/a.ts',
      edits: [
        { old_string: 'x', new_string: 'y' },
        { old_string: 1, new_string: 'z' },
      ],
    }
    expect(fileEdits('MultiEdit', multi)).toEqual([{ oldText: 'x', newText: 'y' }])
    expect(fileEdits('Edit', { old_string: 'a'.repeat(5000), new_string: '' })[0].oldText).toHaveLength(4002)
    expect(fileEdits('Read', { file_path: '/a.ts' })).toEqual([])
    expect(fileEdits('Edit', null)).toEqual([])
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
