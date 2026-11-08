// Codex's plan windows (ChatGPT plans: a 5-hour one and a weekly one), as the rollout parser reads them from
// `token_count` events. They go in the session's meta apart from Claude's (SessionMeta.codexFiveHourLimit): they are
// another account's plan, which an app reading the session as Claude Code must not count as its Claude plan.

import type { UsageLimit } from '../../../shared/protocol'
import type { CodexRateLimits, CodexRateWindow } from './rollout'

const FIVE_HOURS = 300
const ONE_WEEK = 7 * 24 * 60

export interface CodexPlanWindows {
  codexFiveHourLimit?: UsageLimit
  codexSevenDayLimit?: UsageLimit
}

const limit = (window: CodexRateWindow): UsageLimit | null =>
  window.resetsAt && Number.isFinite(Date.parse(window.resetsAt))
    ? { usedPercent: Math.min(100, Math.max(0, window.usedPercent)), resetsAt: window.resetsAt }
    : null

/**
 * The 5-hour and weekly windows of Codex's latest reading. Each goes by its length when Codex gives it, else by its
 * place: primary is the short one, secondary the weekly one. A window of another length, or without a reset time, is left out.
 */
export function codexPlanWindows(limits: CodexRateLimits | undefined): CodexPlanWindows {
  const found: CodexPlanWindows = {}
  for (const [place, window] of [
    ['primary', limits?.primary],
    ['secondary', limits?.secondary],
  ] as const) {
    const read = window && limit(window)
    if (!window || !read) continue
    const minutes = window.windowMinutes ?? (place === 'primary' ? FIVE_HOURS : ONE_WEEK)
    if (minutes === FIVE_HOURS) found.codexFiveHourLimit = read
    else if (minutes === ONE_WEEK) found.codexSevenDayLimit = read
  }
  return found
}
