// Tonton's versioned economy and inventory. Pure, browser-safe rules mirrored by TontonCore/RPG.swift.

export const RPG_VERSION = 1
export const RPG_RECEIPT_LIMIT = 10_000
export const RPG_SLOTS = ['skin', 'hat', 'accessory', 'aura', 'trail'] as const
export const RPG_RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const
export type RPGSlot = (typeof RPG_SLOTS)[number]
export type RPGRarity = (typeof RPG_RARITIES)[number]
export type RPGRewardKind = 'task' | 'poolTask' | 'review' | 'encounter' | 'boss'
export interface RPGReward {
  id: string
  kind: RPGRewardKind
  day: string
}
export interface RPGReceipt extends RPGReward {
  xp: number
  sparks: number
}
export interface RPGState {
  version: number
  xp: number
  sparks: number
  receipts: RPGReceipt[]
  owned: string[]
  equipped: Partial<Record<RPGSlot, string>>
  boosters: string[]
  openings: Record<string, { item: string; duplicateSparks: number }>
  upgrades: Record<string, number>
}
export interface RPGDocument {
  rev: number
  blob: string | null
}
export interface RPGItem {
  id: string
  slot: RPGSlot
  rarity: RPGRarity
  color: number
}
const COLORS = [0x71c7a5, 0x66b9ee, 0xb492ff, 0xf38ac8, 0xffcf66]
export const RPG_CATALOG: RPGItem[] = RPG_SLOTS.flatMap(slot =>
  RPG_RARITIES.map((rarity, index) => ({ id: `${slot}-${rarity}`, slot, rarity, color: COLORS[index] })),
)
export const RPG_REWARDS: Record<RPGRewardKind, { xp: number; sparks: number }> = {
  task: { xp: 10, sparks: 1 },
  poolTask: { xp: 50, sparks: 5 },
  review: { xp: 20, sparks: 2 },
  encounter: { xp: 15, sparks: 2 },
  boss: { xp: 75, sparks: 10 },
}
export const RPG_ODDS = [60, 25, 10, 4, 1] as const
export const RPG_DUPLICATES = [1, 3, 8, 20, 50] as const
export function newRPGState(): RPGState {
  return { version: RPG_VERSION, xp: 0, sparks: 0, receipts: [], owned: [], equipped: {}, boosters: [], openings: {}, upgrades: {} }
}
export function rpgLevel(xp: number): number {
  return Math.min(100, Math.floor((1 + Math.sqrt(1 + (4 * Math.max(0, xp)) / 50)) / 2))
}
export const rpgThreshold = (level: number): number => 50 * level * (level - 1)
const combat = (kind: RPGRewardKind) => kind === 'encounter' || kind === 'boss'
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= RPG_RECEIPT_LIMIT && v.every(s => typeof s === 'string' && s.length <= 200)

export function isRPGReward(v: unknown): v is RPGReward {
  if (!object(v)) return false
  return (
    typeof v.id === 'string' &&
    /^[a-f0-9]{64}$/.test(v.id) &&
    typeof v.kind === 'string' &&
    Object.hasOwn(RPG_REWARDS, v.kind) &&
    typeof v.day === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(v.day) &&
    Number.isFinite(Date.parse(`${v.day}T00:00:00Z`))
  )
}
export function parseRPGState(v: unknown): RPGState {
  if (
    !object(v) ||
    v.version !== RPG_VERSION ||
    !integer(v.xp) ||
    !integer(v.sparks) ||
    !strings(v.owned) ||
    !strings(v.boosters) ||
    !object(v.equipped) ||
    !object(v.upgrades) ||
    !object(v.openings) ||
    Object.keys(v.openings).length > RPG_RECEIPT_LIMIT ||
    !Object.entries(v.openings).every(
      ([id, opening]) =>
        id.length <= 200 &&
        object(opening) &&
        typeof opening.item === 'string' &&
        opening.item.length <= 200 &&
        integer(opening.duplicateSparks) &&
        opening.duplicateSparks <= 50,
    ) ||
    !Array.isArray(v.receipts) ||
    v.receipts.length > RPG_RECEIPT_LIMIT ||
    !v.receipts.every(
      r =>
        object(r) &&
        integer(r.xp) &&
        integer(r.sparks) &&
        isRPGReward(r) &&
        r.xp <= RPG_REWARDS[r.kind].xp &&
        r.sparks <= RPG_REWARDS[r.kind].sparks,
    ) ||
    !Object.entries(v.equipped).every(([slot, id]) => RPG_SLOTS.includes(slot as RPGSlot) && typeof id === 'string' && id.length <= 200) ||
    !Object.values(v.upgrades).every(n => integer(n) && n <= 10)
  )
    throw new Error('Unsupported or invalid hero data')
  return v as unknown as RPGState
}

/** Repeated claims are no-ops, including claims that hit a daily cap. Never prune their receipts. */
export function awardRPG(state: RPGState, reward: RPGReward): RPGState {
  if (!isRPGReward(reward)) throw new Error('Invalid reward')
  if (state.receipts.some(r => r.id === reward.id)) return state
  if (state.receipts.length >= RPG_RECEIPT_LIMIT) throw new Error('Hero receipt limit reached')
  const base = RPG_REWARDS[reward.kind]
  const spent = state.receipts.filter(r => r.day === reward.day && combat(r.kind) === combat(reward.kind)).reduce((n, r) => n + r.xp, 0)
  const xp = Math.min(base.xp, Math.max(0, (combat(reward.kind) ? 300 : 1000) - spent))
  const sparks = Math.floor((base.sparks * xp) / base.xp)
  const next = {
    ...state,
    xp: state.xp + xp,
    sparks: state.sparks + sparks,
    receipts: [...state.receipts, { ...reward, xp, sparks }],
    owned: [...state.owned],
    boosters: [...state.boosters],
  }
  for (let level = rpgLevel(state.xp) + 1; level <= rpgLevel(next.xp); level++) {
    next.boosters.push(`level-${level}`)
    const slot = RPG_SLOTS[level - 2]
    if (slot && !next.owned.includes(`${slot}-common`)) next.owned.push(`${slot}-common`)
  }
  return next
}

export function equipRPG(state: RPGState, slot: RPGSlot, id: string | null): RPGState {
  if (!RPG_SLOTS.includes(slot)) throw new Error('Unknown slot')
  if (id && (!state.owned.includes(id) || !RPG_CATALOG.some(item => item.id === id && item.slot === slot)))
    throw new Error('Item is locked or incompatible')
  const equipped = { ...state.equipped }
  if (id) equipped[slot] = id
  else delete equipped[slot]
  return { ...state, equipped }
}

/** A target rank makes a retried purchase idempotent, even after a lost response. */
export function upgradeRPG(state: RPGState, stat: 'health' | 'attack' | 'movement', rank: number): RPGState {
  if (!['health', 'attack', 'movement'].includes(stat) || !Number.isInteger(rank) || rank < 1 || rank > 10)
    throw new Error('Invalid upgrade')
  const current = state.upgrades[stat] ?? 0
  if (rank <= current) return state
  if (rank !== current + 1 || state.sparks < rank * 10) throw new Error('Upgrade unavailable')
  return { ...state, sparks: state.sparks - rank * 10, upgrades: { ...state.upgrades, [stat]: rank } }
}

/** Commit a selected item before revealing it. Loot-table selection and animations live in #274 and #275. */
export function openRPGBooster(state: RPGState, booster: string, itemId: string): RPGState {
  if (Object.hasOwn(state.openings, booster)) return state
  const item = RPG_CATALOG.find(item => item.id === itemId)
  if (!state.boosters.includes(booster) || !item) throw new Error('Booster or item unavailable')
  if (Object.keys(state.openings).length >= RPG_RECEIPT_LIMIT) throw new Error('Opening receipt limit reached')
  const duplicateSparks = state.owned.includes(itemId) ? RPG_DUPLICATES[RPG_RARITIES.indexOf(item.rarity)] : 0
  return {
    ...state,
    sparks: state.sparks + duplicateSparks,
    owned: state.owned.includes(itemId) ? state.owned : [...state.owned, itemId],
    boosters: state.boosters.filter(id => id !== booster),
    openings: { ...state.openings, [booster]: { item: itemId, duplicateSparks } },
  }
}

/** Account-private stable identities shared by the agent and local clients. No plaintext task leaves the device. */
export async function rpgReward(kind: RPGRewardKind, source: string, at: string): Promise<RPGReward> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${kind}\n${source}`))
  const id = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
  return { id, kind, day: at.slice(0, 10) }
}
