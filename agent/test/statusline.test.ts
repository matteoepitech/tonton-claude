import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultLine, isTontonStatusLine, userStatusLine } from '../src/statusline'
import { limit, newerLimit, statusLineLimit, statusLineUsage } from '../src/usage'

const AGENT = join(import.meta.dir, '../src/main.ts')
const dir = mkdtempSync(join(tmpdir(), 'tonton-statusline-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** What Claude Code pipes to a status line, trimmed to the fields that matter here. */
const input = {
  session_id: 'b2f1c0de-0000-4000-8000-000000000001',
  model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  context_window: { used_percentage: 23.4 },
  rate_limits: { five_hour: { used_percentage: 41.2, resets_at: 1792497600 }, seven_day: { used_percentage: 10, resets_at: 1793000000 } },
}

function settings(file: string, statusLine: object) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ model: 'opus', statusLine }))
}

describe('usage readings', () => {
  test('the 5-hour window of the status line input', () => {
    expect(statusLineLimit(input)).toEqual({ usedPercent: 41.2, resetsAt: '2026-10-20T12:00:00.000Z' })
    expect(statusLineLimit({ model: {} })).toBeUndefined()
    expect(statusLineLimit({ rate_limits: { five_hour: { used_percentage: '41', resets_at: 1 } } })).toBeUndefined()
    expect(statusLineLimit(null)).toBeUndefined()
    expect(limit(140, 1792497600)?.usedPercent).toBe(100)
  })

  test('both windows, leaving out the ones Claude Code does not report', () => {
    expect(statusLineUsage(input)).toEqual({
      fiveHourLimit: { usedPercent: 41.2, resetsAt: '2026-10-20T12:00:00.000Z' },
      sevenDayLimit: { usedPercent: 10, resetsAt: '2026-10-26T07:33:20.000Z' },
      model: 'claude-opus-5-5',
    })
    expect(statusLineUsage({ rate_limits: { seven_day: { used_percentage: 99, resets_at: 1793000000 } } })).toEqual({
      sevenDayLimit: { usedPercent: 99, resetsAt: '2026-10-26T07:33:20.000Z' },
    })
    expect(statusLineUsage({})).toEqual({})
    expect(statusLineUsage({ cost: { total_cost_usd: 1.25 } })).toEqual({ costUSD: 1.25 })
    expect(statusLineUsage({ cost: { total_cost_usd: '1.25' } })).toEqual({})
    expect(statusLineUsage({ context_window: { context_window_size: 1000000 } })).toEqual({ contextWindow: 1000000 })
  })

  test('the model it names, which changes as soon as the user switches', () => {
    expect(statusLineUsage({ model: { id: 'claude-sonnet-5-5[1m]', display_name: 'Sonnet 5.5' } })).toEqual({
      model: 'claude-sonnet-5-5[1m]',
    })
    expect(statusLineUsage({ model: { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' } }).model).toBe(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    )
    for (const id of [42, '', '<synthetic>', 'claude opus', 'x'.repeat(101), 'opus\n'])
      expect(statusLineUsage({ model: { id } })).toEqual({})
  })

  test('the newest reading wins: a later reset, or more usage in the same window', () => {
    const at = (usedPercent: number, resetsAt: string) => ({ usedPercent, resetsAt })
    const before = at(90, '2026-10-21T17:00:00.000Z')
    const after = at(5, '2026-10-21T22:00:00.000Z')
    expect(newerLimit(before, after)).toBe(after)
    expect(newerLimit(after, before)).toBe(after)
    expect(newerLimit(before, at(100, before.resetsAt))).toEqual(at(100, before.resetsAt))
    expect(newerLimit(at(100, before.resetsAt), before)).toEqual(at(100, before.resetsAt))
    expect(newerLimit(undefined, before)).toBe(before)
    expect(newerLimit(before, undefined)).toBe(before)
  })
})

describe('status line', () => {
  test("finds the user's own, in the order Claude Code reads settings", () => {
    const project = join(dir, 'project')
    const config = join(dir, 'config')
    expect(userStatusLine(project, config)).toBeNull()
    settings(join(config, 'settings.json'), { type: 'command', command: '~/.claude/statusline.sh' })
    expect(userStatusLine(project, config)).toBe('~/.claude/statusline.sh')
    settings(join(project, '.claude', 'settings.json'), { type: 'command', command: 'project-line' })
    expect(userStatusLine(project, config)).toBe('project-line')
    settings(join(project, '.claude', 'settings.local.json'), { type: 'command', command: 'local-line' })
    expect(userStatusLine(project, config)).toBe('local-line')
    // Never itself, which would loop.
    settings(join(project, '.claude', 'settings.local.json'), { type: 'command', command: "'/home/x/.tonton/bin/tonton' statusline" })
    expect(userStatusLine(project, config)).toBe('project-line')
    expect(userStatusLine(undefined, config)).toBe('~/.claude/statusline.sh')
  })

  test('recognizes its own command on every platform', () => {
    expect(isTontonStatusLine("'/home/x/.tonton/bin/tonton' statusline")).toBe(true)
    expect(isTontonStatusLine('~/.tonton/bin/tonton.exe statusline')).toBe(true)
    expect(isTontonStatusLine('~/.claude/statusline.sh')).toBe(false)
  })

  test('without one of their own, users get a short line', () => {
    expect(defaultLine(input)).toBe('Opus · 23% context · 5h 41%')
    expect(defaultLine({ model: { display_name: 'Opus' } })).toBe('Opus')
  })

  test.skipIf(process.platform === 'win32')('records the usage for the channel and shows the user status line', async () => {
    const home = join(dir, 'agent')
    const config = join(dir, 'claude')
    const run = async (stdin: object) => {
      const env = { ...process.env, TONTON_HOME: home, CLAUDE_CONFIG_DIR: config } as Record<string, string>
      const child = Bun.spawn(['bun', AGENT, 'statusline'], { env, stdin: new Blob([JSON.stringify(stdin)]), stdout: 'pipe' })
      return { output: await new Response(child.stdout).text(), code: await child.exited }
    }

    expect(await run(input)).toEqual({ output: 'Opus · 23% context · 5h 41%', code: 0 })
    const usage = JSON.parse(readFileSync(join(home, 'run', `usage-${input.session_id}.json`), 'utf8'))
    expect(usage).toEqual(statusLineUsage(input))

    // The user's command gets the same input.
    settings(join(config, 'settings.json'), {
      type: 'command',
      command: `bun -e 'const i = JSON.parse(await Bun.stdin.text()); console.log("mine", i.model.id)'`,
    })
    expect(await run(input)).toEqual({ output: 'mine claude-opus-5-5\n', code: 0 })
    // A failing one goes blank, as it would without Tonton Claude.
    settings(join(config, 'settings.json'), { type: 'command', command: 'echo partial; exit 3' })
    expect(await run(input)).toEqual({ output: '', code: 0 })
    // Garbage in does not break claude's status line.
    expect((await run({ nonsense: true })).code).toBe(0)
  })
})
