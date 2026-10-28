// Loot boundaries, durable team eligibility and period scoring across pruned snapshots.
import { expect, test } from 'bun:test'
import { awardRPG, newRPGState, openRPGBooster, RPG_RARITIES, rpgReward, upgradeRPG } from '../rpg'
import { claimRPGMilestones, drawRPGItem, grantRPGBooster, rpgStats } from '../rpg-loot'
import { claimRPGTeam, newRPGPool, parseRPGPool, rpgGoalId, rpgStandings, syncRPGPool } from '../rpg-pool'
import { rpgDemoPool } from './rpg-fixture'

test('every rarity boundary and slot pick is deterministic; malformed tables never consume inventory', () => {
  const boundaries = [0, 0.6, 0.85, 0.95, 0.99]
  for (let i = 0; i < 5; i++) {
    expect(drawRPGItem(boundaries[i], 0).rarity).toBe(RPG_RARITIES[i])
    expect(drawRPGItem(i === 4 ? 0.999999 : boundaries[i + 1] - 0.000001, 0.999999).slot).toBe('trail')
  }
  for (const value of [-1, 1, NaN, Infinity]) expect(() => drawRPGItem(value, 0)).toThrow()
  expect(() => drawRPGItem(0, 0, [60, 25, 10, 4, 2])).toThrow()
  const hero = grantRPGBooster(newRPGState(), 'earned-v1')
  expect(() => openRPGBooster(hero, 'earned-v1', 'unknown')).toThrow()
  const once = openRPGBooster(hero, 'earned-v1', 'hat-legendary')
  expect(openRPGBooster(once, 'earned-v1', 'skin-common')).toEqual(once)
  const duplicate = openRPGBooster(grantRPGBooster(once, 'earned-v2'), 'earned-v2', 'hat-legendary')
  expect(duplicate.sparks).toBe(50)
  expect(grantRPGBooster(duplicate, 'earned-v2')).toEqual(duplicate)
})

test('combat caps boosters, upgrades preview actual stats and milestones claim once', async () => {
  let hero = newRPGState()
  for (let i = 0; i < 6; i++) hero = awardRPG(hero, await rpgReward('boss', `run-${i}`, '2026-10-28'))
  expect(hero.xp).toBe(300)
  expect(hero.boosters.filter(id => id.startsWith('boss-v1-'))).toHaveLength(4)
  const before = rpgStats(hero)
  hero = upgradeRPG(hero, 'health', 1)
  expect(rpgStats(hero).health - before.health).toBe(15)
  expect(() => upgradeRPG(hero, 'attack', 2)).toThrow()
  hero = claimRPGMilestones(hero)
  expect(hero.boosters).toContain('achievement-v1-rpgBoss')
  expect(claimRPGMilestones(hero)).toEqual(hero)
})

test('durable contributions ignore combat and survive deletion, departures, rejoining and run reset', () => {
  const state = rpgDemoPool()
  let ledger = syncRPGPool(newRPGPool(), state, 'alice', { ...newRPGState(), xp: 50000 })
  const goal = rpgGoalId(state, 3)
  expect(ledger.goals[goal].eligible).toEqual(['alice', 'bob'])
  expect(rpgStandings(ledger, state, 'run').map(r => [r.account, r.xp])).toEqual([
    ['alice', 120],
    ['bob', 90],
    ['viewer', 0],
  ])
  const pruned = { ...state, tasks: [], events: [], members: state.members.filter(m => m.account !== 'bob') }
  ledger = syncRPGPool(ledger, pruned, 'alice')
  expect(rpgStandings(ledger, pruned, 'run').find(r => r.account === 'bob')?.departed).toBe(true)
  expect(rpgStandings(ledger, pruned, 'today', new Date('2026-10-29'))[0].xp).toBe(0)
  const claimed = claimRPGTeam(newRPGState(), ledger, 'bob')
  expect(claimed.boosters).toEqual([goal])
  expect(claimRPGTeam(openRPGBooster(claimed, goal, 'hat-common'), ledger, 'bob').boosters).toEqual([])
  expect(claimRPGTeam(newRPGState(), ledger, 'viewer').boosters).toEqual([])
  const reset = { ...state, info: { ...state.info, name: 'Demo', startedAt: '2026-10-29T00:00:00Z' } }
  expect(rpgStandings(ledger, reset, 'run').every(r => r.xp === 0)).toBe(true)
  expect(rpgStandings(ledger, { ...reset, members: [] }, 'run').map(r => r.account)).toEqual(['alice', 'bob'])
  expect(rpgStandings(ledger, reset, 'all')[0].xp).toBe(120)
  expect(syncRPGPool(ledger, reset, 'alice').goals).toEqual(ledger.goals)
  expect(() => parseRPGPool({ ...ledger, version: 2 })).toThrow()
  expect(() => parseRPGPool({ ...ledger, profiles: { bad: { name: 'x', level: 1, equipped: { skin: 'unknown' } } } })).toThrow()
})
