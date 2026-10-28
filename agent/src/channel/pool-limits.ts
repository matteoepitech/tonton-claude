// A pool plans around each account's Claude plan (docs/pools.md): a Claude Code session's agent shares, sealed with the
// pool key, how much of its 5-hour and weekly windows is used and when the 5-hour one runs out at the current pace. The
// orchestrator's rules skip a session whose window runs out before a task would be done, and a session near its limit
// is told to hand its task over cleanly. OpenCode sessions have no Claude plan: nothing to share, nothing to skip, and
// they still get the simpler tasks first.

import { LimitForecast } from '../../../shared/limit-forecast'
import type { PoolLimits, PoolLimitWindow, PoolTask } from '../../../shared/pool-protocol'
import type { UsageLimit } from '../../../shared/protocol'

/** How long a task takes when it does not say: a small one an hour, a large one three. */
export const DEFAULT_HOURS = { simple: 1, large: 3 } as const
/** Within this of running out, a session holding a task is told to hand it over. */
export const HANDOVER_MS = 20 * 60_000
/** Above this share of its 5-hour window, a session hands its task over even without a forecast. */
const NEAR_PERCENT = 95
/** The same figures are posted again after this long, so the pool sees they are still current. */
const REFRESH_MS = 10 * 60_000
/** Changes closer than this to the last post wait for the next one. */
const MIN_INTERVAL_MS = 60_000

export const expectedHours = (task: Pick<PoolTask, 'hours' | 'size'>): number => task.hours ?? DEFAULT_HOURS[task.size ?? 'large']

/** What the session shares, from its status line's readings, with the forecast. Null when it has none. */
export class LimitsReporter {
  private readonly forecast = new LimitForecast()

  current(usage: { fiveHour?: UsageLimit; sevenDay?: UsageLimit } | undefined, now = Date.now()): PoolLimits | null {
    const fiveHour = usage?.fiveHour
    const sevenDay = usage?.sevenDay
    if (!fiveHour && !sevenDay) return null
    this.forecast.record([fiveHour], now)
    const runsOut = fiveHour ? this.forecast.runsOut(fiveHour, now) : null
    return {
      ...(fiveHour ? { fiveHour: window(fiveHour) } : {}),
      ...(sevenDay ? { sevenDay: window(sevenDay) } : {}),
      ...(runsOut ? { runsOutAt: runsOut.toISOString() } : {}),
    }
  }
}

const window = (limit: UsageLimit): PoolLimitWindow => ({ usedPercent: Math.round(limit.usedPercent * 10) / 10, resetsAt: limit.resetsAt })

/** What decides whether the figures are worth posting again: whole percents, reset times, the forecast to five minutes. */
export function limitsMark(limits: PoolLimits): string {
  const five = (iso: string | undefined) => (iso ? Math.round(Date.parse(iso) / 300_000) : '')
  return [
    Math.floor(limits.fiveHour?.usedPercent ?? -1),
    limits.fiveHour?.resetsAt ?? '',
    Math.floor(limits.sevenDay?.usedPercent ?? -1),
    limits.sevenDay?.resetsAt ?? '',
    five(limits.runsOutAt),
  ].join('/')
}

/** Whether to post now, given what this pool was last told and when. */
export function shouldPost(last: { mark: string; at: number } | undefined, mark: string, now: number): boolean {
  if (!last) return true
  if (last.mark === mark) return now - last.at >= REFRESH_MS
  return now - last.at >= MIN_INTERVAL_MS
}

/** Minutes, as a person says them. */
const inAbout = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return minutes < 90 ? `about ${minutes} min` : `about ${Math.round(minutes / 6) / 10} h`
}

/** Why a session's plan leaves no time for a task of `hours`, or null when it does. */
export function shortOfTime(limits: PoolLimits | undefined, hours: number, now = Date.now()): string | null {
  if (!limits) return null
  const five = limits.fiveHour
  const week = limits.sevenDay
  if (five && five.usedPercent >= 100 && Date.parse(five.resetsAt) > now) {
    return `its 5-hour window is used up for ${inAbout(Date.parse(five.resetsAt) - now)}`
  }
  if (week && week.usedPercent >= 100 && Date.parse(week.resetsAt) > now) {
    return `its weekly window is used up for ${inAbout(Date.parse(week.resetsAt) - now)}`
  }
  const runsOut = limits.runsOutAt ? Date.parse(limits.runsOutAt) : Number.NaN
  if (runsOut > now && runsOut < now + hours * 3_600_000) {
    return `its 5-hour window runs out in ${inAbout(runsOut - now)} at this pace, before this task's ${hours} h`
  }
  return null
}

/** When a session should hand its task over: its window runs out soon, or is nearly used up. Null otherwise. */
export function nearLimit(limits: PoolLimits | undefined, now = Date.now()): string | null {
  const five = limits?.fiveHour
  if (!limits || !five || !(Date.parse(five.resetsAt) > now)) return null
  const runsOut = limits.runsOutAt ? Date.parse(limits.runsOutAt) : Number.NaN
  if (runsOut > now && runsOut - now <= HANDOVER_MS) return `runs out in ${inAbout(runsOut - now)}`
  if (five.usedPercent >= NEAR_PERCENT) return `is ${Math.floor(five.usedPercent)} % used`
  return null
}

/** How pool_status and pool_overview show a session's plan. */
export function limitsView(tool: 'claude' | 'opencode', limits: PoolLimits | undefined, now = Date.now()) {
  if (tool === 'opencode') return 'no plan limit'
  if (!limits) return 'not shared yet'
  const runsOut = limits.runsOutAt ? Date.parse(limits.runsOutAt) : Number.NaN
  return {
    ...(limits.fiveHour ? { fiveHour: `${Math.floor(limits.fiveHour.usedPercent)} % used, resets ${limits.fiveHour.resetsAt}` } : {}),
    ...(limits.sevenDay ? { week: `${Math.floor(limits.sevenDay.usedPercent)} % used, resets ${limits.sevenDay.resetsAt}` } : {}),
    ...(runsOut > now ? { runsOut: `in ${inAbout(runsOut - now)} at this pace` } : {}),
  }
}
