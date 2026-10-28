// When a 5-hour window will be used up at the current pace, from the readings a session reports. Mirrors
// app/Sources/TontonCore/LimitForecast.swift; both check shared/test/limit-forecast.json. Each window, told apart by its
// reset time, keeps the last half hour of readings: the pace is how much it rose over that time.

import type { UsageLimit } from './protocol'

interface Reading {
  at: number
  percent: number
}

/** The pace is read over this much time, and needs at least `SHORTEST_MS` of it to say anything. */
export const FORECAST_SPAN_MS = 30 * 60_000
const SHORTEST_MS = 5 * 60_000

export class LimitForecast {
  private readings = new Map<number, Reading[]>()

  /** Keeps a reading of each window still running. Sessions on the same plan report the same window. */
  record(limits: (UsageLimit | null | undefined)[], now = Date.now()) {
    for (const limit of limits) {
      const resets = limit ? Date.parse(limit.resetsAt) : Number.NaN
      if (!limit || !(resets > now)) continue
      const list = this.readings.get(resets) ?? []
      const last = list.at(-1)
      // Sessions repeat the same figure every few seconds: a new reading only when it moves or a minute went by.
      if (last && last.percent === limit.usedPercent && now - last.at < 60_000) continue
      list.push({ at: now, percent: limit.usedPercent })
      this.readings.set(resets, list)
    }
    const recent = (list: Reading[]) => list.filter(r => now - r.at <= FORECAST_SPAN_MS)
    this.readings = new Map([...this.readings].filter(([resets]) => resets > now).map(([resets, list]) => [resets, recent(list)]))
  }

  /**
   * When the window reaches 100 % if usage keeps rising like in the last half hour. Null when it isn't rising, when it
   * would reset first, or when it is already full.
   */
  runsOut(limit: UsageLimit, now = Date.now()): Date | null {
    const resets = Date.parse(limit.resetsAt)
    if (!(limit.usedPercent < 100) || !(resets > now)) return null
    const list = (this.readings.get(resets) ?? []).filter(r => now - r.at <= FORECAST_SPAN_MS)
    const first = list[0]
    const last = list.at(-1)
    if (!first || !last) return null
    const elapsed = last.at - first.at
    const rise = last.percent - first.percent
    if (elapsed < SHORTEST_MS || !(rise > 0)) return null
    const end = now + (100 - limit.usedPercent) / (rise / elapsed)
    return end < resets ? new Date(end) : null
  }
}
