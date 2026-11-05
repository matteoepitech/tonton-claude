import { describe, expect, test } from 'bun:test'
import { awardRPGAt, newRPGState } from '../../shared/rpg'
import { OpenCodeTracker } from '../src/opencode/events'
import { SLICE_SECONDS, TurnSlices } from '../src/rpg-slices'
import { turnRewards } from '../src/rpg-work'
import type { TurnFact } from '../src/transcript/work'
import { assistant, at, claude, ended, T0, user } from './rpg-fixtures'

const minute = 60_000

describe('a long turn earns as it goes', () => {
  test('ten minutes of work make a slice, and the turn keeps what the slices left', () => {
    const slices = new TurnSlices()
    const seen = [0, 4, 8, 12, 16, 21, 25].flatMap(minutes => slices.progress('u1', T0 + minutes * minute))
    expect(seen.map(slice => slice.id)).toEqual(['u1#1', 'u1#2'])
    expect(seen[0]).toEqual({ id: 'u1#1', at: at(12 * 60), seconds: SLICE_SECONDS, prompted: false, slice: true })
    const turn = slices.end('u1', { id: 'd1', at: at(27 * 60), seconds: 27 * 60, prompted: true })
    expect(turn).toEqual({ id: 'd1', at: at(27 * 60), seconds: 7 * 60, prompted: true })
  })

  test('a silence counts a quarter of an hour at most, and a permission prompt is no work', () => {
    const slices = new TurnSlices()
    slices.progress('u1', T0)
    expect(slices.progress('u1', T0 + 3 * 3600_000)).toHaveLength(1)
    slices.waited('u1', 9 * minute)
    expect(slices.progress('u1', T0 + 3 * 3600_000 + 8 * minute)).toEqual([])
  })

  test('a three-hour Claude Code turn earns its three hours, where one receipt stopped at the first', () => {
    const lines: object[] = [user('u1', 0, 'Build the level', { origin: { kind: 'human' } })]
    for (let minutes = 5; minutes < 180; minutes += 5)
      lines.push(assistant(`a${minutes}`, minutes * 60, [{ type: 'text', text: 'working' }]))
    lines.push(ended('d1', 180 * 60, 180 * minute))
    const { turns } = claude(lines)
    const slices = turns.filter(turn => turn.slice)
    expect(slices).toHaveLength(17)
    expect(slices[0].id).toBe('u1#1')
    expect(turns.at(-1)).toEqual({ id: 'd1', at: at(180 * 60), seconds: 10 * 60, prompted: true })
    expect(turns.reduce((sum, turn) => sum + turn.seconds, 0)).toBe(180 * 60)
  })

  test('a slice earns ten XP, the journal says ten minutes of work in its project', async () => {
    const slice: TurnFact = { id: 'u1#1', at: at(600), seconds: SLICE_SECONDS, prompted: false, slice: true }
    const rewards = await turnRewards('ses', slice, '/work/hero')
    expect(rewards).toHaveLength(1)
    expect(rewards[0]).toMatchObject({ kind: 'turn', seconds: 600, prompted: false, note: 'hero' })
    expect(awardRPGAt(newRPGState(), rewards[0], T0 + 3600_000).xp).toBe(10)
  })

  test('a short turn is paid as before, in one reward', () => {
    const { turns } = claude([user('u1', 0, 'Fix it', { origin: { kind: 'human' } }), assistant('a1', 120, []), ended('d1', 180, 180_000)])
    expect(turns).toEqual([{ id: 'd1', at: at(180), seconds: 180, prompted: true }])
  })

  test('an OpenCode turn earns as it goes too, named by its prompt', () => {
    const tracker = new OpenCodeTracker()
    const event = (minutes: number, type: string) => ({
      id: crypto.randomUUID(),
      created: T0 + minutes * minute,
      type,
      data: { sessionID: 's' },
    })
    const turns: TurnFact[] = []
    for (const minutes of [0, 6, 12, 18, 24])
      for (const update of tracker.handle(event(minutes, 'session.execution.started'))) turns.push(...(update.turns ?? []))
    for (const update of tracker.handle(event(26, 'session.execution.succeeded'))) turns.push(...(update.turns ?? []))
    expect(turns.filter(turn => turn.slice).map(turn => turn.id)).toEqual([`s:${T0}#1`, `s:${T0}#2`])
    expect(turns.at(-1)).toMatchObject({ id: `s:${T0}`, seconds: 6 * 60 })
    expect(turns.at(-1)?.slice).toBeUndefined()
  })
})
