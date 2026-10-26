// Plan usage of the account a session runs on. Claude Code only shares it with its status line (see statusline.ts), which
// leaves it in run/ for the channel of the same session.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UsageLimit } from '../../shared/protocol'
import { paths } from './config'

export interface SessionUsage {
  fiveHourLimit?: UsageLimit
  sevenDayLimit?: UsageLimit
  /** Claude Code's own estimate for the session, live, unlike the cost it writes to the transcript when it exits. */
  costUSD?: number
}

interface Window {
  used_percentage?: unknown
  resets_at?: unknown
}

/** A window of `rate_limits` in the status line input: a percentage and a reset time in Unix seconds. */
export function statusLineLimit(input: unknown, name: 'five_hour' | 'seven_day' = 'five_hour'): UsageLimit | undefined {
  const window = (input as { rate_limits?: Record<string, Window | undefined> } | null)?.rate_limits?.[name]
  return limit(window?.used_percentage, window?.resets_at)
}

/** Both windows and the cost of the status line input, leaving out what it does not report. */
export function statusLineUsage(input: unknown): SessionUsage {
  const fiveHourLimit = statusLineLimit(input, 'five_hour')
  const sevenDayLimit = statusLineLimit(input, 'seven_day')
  const cost = (input as { cost?: { total_cost_usd?: unknown } } | null)?.cost?.total_cost_usd
  const costUSD = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined
  return {
    ...(fiveHourLimit ? { fiveHourLimit } : {}),
    ...(sevenDayLimit ? { sevenDayLimit } : {}),
    ...(costUSD !== undefined ? { costUSD } : {}),
  }
}

/** Builds a limit from Claude Code's numbers, or nothing when they are missing or out of range. */
export function limit(usedPercent: unknown, resetsAtSeconds: unknown): UsageLimit | undefined {
  if (typeof usedPercent !== 'number' || typeof resetsAtSeconds !== 'number') return undefined
  if (!Number.isFinite(usedPercent) || !Number.isFinite(resetsAtSeconds) || resetsAtSeconds <= 0) return undefined
  return { usedPercent: Math.min(100, Math.max(0, usedPercent)), resetsAt: new Date(resetsAtSeconds * 1000).toISOString() }
}

/**
 * The most recent of two readings. Usage only grows within a window, so with the same reset time the higher one is newer;
 * a later reset time means a new window.
 */
export function newerLimit(a: UsageLimit | undefined, b: UsageLimit | undefined): UsageLimit | undefined {
  if (!a || !b) return a ?? b
  if (a.resetsAt !== b.resetsAt) return Date.parse(a.resetsAt) > Date.parse(b.resetsAt) ? a : b
  return a.usedPercent >= b.usedPercent ? a : b
}

export function usageFile(sessionId: string): string {
  return join(paths.run, `usage-${sessionId.replace(/[^\w-]/g, '_')}.json`)
}

export function writeUsage(sessionId: string, usage: SessionUsage) {
  mkdirSync(paths.run, { recursive: true, mode: 0o700 })
  const file = usageFile(sessionId)
  // The channel polls the file: replace it in one step so it never reads half of it.
  const partial = `${file}.${process.pid}.tmp`
  writeFileSync(partial, JSON.stringify(usage), { mode: 0o600 })
  renameSync(partial, file)
}

/** The raw file, so callers can skip work when it did not change. Null when there is none. */
export function readUsageFile(sessionId: string): string | null {
  try {
    return readFileSync(usageFile(sessionId), 'utf8')
  } catch {
    return null
  }
}
