// Sections of a session list folded to their header, as in the notch (app/Sources/TontonCore/SessionFolding.swift): the
// header says how many sessions it hides and the most pressing one that needs the user.

import type { SessionStatus } from './protocol'
import type { Session } from './session'

/** The same key as the notch's for a machine. */
export const machineFoldKey = (machine: string) => `machine:${machine}`

export interface FoldSummary {
  hidden: number
  /** A request first, then an error, then a question. */
  attention: SessionStatus | null
}

export function foldSummary(sessions: readonly Pick<Session, 'status'>[]): FoldSummary {
  const statuses = new Set(sessions.map(s => s.status))
  const attention = (['permission', 'error', 'waiting'] as const).find(status => statuses.has(status)) ?? null
  return { hidden: sessions.length, attention }
}

export function toggledFold(folded: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(folded)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}
