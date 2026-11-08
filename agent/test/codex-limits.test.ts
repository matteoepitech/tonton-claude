import { describe, expect, test } from 'bun:test'
import { codexLimits } from '../src/codex/limits'

const at = (iso: string) => Date.parse(iso) / 1000

describe("Codex's plan windows", () => {
  test('a rollout snapshot gives the 5-hour and the weekly window, by their length', () => {
    const rollout = {
      limit_id: 'codex',
      primary: { used_percent: 42.5, window_minutes: 300, resets_at: at('2026-11-08T15:00:00Z') },
      secondary: { used_percent: 7, window_minutes: 10080, resets_at: at('2026-11-12T09:00:00Z') },
      plan_type: 'plus',
    }
    expect(codexLimits(rollout)).toEqual({
      fiveHour: { usedPercent: 42.5, resetsAt: '2026-11-08T15:00:00.000Z' },
      sevenDay: { usedPercent: 7, resetsAt: '2026-11-12T09:00:00.000Z' },
    })
  })

  test("the app-server's snapshot reads the same, and windows without a length go by their place", () => {
    expect(codexLimits({ primary: { usedPercent: 101, resetsAt: at('2026-11-08T15:00:00Z') }, secondary: null })).toEqual({
      fiveHour: { usedPercent: 100, resetsAt: '2026-11-08T15:00:00.000Z' },
    })
    expect(
      codexLimits({ primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: at('2026-11-12T09:00:00Z') } }).sevenDay?.usedPercent,
    ).toBe(3)
  })

  test('what cannot be read is left out', () => {
    expect(codexLimits(null)).toEqual({})
    expect(codexLimits({ primary: { used_percent: 'a lot' }, secondary: { used_percent: 5, window_minutes: 60, resets_at: 1 } })).toEqual(
      {},
    )
  })
})
