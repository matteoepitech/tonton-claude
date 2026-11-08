// Codex's plan windows (ChatGPT plans: a 5-hour one and a weekly one), as its rollouts write them in `token_count`
// events (`rate_limits`, snake_case) and its app-server sends them (`account/rateLimits/updated`, camelCase). Read as
// Claude's windows are, but sent apart from them (SessionMeta.codexFiveHourLimit): they are another account's plan.

import type { UsageLimit } from '../../../shared/protocol'

export interface CodexLimits {
  fiveHour?: UsageLimit
  sevenDay?: UsageLimit
}

const FIVE_HOURS = 300
const ONE_WEEK = 7 * 24 * 60

const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** One window: its use, its length in minutes, and when it resets (seconds since 1970), whichever spelling. */
function window(value: unknown): { limit: UsageLimit; minutes?: number } | null {
  if (!value || typeof value !== 'object') return null
  const w = value as Record<string, unknown>
  const used = number(w.used_percent ?? w.usedPercent)
  const resets = number(w.resets_at ?? w.resetsAt)
  if (used === undefined || resets === undefined) return null
  const minutes = number(w.window_minutes ?? w.windowDurationMins)
  return {
    limit: { usedPercent: Math.min(100, Math.max(0, used)), resetsAt: new Date(resets * 1000).toISOString() },
    ...(minutes === undefined ? {} : { minutes }),
  }
}

/**
 * The 5-hour and weekly windows of a rate-limit snapshot. Each goes by its length when Codex gives it, else by its
 * place: primary is the short one, secondary the weekly one. A window of another length is left out.
 */
export function codexLimits(snapshot: unknown): CodexLimits {
  if (!snapshot || typeof snapshot !== 'object') return {}
  const s = snapshot as Record<string, unknown>
  const found: CodexLimits = {}
  for (const [place, value] of [
    ['primary', s.primary],
    ['secondary', s.secondary],
  ] as const) {
    const read = window(value)
    if (!read) continue
    const minutes = read.minutes ?? (place === 'primary' ? FIVE_HOURS : ONE_WEEK)
    if (minutes === FIVE_HOURS) found.fiveHour = read.limit
    else if (minutes === ONE_WEEK) found.sevenDay = read.limit
  }
  return found
}
