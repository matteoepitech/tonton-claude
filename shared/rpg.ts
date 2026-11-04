// Tonton's versioned economy and inventory. Pure, browser-safe rules mirrored by TontonCore/RPG.swift.

/** The hero document's schema. Rules version 2 kept it at 1, so apps that know only version 1 still open the hero. */
export const RPG_VERSION = 1
/** The economy: what earns XP and how much. Version 2 added turns, the daily streak and pushes, kept in `gains`. */
export const RPG_RULES_VERSION = 2
export const RPG_RECEIPT_LIMIT = 10_000
export const RPG_SLOTS = ['skin', 'hat', 'accessory', 'aura', 'trail'] as const
export const RPG_RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const
export type RPGSlot = (typeof RPG_SLOTS)[number]
export type RPGRarity = (typeof RPG_RARITIES)[number]
/** Version 1 kinds, kept in `receipts`. Apps that know only version 1 reject any other kind there. */
export const RPG_RECEIPT_KINDS = ['task', 'poolTask', 'review', 'encounter', 'boss'] as const
/** Version 2 kinds, kept in `gains`, which apps that know only version 1 ignore. */
export const RPG_GAIN_KINDS = ['turn', 'day', 'push'] as const
export type RPGReceiptKind = (typeof RPG_RECEIPT_KINDS)[number]
export type RPGGainKind = (typeof RPG_GAIN_KINDS)[number]
export type RPGRewardKind = RPGReceiptKind | RPGGainKind
/** Facts about the work, never an amount of XP: the rules below turn them into XP and sparks. */
export interface RPGReward {
  id: string
  kind: RPGRewardKind
  day: string
  /** When it happened, an ISO time on `day`. Orders the journal and fills today's hours. */
  at?: string
  /** A turn: how long it worked, in seconds, without the time spent waiting on a permission prompt. */
  seconds?: number
  /** A turn: typed by its user (in the terminal, the notch or the website). False for a turn a pool or cluster post started. */
  prompted?: boolean
  /** What the journal says it was about: a project folder for a turn, a branch or a changelist for a push. Sealed. */
  note?: string
}
export interface RPGReceipt {
  id: string
  kind: RPGRewardKind
  day: string
  xp: number
  sparks: number
  at?: string
  seconds?: number
  note?: string
}
export interface RPGState {
  version: number
  xp: number
  sparks: number
  /** Version 1 kinds. Never pruned. */
  receipts: RPGReceipt[]
  /** Version 2 kinds, absent from older documents. Pruned after RPG_GAIN_DAYS. */
  gains?: RPGReceipt[]
  owned: string[]
  equipped: Partial<Record<RPGSlot, string>>
  boosters: string[]
  openings: Record<string, { item: string; duplicateSparks: number; tableVersion?: 1 }>
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
/** The most one reward of each kind can earn. A turn's XP depends on its length, the day's on the streak. */
export const RPG_REWARDS: Record<RPGRewardKind, { xp: number; sparks: number }> = {
  task: { xp: 10, sparks: 1 },
  poolTask: { xp: 50, sparks: 5 },
  review: { xp: 20, sparks: 2 },
  encounter: { xp: 15, sparks: 2 },
  boss: { xp: 75, sparks: 10 },
  turn: { xp: 65, sparks: 6 },
  day: { xp: 50, sparks: 5 },
  push: { xp: 15, sparks: 1 },
}
/** Rules version 2. One set of numbers, mirrored in RPG.swift and checked by shared/test/rpg-v2-vectors.json. */
export const RPG_RULES = {
  prompt: 5,
  shortPrompt: 1,
  shortSeconds: 5,
  minuteXP: 1,
  turnMinutes: 60,
  day: 20,
  streakDay: 10,
  dayMax: 50,
  push: 15,
  workCap: 1500,
  combatCap: 300,
  xpPerSpark: 10,
} as const
/** Gains older than this many days before the award are refused, so pruned receipts can never be earned again. */
export const RPG_GAIN_HORIZON = 21
/** Gains are kept this many days, then pruned. Longer than the horizon, so a slow clock cannot reopen a pruned day. */
export const RPG_GAIN_DAYS = 30
/** At most this many gains a UTC day, which bounds the document: 30 days × 200 stays far under the relay's 4 MiB. */
export const RPG_GAINS_PER_DAY = 200
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
export const isRPGGainKind = (kind: string): kind is RPGGainKind => (RPG_GAIN_KINDS as readonly string[]).includes(kind)
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= RPG_RECEIPT_LIMIT && v.every(s => typeof s === 'string' && s.length <= 200)
/** A UTC time with minutes, as transcripts and the agent write them. Anything else keeps only its day. */
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?Z$/
const isDay = (day: unknown): day is string =>
  typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`))
/** The optional details a reward and its receipt may carry, whatever their kind. */
const details = (v: Record<string, unknown>) =>
  (v.at === undefined ||
    (typeof v.at === 'string' && UTC.test(v.at) && v.at.slice(0, 10) === v.day && Number.isFinite(Date.parse(v.at)))) &&
  (v.seconds === undefined || (integer(v.seconds) && v.seconds <= 86_400)) &&
  (v.note === undefined || (typeof v.note === 'string' && v.note.length <= 80))

export function isRPGReward(v: unknown): v is RPGReward {
  if (!object(v)) return false
  return (
    typeof v.id === 'string' &&
    /^[a-f0-9]{64}$/.test(v.id) &&
    typeof v.kind === 'string' &&
    Object.hasOwn(RPG_REWARDS, v.kind) &&
    isDay(v.day) &&
    details(v) &&
    (v.prompted === undefined || typeof v.prompted === 'boolean')
  )
}
const receipt = (r: unknown, kinds: readonly string[]) =>
  object(r) &&
  integer(r.xp) &&
  integer(r.sparks) &&
  isRPGReward(r) &&
  kinds.includes(r.kind) &&
  r.xp <= RPG_REWARDS[r.kind].xp &&
  r.sparks <= RPG_REWARDS[r.kind].sparks

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
        opening.duplicateSparks <= 50 &&
        (opening.tableVersion === undefined || opening.tableVersion === 1),
    ) ||
    !Array.isArray(v.receipts) ||
    v.receipts.length > RPG_RECEIPT_LIMIT ||
    !v.receipts.every(r => receipt(r, RPG_RECEIPT_KINDS)) ||
    (v.gains !== undefined &&
      (!Array.isArray(v.gains) || v.gains.length > RPG_RECEIPT_LIMIT || !v.gains.every(r => receipt(r, RPG_GAIN_KINDS)))) ||
    !Object.entries(v.equipped).every(([slot, id]) => RPG_SLOTS.includes(slot as RPGSlot) && typeof id === 'string' && id.length <= 200) ||
    !Object.values(v.upgrades).every(n => integer(n) && n <= 10)
  )
    throw new Error('Unsupported or invalid hero data')
  return v as unknown as RPGState
}

const DAY = 86_400_000
const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10)
/** The UTC day `days` after `day` (before it when negative). */
export const rpgShiftDay = (day: string, days: number) => dayOf(Date.parse(`${day}T00:00:00Z`) + days * DAY)

/** What a reward earns before the daily cap. Only facts come from the agent; the amounts are here. */
function earned(gains: readonly RPGReceipt[], reward: RPGReward): number {
  switch (reward.kind) {
    case 'turn': {
      const seconds = reward.seconds ?? 0
      const prompt = reward.prompted !== true ? 0 : seconds < RPG_RULES.shortSeconds ? RPG_RULES.shortPrompt : RPG_RULES.prompt
      return prompt + Math.min(RPG_RULES.turnMinutes, Math.floor(seconds / 60)) * RPG_RULES.minuteXP
    }
    case 'day': {
      // Only the three days before matter: a fourth day of streak is already at the maximum.
      let streak = 0
      while (streak < 3 && gains.some(r => r.kind === 'day' && r.day === rpgShiftDay(reward.day, -(streak + 1)))) streak++
      return Math.min(RPG_RULES.dayMax, RPG_RULES.day + RPG_RULES.streakDay * streak)
    }
    case 'push':
      return RPG_RULES.push
    default:
      return RPG_REWARDS[reward.kind].xp
  }
}

/** Repeated claims are no-ops, including claims that hit a daily cap. Never prune version 1 receipts. */
export function awardRPG(state: RPGState, reward: RPGReward): RPGState {
  return awardRPGAt(state, reward, Date.now())
}

/**
 * `now` (milliseconds) decides which gains are too old to earn and which are pruned. A gain that earns nothing leaves
 * no receipt: its day's total can only grow, so a replay earns nothing either, and its day is pruned after the horizon.
 */
export function awardRPGAt(state: RPGState, reward: RPGReward, now: number): RPGState {
  if (!isRPGReward(reward)) throw new Error('Invalid reward')
  const gains = state.gains ?? []
  if (state.receipts.some(r => r.id === reward.id) || gains.some(r => r.id === reward.id)) return state
  const gain = isRPGGainKind(reward.kind)
  let kept = gains
  if (gain) {
    const today = dayOf(now)
    if (reward.day < rpgShiftDay(today, -RPG_GAIN_HORIZON) || reward.day > rpgShiftDay(today, 1)) return state
    if (gains.filter(r => r.day === reward.day).length >= RPG_GAINS_PER_DAY) return state
    kept = gains.filter(r => r.day >= rpgShiftDay(today, -RPG_GAIN_DAYS))
    if (kept.length >= RPG_RECEIPT_LIMIT) throw new Error('Hero receipt limit reached')
  } else if (state.receipts.length >= RPG_RECEIPT_LIMIT) throw new Error('Hero receipt limit reached')
  const fight = combat(reward.kind)
  const spent = [...state.receipts, ...gains].filter(r => r.day === reward.day && combat(r.kind) === fight).reduce((n, r) => n + r.xp, 0)
  const xp = Math.min(earned(gains, reward), Math.max(0, (fight ? RPG_RULES.combatCap : RPG_RULES.workCap) - spent))
  if (gain && xp === 0) return state
  const base = RPG_REWARDS[reward.kind]
  const sparks = gain ? Math.floor(xp / RPG_RULES.xpPerSpark) : Math.floor((base.sparks * xp) / base.xp)
  const entry: RPGReceipt = { id: reward.id, kind: reward.kind, day: reward.day, xp, sparks }
  if (reward.at !== undefined) entry.at = reward.at
  if (reward.seconds !== undefined && reward.kind === 'turn') entry.seconds = reward.seconds
  if (reward.note !== undefined) entry.note = reward.note
  const next: RPGState = {
    ...state,
    xp: state.xp + xp,
    sparks: state.sparks + sparks,
    receipts: gain ? state.receipts : [...state.receipts, entry],
    owned: [...state.owned],
    boosters: [...state.boosters],
  }
  if (gain) next.gains = [...kept, entry]
  for (let level = rpgLevel(state.xp) + 1; level <= rpgLevel(next.xp); level++) {
    next.boosters.push(`level-${level}`)
    const slot = RPG_SLOTS[level - 2]
    if (slot && !next.owned.includes(`${slot}-common`)) next.owned.push(`${slot}-common`)
  }
  // At most four rewarded bosses per UTC day; capped fights never mint extra boosters.
  if (reward.kind === 'boss' && xp > 0) next.boosters.push(`boss-v1-${reward.id}`)
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

/** Commit a selected item before revealing it. A competing or retried opening keeps the original result. */
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
    openings: { ...state.openings, [booster]: { item: itemId, duplicateSparks, tableVersion: 1 } },
  }
}

/**
 * Account-private stable identities shared by the agent and local clients. No plaintext task leaves the device.
 * The id depends only on the kind and the source, so a replay, a restart or a backfill finds the same receipt.
 */
export async function rpgReward(
  kind: RPGRewardKind,
  source: string,
  at: string,
  extra: { seconds?: number; prompted?: boolean; note?: string } = {},
): Promise<RPGReward> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${kind}\n${source}`))
  const id = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
  const reward: RPGReward = { id, kind, day: at.slice(0, 10) }
  if (UTC.test(at)) reward.at = at
  if (extra.seconds !== undefined) reward.seconds = Math.min(86_400, Math.max(0, Math.floor(extra.seconds)))
  if (extra.prompted !== undefined) reward.prompted = extra.prompted
  // Cut on a character, never inside one: the limit counts UTF-16 units, as Swift's `utf16.count` does.
  let note = ''
  for (const c of (extra.note ?? '').trim()) {
    if (note.length + c.length > 80) break
    note += c
  }
  if (note) reward.note = note
  return reward
}
