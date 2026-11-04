// What the hero screens show about recent work: today's XP, the streak and the journal. Mirrored by TontonCore/RPGJournal.swift.
import type { RPGReceipt, RPGRewardKind, RPGState } from './rpg'
import { rpgShiftDay } from './rpg'

export interface RPGToday {
  /** The UTC day these numbers are for. */
  day: string
  xp: number
  /** Days in a row with a turn, ending today, or yesterday until today's first turn. */
  streak: number
  /** XP per UTC hour of the day, from the receipts that carry a time. */
  hours: number[]
}

export interface RPGJournalEntry {
  id: string
  kind: RPGRewardKind
  xp: number
  sparks: number
  day: string
  at?: string
  seconds?: number
  note?: string
}

const all = (state: RPGState): RPGReceipt[] => [...state.receipts, ...(state.gains ?? [])]

export function rpgToday(state: RPGState, now: number = Date.now()): RPGToday {
  const day = new Date(now).toISOString().slice(0, 10)
  const hours = Array.from({ length: 24 }, () => 0)
  let xp = 0
  for (const r of all(state)) {
    if (r.day !== day) continue
    xp += r.xp
    if (r.at) hours[Number(r.at.slice(11, 13))] += r.xp
  }
  const days = new Set((state.gains ?? []).filter(r => r.kind === 'day').map(r => r.day))
  let cursor = days.has(day) ? day : rpgShiftDay(day, -1)
  let streak = 0
  while (days.has(cursor)) {
    streak++
    cursor = rpgShiftDay(cursor, -1)
  }
  return { day, xp, streak, hours }
}

/** The last gains, newest first. Older receipts without a time sort by their day. Code-unit order, as in Swift. */
export function rpgJournal(state: RPGState, limit = 20): RPGJournalEntry[] {
  const order = (r: RPGReceipt) => r.at ?? r.day
  return all(state)
    .filter(r => r.xp > 0)
    .sort((a, b) => (order(a) < order(b) ? 1 : order(a) > order(b) ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, Math.max(0, limit))
    .map(({ id, kind, xp, sparks, day, at, seconds, note }) => ({
      id,
      kind,
      xp,
      sparks,
      day,
      ...(at === undefined ? {} : { at }),
      ...(seconds === undefined ? {} : { seconds }),
      ...(note === undefined ? {} : { note }),
    }))
}
