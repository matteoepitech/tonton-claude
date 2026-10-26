// Background tasks as Claude Code writes them in its transcripts (taken from a real session), and what the hook says then.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitsForBackground } from '../src/hook'
import { BACKGROUND_TTL_MS, runningTasks } from '../src/transcript/background'

const dir = mkdtempSync(join(tmpdir(), 'tonton-background-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// The hook reads the clock: the lines are dated from it.
const now = Date.now()
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
const result = (text: string, minutesAgo = 1) =>
  JSON.stringify({
    type: 'user',
    timestamp: at(minutesAgo),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] },
  })
const notification = (id: string, status: string, minutesAgo = 0) =>
  JSON.stringify({
    type: 'user',
    timestamp: at(minutesAgo),
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${id}</task-id>\n<output-file>/tmp/${id}.output</output-file>\n<status>${status}</status>\n<summary>Background command finished</summary>\n</task-notification>`,
    },
  })
const shell = (id: string, minutesAgo = 1) =>
  result(
    `Command running in background with ID: ${id}. Output is being written to: /tmp/${id}.output. You will be notified when it completes. To check interim output, use Read on that file path.`,
    minutesAgo,
  )
const agent = (id: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: at(1),
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          content: [
            {
              type: 'text',
              text: `Async agent launched successfully.\nagentId: ${id} (internal ID)\nYou will be notified when it completes.`,
            },
          ],
        },
      ],
    },
  })

describe('runningTasks', () => {
  test('a background shell runs until its notification says it is over', () => {
    expect(runningTasks([shell('bi8o5pw7k')], now)).toEqual(['bi8o5pw7k'])
    expect(runningTasks([shell('bi8o5pw7k'), notification('bi8o5pw7k', 'completed')], now)).toEqual([])
    expect(runningTasks([shell('bi8o5pw7k'), notification('bi8o5pw7k', 'failed')], now)).toEqual([])
  })

  test('background agents count too, and a TaskStop ends a task', () => {
    expect(runningTasks([agent('ab249dac865b63e60'), shell('b5iig1z64')], now)).toEqual(['ab249dac865b63e60', 'b5iig1z64'])
    const stopped = result('{"message":"Successfully stopped task: b5iig1z64 (bun mock.ts)","task_id":"b5iig1z64"}')
    expect(runningTasks([agent('ab249dac865b63e60'), shell('b5iig1z64'), stopped], now)).toEqual(['ab249dac865b63e60'])
  })

  test('a task silent for too long, junk and other results do not count', () => {
    expect(runningTasks([shell('old1234', BACKGROUND_TTL_MS / 60_000 + 1)], now)).toEqual([])
    expect(runningTasks(['not json', '{}', result('ok (build complete)'), notification('nothing', 'completed')], now)).toEqual([])
  })
})

describe('waitsForBackground', () => {
  const transcript = (lines: string[]) => {
    const file = join(dir, `${crypto.randomUUID()}.jsonl`)
    writeFileSync(file, `${lines.join('\n')}\n`)
    return file
  }

  test('the end of a turn, or "waiting for your input", while a task runs, say what the session waits for', () => {
    const running = transcript([shell('bi8o5pw7k', 0), shell('b9k2v9lm8', 0)])
    expect(waitsForBackground({ hook_event_name: 'Stop', transcript_path: running })).toBe('Waiting for 2 background tasks')
    expect(waitsForBackground({ hook_event_name: 'Notification', notification_type: 'idle_prompt', transcript_path: running })).toBe(
      'Waiting for 2 background tasks',
    )
  })

  test('a permission request, a turn with nothing in the background, or another event stay as they are', () => {
    const running = transcript([shell('bi8o5pw7k', 0)])
    expect(
      waitsForBackground({ hook_event_name: 'Notification', notification_type: 'permission_prompt', transcript_path: running }),
    ).toBeNull()
    expect(waitsForBackground({ hook_event_name: 'UserPromptSubmit', transcript_path: running })).toBeNull()
    expect(
      waitsForBackground({
        hook_event_name: 'Stop',
        transcript_path: transcript([shell('x123456', 0), notification('x123456', 'completed')]),
      }),
    ).toBeNull()
    expect(waitsForBackground({ hook_event_name: 'Stop', transcript_path: join(dir, 'missing.jsonl') })).toBeNull()
  })
})
