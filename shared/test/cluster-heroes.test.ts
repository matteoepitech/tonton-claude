import { expect, test } from 'bun:test'
import {
  CLUSTER_LEVEL_UPS,
  type ClusterHero,
  clusterHeroEntry,
  clusterHeroFrom,
  clusterLevelUps,
  decodeClusterLeaderboard,
  rankClusterHeroes,
  sameClusterHero,
  sealedClusterLeaderboard,
  withClusterHero,
} from '../cluster-heroes'
import type { RPGState } from '../rpg'
import vectors from './cluster-heroes-vectors.json'

test('each entry as the Swift side works it out: XP since the start, the base, today and the level-ups', () => {
  for (const item of vectors.entries) {
    const entry = clusterHeroEntry(
      item.hero as RPGState,
      item.account,
      item.from,
      item.previous as ClusterHero | null,
      Date.parse(item.now),
    )
    expect([item.name, entry]).toEqual([item.name, item.expected as ClusterHero])
  }
})

test('the ranking and the feed’s level-ups, from a board with a duplicate, a broken entry and a former member', () => {
  const { ranking } = vectors
  const board = decodeClusterLeaderboard(ranking.board)
  expect(board?.heroes.map(hero => hero.account)).toEqual(ranking.decodedAccounts)
  const ranks = rankClusterHeroes(board, ranking.members, ranking.clockStartedAt, Date.parse(ranking.now))
  expect(ranks.map(({ account, rank, since, today }) => ({ account, rank, since, today }))).toEqual(ranking.expected)
  // A member who does not share has no numbers.
  expect(ranks.find(rank => rank.account === 'acc-carol')?.hero).toBeNull()
  expect(clusterLevelUps(board, ranking.members)).toEqual(ranking.levelUps)
})

const entry = (account: string, since: number): ClusterHero => ({
  account,
  level: 3,
  today: 0,
  day: '2026-11-04',
  since,
  from: '2026-11-04T00:00:00Z',
  base: 0,
  equipped: {},
  levelUps: [],
  updatedAt: '2026-11-04T10:00:00Z',
})

test('a member changes only its own entry', () => {
  // A newer client's field and an entry this client cannot read are written back as they were.
  const newer = { ...entry('a', 1), mood: 'happy' }
  const board = decodeClusterLeaderboard({ heroes: [newer, entry('b', 2), { account: 'z', level: 'unknown' }] })
  const changed = withClusterHero(board, 'b', entry('b', 5))
  expect(changed.heroes).toEqual([entry('a', 1), entry('b', 5)])
  expect(sealedClusterLeaderboard(changed).heroes).toEqual([newer, { account: 'z', level: 'unknown' }, entry('b', 5)])
  expect(withClusterHero(board, 'a', null).entries).toEqual([entry('b', 2), { account: 'z', level: 'unknown' }])
  expect(withClusterHero(null, 'c', entry('c', 1)).entries).toEqual([entry('c', 1)])
})

test('an entry that says the same is not written again, whenever it was written', () => {
  expect(sameClusterHero(entry('a', 1), { ...entry('a', 1), updatedAt: '2026-11-05T00:00:00Z' })).toBe(true)
  expect(sameClusterHero(entry('a', 1), entry('a', 2))).toBe(false)
  expect(sameClusterHero(entry('a', 1), { ...entry('a', 1), equipped: { hat: 'hat-rare' } })).toBe(false)
  expect(sameClusterHero(null, null)).toBe(true)
  expect(sameClusterHero(entry('a', 1), null)).toBe(false)
})

test('the count starts at the clock, else when the member joined', () => {
  expect(clusterHeroFrom('2026-11-04T09:00:00Z', '2026-10-01T00:00:00Z')).toBe('2026-11-04T09:00:00Z')
  expect(clusterHeroFrom(undefined, '2026-10-01T00:00:00Z')).toBe('2026-10-01T00:00:00Z')
  expect(clusterHeroFrom('soon', '2026-10-01T00:00:00Z')).toBe('2026-10-01T00:00:00Z')
})

test('a board keeps the last level-ups only, and skips what does not read', () => {
  const ups = Array.from({ length: 15 }, (_, index) => ({ level: index + 2, at: `2026-11-04T10:${String(index).padStart(2, '0')}:00Z` }))
  const board = decodeClusterLeaderboard({ heroes: [{ ...entry('a', 1), levelUps: [...ups, { level: 'x' }] }, 'nope'], extra: true })
  expect(board?.heroes).toHaveLength(1)
  expect(board?.heroes[0].levelUps).toEqual(ups.slice(-CLUSTER_LEVEL_UPS))
  expect(decodeClusterLeaderboard({ heroes: 'x' })).toBeNull()
  expect(decodeClusterLeaderboard(null)).toBeNull()
})
