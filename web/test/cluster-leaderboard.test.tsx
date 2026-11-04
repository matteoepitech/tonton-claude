// The website's leaderboard: ranked members with their Tonton, level, title and XP, and a member who does not share
// listed without numbers.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { type ClusterHero, type ClusterState, rankClusterHeroes } from '../../shared'
import { heroTitle, LeaderboardList } from '../site/clusters/leaderboard'

const member = (account: string, name: string) =>
  ({ account, role: 'member', joinedAt: '2026-11-01T00:00:00Z', profile: { name }, publicKeys: [] }) as ClusterState['members'][number]
const state = { members: [member('a', 'Alice'), member('b', 'Bob'), member('c', 'Carol')] } as ClusterState
const hero = (account: string, level: number, since: number, today: number): ClusterHero => ({
  account,
  level,
  today,
  day: '2026-11-04',
  since,
  from: '2026-11-01T00:00:00Z',
  base: 0,
  equipped: { hat: 'hat-rare' },
  levelUps: [],
  updatedAt: '2026-11-04T10:00:00Z',
})

test('the members by XP since the start, with their level and title; one who does not share has no numbers', () => {
  const heroes = [hero('a', 12, 340, 40), hero('b', 7, 1200, 0)]
  const ranks = rankClusterHeroes({ heroes, entries: heroes }, state.members, undefined, Date.parse('2026-11-04T12:00:00Z'))
  const html = renderToStaticMarkup(<LeaderboardList ranks={ranks} state={state} account="a" />)
  const rows = html.split('<li').slice(1)
  expect(rows).toHaveLength(3)
  expect(rows[0]).toContain('Bob')
  expect(rows[0]).toContain('Level 7 · Apprentice')
  expect(rows[0]).toContain('1,200 XP')
  expect(rows[1]).toContain('Alice')
  expect(rows[1]).toContain('You')
  expect(rows[1]).toContain('Level 12 · Builder')
  expect(rows[1]).toContain('+40 today')
  expect(rows[2]).toContain('Carol')
  expect(rows[2]).toContain('Doesn&#x27;t share its Tonton')
  expect(rows[2]).not.toContain('XP')
})

test('one title per ten levels, as in the notch', () => {
  expect([1, 10, 11, 21, 99, 100].map(heroTitle)).toEqual(['Apprentice', 'Apprentice', 'Builder', 'Architect', 'Legend', 'Legend'])
})
