// The cluster's XP leaderboard (docs/cluster.md, The leaderboard): one sealed document, `leaderboard`, where each member
// who chose to share its Tonton keeps one entry: its level, what it wears, its XP today and since the cluster's clock
// started (or since it joined), and its last level-ups, which the feed shows. Never the inventory, the receipts or what
// the work was. Each member's own clients write its entry and leave the others as they found them. Mirrors
// app/Sources/TontonCore/ClusterHeroes.swift; shared/test/cluster-heroes-vectors.json holds what both must agree on.

import { RPG_SLOTS, type RPGReceipt, type RPGSlot, type RPGState, rpgLevel } from './rpg'
import { rpgToday } from './rpg-journal'

export const CLUSTER_LEADERBOARD = 'leaderboard'
/** Level-ups kept per member, newest last: enough for the feed between two visits. */
export const CLUSTER_LEVEL_UPS = 10
/** More entries than a cluster can have members, so an older relay's larger cap never hides one. */
const MAX_HEROES = 100

export interface ClusterLevelUp {
  level: number
  /** ISO, when the member's client saw it. */
  at: string
}

export interface ClusterHero {
  account: string
  level: number
  /** XP of `day`, the UTC day it was counted on: another day reads as none. */
  today: number
  day: string
  /** XP since `from`, the clock's start or when the member joined. */
  since: number
  from: string
  /** The member's XP when `from` came: `since` stays right once old receipts are pruned. */
  base: number
  equipped: Partial<Record<RPGSlot, string>>
  levelUps: ClusterLevelUp[]
  updatedAt: string
}

export interface ClusterLeaderboard {
  heroes: ClusterHero[]
  /**
   * Every entry as it was sealed, those this client cannot read and fields it does not know included: a write puts them
   * back as they were, so an older client never strips what a newer one wrote.
   */
  entries: unknown[]
}

/** One line of the board: a member, with its numbers if it shares them. */
export interface ClusterRank {
  account: string
  /** 1 for the first; null for a member who does not share. */
  rank: number | null
  hero: ClusterHero | null
  /** Its XP since the current start: 0 while its entry still counts from an earlier clock. */
  since: number
  /** Its XP of the current UTC day, 0 when its entry is from an earlier one. */
  today: number
}

type Fields = Record<string, unknown>
const fields = (value: unknown): Fields | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null)
const date = (value: unknown): string | null => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null)
const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)

function levelUp(value: unknown): ClusterLevelUp | null {
  const f = fields(value)
  const level = count(f?.level)
  const at = date(f?.at)
  return level !== null && level >= 1 && level <= 100 && at ? { level, at } : null
}

function hero(value: unknown): ClusterHero | null {
  const f = fields(value)
  if (!f || typeof f.account !== 'string' || !f.account || f.account.length > 200) return null
  const level = count(f.level)
  const today = count(f.today)
  const since = count(f.since)
  const base = count(f.base)
  const from = date(f.from)
  const updatedAt = date(f.updatedAt)
  if (level === null || level < 1 || level > 100 || today === null || since === null || base === null) return null
  if (!isDay(f.day) || !from || !updatedAt) return null
  const worn = fields(f.equipped) ?? {}
  const equipped: Partial<Record<RPGSlot, string>> = {}
  for (const slot of RPG_SLOTS) {
    const id = worn[slot]
    if (typeof id === 'string' && id.length <= 200) equipped[slot] = id
  }
  const levelUps = Array.isArray(f.levelUps) ? f.levelUps.flatMap(item => levelUp(item) ?? []).slice(-CLUSTER_LEVEL_UPS) : []
  return { account: f.account, level, today, day: f.day, since, from, base, equipped, levelUps, updatedAt }
}

/** The document as another member sealed it: entries that don't read are left out, and one per member. */
export function decodeClusterLeaderboard(value: unknown): ClusterLeaderboard | null {
  const f = fields(value)
  if (!f || !Array.isArray(f.heroes)) return null
  const entries = f.heroes.slice(0, MAX_HEROES)
  const seen = new Set<string>()
  const heroes = entries.flatMap(item => {
    const read = hero(item)
    if (!read || seen.has(read.account)) return []
    seen.add(read.account)
    return [read]
  })
  return { heroes, entries }
}

/** What is sealed: every entry as it was found, and this member's own as it now is. */
export const sealedClusterLeaderboard = (board: ClusterLeaderboard): { heroes: unknown[] } => ({ heroes: board.entries })

/** Where a member's count starts: the clock's start when the cluster has one, else when the member joined. */
export function clusterHeroFrom(clockStartedAt: string | undefined, joinedAt: string): string {
  return clockStartedAt && !Number.isNaN(Date.parse(clockStartedAt)) ? clockStartedAt : joinedAt
}

/** When a receipt was earned. Older ones only know their day: they count from the day after `from`'s. */
function earnedSince(receipt: RPGReceipt, from: number): boolean {
  if (receipt.at) return Date.parse(receipt.at) >= from
  return Date.parse(`${receipt.day}T00:00:00Z`) >= Date.parse(`${new Date(from).toISOString().slice(0, 10)}T00:00:00Z`) + 86_400_000
}

/**
 * This member's entry, from its hero. `previous` is its entry as the document has it: the base carries over while
 * `from` stays, and a level above the previous one is a level-up. Another of the member's clients may read an older hero:
 * for the same start, the level, the XP since and of the day never go down, and a level is a level-up once.
 */
export function clusterHeroEntry(
  state: RPGState,
  account: string,
  from: string,
  previous: ClusterHero | null,
  now: number = Date.now(),
): ClusterHero {
  const start = Date.parse(from)
  const earned = [...state.receipts, ...(state.gains ?? [])]
    .filter(receipt => earnedSince(receipt, start))
    .reduce((sum, r) => sum + r.xp, 0)
  const same = previous !== null && previous.from === from
  const base = same ? previous.base : Math.max(0, state.xp - earned)
  const level = Math.max(previous?.level ?? 1, rpgLevel(state.xp))
  const at = new Date(now).toISOString()
  const levelUps = [...(previous?.levelUps ?? [])]
  if (previous && level > previous.level && !levelUps.some(up => up.level === level)) levelUps.push({ level, at })
  const today = rpgToday(state, now)
  const todayXP = previous?.day === today.day ? Math.max(previous.today, today.xp) : today.xp
  const equipped: Partial<Record<RPGSlot, string>> = {}
  for (const slot of RPG_SLOTS) {
    const id = state.equipped[slot]
    if (id && state.owned.includes(id)) equipped[slot] = id
  }
  return {
    account,
    level,
    today: todayXP,
    day: today.day,
    since: Math.max(same ? previous.since : 0, state.xp - base, 0),
    from,
    base,
    equipped,
    levelUps: levelUps.slice(-CLUSTER_LEVEL_UPS),
    updatedAt: at,
  }
}

/** The document with this member's entry put in, replaced, or taken out (null). Every other entry stays as it was. */
export function withClusterHero(board: ClusterLeaderboard | null, account: string, entry: ClusterHero | null): ClusterLeaderboard {
  const heroes = (board?.heroes ?? []).filter(hero => hero.account !== account)
  const entries = (board?.entries ?? []).filter(item => fields(item)?.account !== account)
  return entry ? { heroes: [...heroes, entry], entries: [...entries, entry] } : { heroes, entries }
}

/** Whether two entries say the same, the time they were written aside: an unchanged entry is not written again. */
export function sameClusterHero(a: ClusterHero | null, b: ClusterHero | null): boolean {
  if (!a || !b) return a === b
  const key = (hero: ClusterHero) =>
    JSON.stringify([
      hero.account,
      hero.level,
      hero.today,
      hero.day,
      hero.since,
      hero.from,
      hero.base,
      RPG_SLOTS.map(slot => hero.equipped[slot] ?? null),
      hero.levelUps.map(up => [up.level, up.at]),
    ])
  return key(a) === key(b)
}

/**
 * Every member, ranked: those who share by XP since the start, then level, then account id in code-unit order, as
 * the pools' boards; then those who don't, without numbers, in the order given. An entry that still counts from an
 * earlier clock, whose member's clients were closed since, counts as no XP since this one started.
 */
export function rankClusterHeroes(
  board: ClusterLeaderboard | null,
  members: readonly { account: string; joinedAt: string }[],
  clockStartedAt: string | undefined,
  now: number = Date.now(),
): ClusterRank[] {
  const day = new Date(now).toISOString().slice(0, 10)
  const heroes = new Map((board?.heroes ?? []).map(hero => [hero.account, hero]))
  const sharing = members
    .flatMap(member => {
      const hero = heroes.get(member.account)
      if (!hero) return []
      const since = hero.from === clusterHeroFrom(clockStartedAt, member.joinedAt) ? hero.since : 0
      return [{ hero, since }]
    })
    .sort(
      (a, b) =>
        b.since - a.since ||
        b.hero.level - a.hero.level ||
        (a.hero.account < b.hero.account ? -1 : a.hero.account > b.hero.account ? 1 : 0),
    )
  const ranked = sharing.map(({ hero, since }, index) => ({
    account: hero.account,
    rank: index + 1,
    hero,
    since,
    today: hero.day === day ? hero.today : 0,
  }))
  const quiet = members.filter(member => !heroes.has(member.account))
  return [...ranked, ...quiet.map(member => ({ account: member.account, rank: null, hero: null, since: 0, today: 0 }))]
}

/** The members' level-ups for the feed, newest first: "Alice's Tonton reached level 12". Members only. */
export function clusterLevelUps(
  board: ClusterLeaderboard | null,
  members: readonly { account: string }[],
): { account: string; level: number; at: string }[] {
  const current = new Set(members.map(member => member.account))
  return (board?.heroes ?? [])
    .filter(hero => current.has(hero.account))
    .flatMap(hero => hero.levelUps.map(up => ({ account: hero.account, level: up.level, at: up.at })))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.level - a.level)
}
