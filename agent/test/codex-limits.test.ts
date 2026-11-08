import { describe, expect, test } from 'bun:test'
import { codexPlanWindows } from '../src/codex/limits'
import { CodexRollout } from '../src/codex/rollout'

describe("Codex's plan windows", () => {
  test("a rollout's token_count gives the 5-hour and the weekly window, by their length", () => {
    const line = {
      timestamp: '2026-11-08T10:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 42.5, window_minutes: 300, resets_at: Date.parse('2026-11-08T15:00:00Z') / 1000 },
          secondary: { used_percent: 7, window_minutes: 10080, resets_at: Date.parse('2026-11-12T09:00:00Z') / 1000 },
          plan_type: 'plus',
        },
      },
    }
    const parsed = new CodexRollout().line(JSON.stringify(line))
    expect(codexPlanWindows(parsed.rateLimits)).toEqual({
      codexFiveHourLimit: { usedPercent: 42.5, resetsAt: '2026-11-08T15:00:00.000Z' },
      codexSevenDayLimit: { usedPercent: 7, resetsAt: '2026-11-12T09:00:00.000Z' },
    })
  })

  test('windows without a length go by their place, and what cannot be read is left out', () => {
    expect(codexPlanWindows({ primary: { usedPercent: 101, resetsAt: '2026-11-08T15:00:00.000Z' } })).toEqual({
      codexFiveHourLimit: { usedPercent: 100, resetsAt: '2026-11-08T15:00:00.000Z' },
    })
    expect(codexPlanWindows({ secondary: { usedPercent: 3, resetsAt: '2026-11-12T09:00:00.000Z' } }).codexSevenDayLimit?.usedPercent).toBe(
      3,
    )
    expect(codexPlanWindows({ primary: { usedPercent: 5, windowMinutes: 60, resetsAt: '2026-11-08T15:00:00.000Z' } })).toEqual({})
    expect(codexPlanWindows({ primary: { usedPercent: 5 } })).toEqual({})
    expect(codexPlanWindows(undefined)).toEqual({})
  })
})
