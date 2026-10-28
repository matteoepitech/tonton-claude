// Economy boundaries and durable claim identities, shared with the Swift implementation.
import { describe, expect, test } from 'bun:test'
import { decodePoolTask } from '../pool'
import { awardRPG, equipRPG, newRPGState, parseRPGState, RPG_CATALOG, RPG_RECEIPT_LIMIT, rpgLevel, rpgReward } from '../rpg'

describe('Tonton progression', () => {
  test('completion attribution survives decoding, reopening and reassignment', () => {
    const completion = {
      at: '2026-10-28T12:00:00Z',
      assignee: { account: 'author', session: 'original' },
      reviewer: { account: 'reviewer', session: 'review' },
    }
    const task = decodePoolTask({ title: 'Task', state: 'done', completion })
    expect(task?.completion).toEqual(completion)
    expect(decodePoolTask({ ...task, state: 'assigned', assignee: { account: 'other', session: 'new' } })?.completion).toEqual(completion)
    expect(decodePoolTask({ title: 'Old task', state: 'done' })?.completion).toBeUndefined()
    expect(decodePoolTask({ title: 'Unknown shape', state: 'done', completion: { at: 'bad', assignee: null } })?.completion).toBeUndefined()
  })
  test('level thresholds, milestones and replay', async () => {
    let state = newRPGState()
    const reward = await rpgReward('poolTask', 'pool/task', '2026-10-28T12:00:00Z')
    state = awardRPG(state, reward)
    expect(awardRPG(state, reward)).toBe(state)
    expect(rpgLevel(state.xp)).toBe(1)
    state = awardRPG(state, await rpgReward('poolTask', 'pool/next', '2026-10-28T12:00:00Z'))
    expect(state.xp).toBe(100)
    expect(state.boosters).toEqual(['level-2'])
    expect(state.owned).toEqual(['skin-common'])
    expect(rpgLevel(299)).toBe(2)
    expect(rpgLevel(300)).toBe(3)
    expect(rpgLevel(Number.MAX_SAFE_INTEGER)).toBe(100)
  })
  test('daily caps retain receipts and keep work separate from combat', async () => {
    let state = newRPGState()
    for (let i = 0; i < 22; i++) state = awardRPG(state, await rpgReward('poolTask', `${i}`, '2026-10-28'))
    expect(state.xp).toBe(1000)
    expect(state.receipts).toHaveLength(22)
    const capped = await rpgReward('poolTask', '21', '2026-10-29')
    expect(awardRPG(state, capped)).toBe(state)
    for (let i = 0; i < 5; i++) state = awardRPG(state, await rpgReward('boss', `${i}`, '2026-10-28'))
    expect(state.xp).toBe(1300)
    expect(state.sparks).toBe(140)
  })
  test('full receipt storage fails closed and unknown item ownership survives', async () => {
    const reward = await rpgReward('task', 'one', '2026-10-28')
    const state = newRPGState()
    state.receipts = Array.from({ length: RPG_RECEIPT_LIMIT }, () => ({ ...reward, id: '0'.repeat(64), xp: 0, sparks: 0 }))
    expect(() => awardRPG(state, reward)).toThrow('limit')
    state.owned.push('future-skin')
    expect(parseRPGState(state).owned).toContain('future-skin')
    expect(() => parseRPGState({ ...state, version: 2 })).toThrow()
    expect(() => parseRPGState({ ...state, xp: -1 })).toThrow()
  })
  test('catalog slots, ownership and equipment', () => {
    expect(new Set(RPG_CATALOG.map(i => i.id)).size).toBe(25)
    const state = newRPGState()
    expect(() => equipRPG(state, 'hat', 'hat-legendary')).toThrow()
    state.owned.push('hat-legendary')
    expect(() => equipRPG(state, 'skin', 'hat-legendary')).toThrow()
    const equipped = equipRPG(state, 'hat', 'hat-legendary')
    expect(equipped.equipped.hat).toBe('hat-legendary')
    expect(equipRPG(equipped, 'hat', null).equipped.hat).toBeUndefined()
  })
})
