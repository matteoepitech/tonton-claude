// A long turn earns its work time as it goes, not only when it ends: every ten minutes of work, a slice of the turn
// becomes a `turn` reward of its own, named by the turn and its rank (`<turn>#3`). The turn's own reward, when it ends,
// earns what the slices left. Each slice is a receipt under the work cap of a turn, so a turn of three hours earns its
// three hours, where one receipt stopped at an hour. Used for Claude Code (agent/src/transcript/work.ts) and OpenCode
// (agent/src/opencode/events.ts) alike.

import type { TurnFact } from './transcript/work'

/** The work a slice stands for. */
export const SLICE_SECONDS = 600
/** A longer silence between two sightings of a turn counts this much at most: a crash or a sleep is no work. */
const MAX_GAP_MS = 15 * 60_000
/** Turns followed at once, at most: a turn that never ended must not fill memory. */
const MAX_OPEN = 50

interface OpenTurn {
  /** Work seen so far, in milliseconds. */
  worked: number
  /** When the turn was last seen. */
  seen: number
  /** Slices already sent. */
  paid: number
}

export class TurnSlices {
  private readonly open = new Map<string, OpenTurn>()

  /** The turn `id` is still going at `now` (milliseconds): the slices its work reached since it was last seen. */
  progress(id: string, now: number): TurnFact[] {
    if (!Number.isFinite(now)) return []
    const turn = this.open.get(id)
    if (!turn) {
      this.open.set(id, { worked: 0, seen: now, paid: 0 })
      for (const old of this.open.keys()) if (this.open.size > MAX_OPEN) this.open.delete(old)
      return []
    }
    turn.worked += Math.min(MAX_GAP_MS, Math.max(0, now - turn.seen))
    turn.seen = Math.max(turn.seen, now)
    const reached = Math.floor(turn.worked / 1000 / SLICE_SECONDS)
    const at = new Date(turn.seen).toISOString()
    const slices: TurnFact[] = []
    for (let rank = turn.paid + 1; rank <= reached; rank++)
      slices.push({ id: `${id}#${rank}`, at, seconds: SLICE_SECONDS, prompted: false, slice: true })
    turn.paid = Math.max(turn.paid, reached)
    return slices
  }

  /** Time the turn spent on a permission prompt: it is no work. */
  waited(id: string, ms: number) {
    const turn = this.open.get(id)
    if (turn && Number.isFinite(ms) && ms > 0) turn.worked = Math.max(0, turn.worked - ms)
  }

  /** The turn `id` ended: its own reward keeps the work its slices did not pay. */
  end(id: string, turn: TurnFact): TurnFact {
    const paid = this.open.get(id)?.paid ?? 0
    this.open.delete(id)
    return paid ? { ...turn, seconds: Math.max(0, turn.seconds - paid * SLICE_SECONDS) } : turn
  }

  /** A turn that will not end, such as one a new prompt replaced. */
  forget(id: string) {
    this.open.delete(id)
  }
}
