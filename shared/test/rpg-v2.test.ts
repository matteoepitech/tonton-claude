// Rules version 2: the shared fixtures, the reward details and the compatibility with released version 1 readers.
import { describe, expect, test } from 'bun:test'
import {
  awardRPG,
  awardRPGAt,
  equipRPG,
  isRPGReward,
  newRPGState,
  openRPGBooster,
  parseRPGState,
  type RPGRewardKind,
  type RPGState,
  rpgLevel,
  rpgReward,
} from '../rpg'
import { rpgJournal, rpgToday } from '../rpg-journal'
import { parseV1State } from './rpg-v1-reader'
import vectors from './rpg-v2-vectors.json'

interface Step {
  kind: string
  source: string
  at: string
  seconds?: number
  prompted?: boolean
  note?: string
  times?: number
}

async function play(start: unknown, steps: Step[], now: number): Promise<RPGState> {
  let state = start ? parseRPGState(structuredClone(start)) : newRPGState()
  for (const step of steps)
    for (let i = 0; i < (step.times ?? 1); i++) {
      const source = step.times ? `${step.source}${i}` : step.source
      const reward = await rpgReward(step.kind as RPGRewardKind, source, step.at, step)
      state = awardRPGAt(state, reward, now)
      parseRPGState(state)
    }
  return state
}

describe('rules version 2 fixtures', () => {
  for (const c of vectors.cases)
    test(c.name, async () => {
      const state = await play((c as { start?: unknown }).start, c.rewards, Date.parse(c.now))
      const e = c.expect
      expect([state.xp, state.sparks, rpgLevel(state.xp)]).toEqual([e.xp, e.sparks, e.level])
      expect(state.boosters).toEqual(e.boosters)
      expect(state.owned).toEqual(e.owned)
      expect([state.receipts.length, state.gains?.length ?? 0]).toEqual([e.receipts, e.gains])
      for (const t of e.today) {
        const today = rpgToday(state, Date.parse(t.now))
        const hours = Array.from({ length: 24 }, (_, h) => (t.hours as Record<string, number>)[`${h}`] ?? 0)
        expect(today).toEqual({ day: t.day, xp: t.xp, streak: t.streak, hours })
      }
      if ('journal' in e && e.journal) expect(rpgJournal(state, e.journal.length)).toEqual(e.journal as never)
    })
})

describe('reward details', () => {
  test('a time is kept only in UTC, on the reward day', async () => {
    expect((await rpgReward('task', 'x', '2026-11-04')).at).toBeUndefined()
    expect((await rpgReward('task', 'x', '2026-11-04T10:00:00+01:00')).at).toBeUndefined()
    expect((await rpgReward('turn', 'x', '2026-11-04T10:00:00.123Z')).at).toBe('2026-11-04T10:00:00.123Z')
    const reward = await rpgReward('turn', 'x', '2026-11-04T10:00:00Z')
    expect(isRPGReward({ ...reward, at: '2026-11-05T10:00:00Z' })).toBe(false)
    expect(isRPGReward({ ...reward, seconds: 86_401 })).toBe(false)
    expect(isRPGReward({ ...reward, prompted: 'yes' })).toBe(false)
    expect(isRPGReward({ ...reward, kind: 'idle' })).toBe(false)
  })
  test('seconds are clamped and notes cut on a character', async () => {
    expect((await rpgReward('turn', 'x', '2026-11-04T10:00:00Z', { seconds: -3 })).seconds).toBe(0)
    expect((await rpgReward('turn', 'x', '2026-11-04T10:00:00Z', { seconds: 90_000.7 })).seconds).toBe(86_400)
    const note = (await rpgReward('push', 'x', '2026-11-04T10:00:00Z', { note: `  ${'a'.repeat(79)}🎮b ` })).note
    expect(note).toBe('a'.repeat(79))
    expect((await rpgReward('push', 'x', '2026-11-04T10:00:00Z', { note: '   ' })).note).toBeUndefined()
  })
  test('the id ignores the details, so a replay with other numbers is the same reward', async () => {
    const a = await rpgReward('turn', 's\nt', '2026-11-04T10:00:00Z', { seconds: 60, prompted: true })
    const b = await rpgReward('turn', 's\nt', '2026-11-04T11:00:00Z', { seconds: 600, prompted: true })
    expect(a.id).toBe(b.id)
    const state = awardRPGAt(newRPGState(), a, Date.parse('2026-11-04T12:00:00Z'))
    expect(awardRPGAt(state, b, Date.parse('2026-11-04T12:00:00Z'))).toBe(state)
  })
  test('version 1 kinds stay in receipts and version 2 kinds in gains', async () => {
    const now = Date.parse('2026-11-04T12:00:00Z')
    const turn = awardRPGAt(newRPGState(), await rpgReward('turn', 'x', '2026-11-04T10:00:00Z', { seconds: 600 }), now)
    expect(() => parseRPGState({ ...turn, receipts: turn.gains, gains: [] })).toThrow()
    const task = awardRPG(newRPGState(), await rpgReward('task', 'x', '2026-11-04'))
    expect(task.gains).toBeUndefined()
    expect(() => parseRPGState({ ...task, gains: task.receipts })).toThrow()
    expect(() => parseRPGState({ ...turn, gains: [{ ...turn.gains?.[0], xp: 66 }] })).toThrow()
  })
})

describe('compatibility with version 1', () => {
  const now = Date.parse('2026-11-04T18:00:00Z')
  async function hero(): Promise<RPGState> {
    let state = newRPGState()
    for (let i = 0; i < 4; i++)
      state = awardRPGAt(state, await rpgReward('turn', `s\n${i}`, '2026-11-04T10:00:00Z', { seconds: 3600, prompted: true }), now)
    state = awardRPGAt(state, await rpgReward('task', 's\nWrite it', '2026-11-04T10:30:00Z'), now)
    return awardRPGAt(state, await rpgReward('day', '2026-11-04', '2026-11-04T10:00:00Z'), now)
  }
  test('a version 1 hero opens and keeps its XP, level, boosters and items', async () => {
    const v1 = (await import('./rpg-vectors.json')).default.state
    const state = parseRPGState(structuredClone(v1))
    expect([state.xp, state.boosters, state.owned, state.gains]).toEqual([v1.xp, v1.boosters, v1.owned, undefined])
    const next = awardRPGAt(state, await rpgReward('turn', 's\nfirst', '2026-11-04T10:00:00Z', { seconds: 120 }), now)
    expect(next.receipts).toEqual(state.receipts)
    expect(next.xp).toBe(v1.xp + 2)
  })
  test('released readers open a version 2 hero with the same XP, level and items', async () => {
    const state = await hero()
    const read = parseV1State(JSON.parse(JSON.stringify(state))) as RPGState
    expect([read.xp, rpgLevel(read.xp), read.sparks, read.boosters, read.owned]).toEqual([
      state.xp,
      rpgLevel(state.xp),
      state.sparks,
      state.boosters,
      state.owned,
    ])
  })
  test('released writers keep the gains: they spread the state they read', async () => {
    const state = await hero()
    const read = parseV1State(JSON.parse(JSON.stringify(state))) as RPGState
    const equipped = openRPGBooster(equipRPG(read, 'skin', 'skin-common'), 'level-2', 'hat-rare')
    expect(parseRPGState(equipped).gains).toEqual(state.gains)
  })
})
