// Earned loot and permanent combat stats. Randomness is chosen once, outside retryable transactions.
import { RPG_CATALOG, RPG_ODDS, RPG_RARITIES, type RPGItem, type RPGState } from './rpg'

export const RPG_LOOT_VERSION = 1
export const RPG_UPGRADES = ['health', 'attack', 'movement'] as const
export function rpgStats(state: RPGState) {
  return {
    health: 100 + (state.upgrades.health ?? 0) * 15,
    attack: 15 + (state.upgrades.attack ?? 0) * 3,
    movement: 120 + (state.upgrades.movement ?? 0) * 6,
  }
}
/** The half-open ranges make boundary fixtures independent of the platform's random generator. */
export function drawRPGItem(roll: number, pick: number, odds: readonly number[] = RPG_ODDS): RPGItem {
  if (
    ![roll, pick].every(n => Number.isFinite(n) && n >= 0 && n < 1) ||
    odds.length !== RPG_RARITIES.length ||
    odds.some(n => !Number.isFinite(n) || n < 0) ||
    odds.reduce((a, b) => a + b, 0) !== 100
  )
    throw new Error('Invalid loot table or roll')
  let boundary = 0
  const tier = odds.findIndex(weight => {
    boundary += weight
    return roll * 100 < boundary
  })
  const items = RPG_CATALOG.filter(item => item.rarity === RPG_RARITIES[tier])
  const item = items[Math.floor(pick * items.length)]
  if (!item) throw new Error('Empty loot tier')
  return item
}
export function randomRPGItem(): RPGItem {
  const values = crypto.getRandomValues(new Uint32Array(2))
  return drawRPGItem(values[0] / 4294967296, values[1] / 4294967296)
}
/** The booster itself and its permanent opening receipt are the claim receipt. No separate badge inventory. */
export function grantRPGBooster(state: RPGState, id: string): RPGState {
  if (!id || id.length > 200) throw new Error('Invalid booster identity')
  if (state.boosters.includes(id) || Object.hasOwn(state.openings, id)) return state
  if (state.boosters.length + Object.keys(state.openings).length >= 10_000) throw new Error('Booster limit reached')
  return { ...state, boosters: [...state.boosters, id] }
}
export function rpgMilestones(state: RPGState) {
  return [
    { id: 'rpgWorker', done: state.receipts.filter(r => ['task', 'poolTask', 'review'].includes(r.kind)).length, target: 10 },
    { id: 'rpgVeteran', done: state.xp, target: 1000 },
    { id: 'rpgBoss', done: state.receipts.filter(r => r.kind === 'boss' && r.xp > 0).length, target: 1 },
  ]
}
export function claimRPGMilestones(state: RPGState): RPGState {
  return rpgMilestones(state)
    .filter(m => m.done >= m.target)
    .reduce((s, m) => grantRPGBooster(s, `achievement-v1-${m.id}`), state)
}
