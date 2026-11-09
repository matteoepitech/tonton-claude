// The cluster pages' model (web/site/clusters/model.ts): the roster, who wrote a post, events, claims and the clock.
import { describe, expect, test } from 'bun:test'
import type { ClusterSession, ClusterState } from '../../shared'
import { authorLabel, choiceOf, clockView, eventLine, heldClaims, recipients, roster, timeLeft, turnsDigest } from '../site/clusters/model'

const session = (account: string, id: string, extra: Partial<ClusterSession> = {}): ClusterSession => ({
  account,
  session: id,
  joinedAt: '2026-11-04T10:00:00Z',
  online: true,
  ready: true,
  status: 'idle',
  profile: { name: id, machine: 'mac', tool: 'claude' },
  ...extra,
})

function state(): ClusterState {
  return {
    id: 'cluster00001',
    createdAt: '2026-11-04T10:00:00Z',
    keyVersion: 1,
    info: { name: 'Jam' },
    members: [
      { account: 'bob', role: 'member', joinedAt: '', profile: { name: 'Bob' }, publicKeys: [] },
      { account: 'alice', role: 'owner', joinedAt: '', profile: { name: 'Alice' }, publicKeys: [] },
      { account: 'carol', role: 'member', joinedAt: '', profile: null, publicKeys: [] },
    ],
    sessions: [
      session('bob', 'rig', { machine: 'm1', profile: { name: 'rig', machine: 'Bob PC', tool: 'opencode' } }),
      session('bob', 'build', { machine: 'm1', status: 'working', profile: { name: 'build', machine: 'Bob PC', tool: 'claude' } }),
      session('bob', 'lights', { machine: 'm2', profile: { name: 'lights', machine: 'Bob Mac' } }),
      session('alice', 'hero', { profile: { project: 'HeroGame' } }),
    ],
    posts: [],
    docs: [],
    own: { secret: null, wraps: [] },
  }
}

describe('the cluster pages', () => {
  test('Live anyway orders live for a session that skips permission prompts, and live that turned into digests says so', () => {
    expect(choiceOf('anyway')).toEqual({ delivery: 'live', liveWithoutPrompts: true })
    expect(choiceOf('digest')).toEqual({ delivery: 'digest' })
    const turned = session('alice', 'hero', { profile: { name: 'hero', delivery: 'digest', skipsPrompts: true } })
    expect(turnsDigest('live', turned)).toBe(true)
    expect(turnsDigest('anyway', turned)).toBe(false)
    expect(turnsDigest('digest', turned)).toBe(false)
    // An older agent says neither.
    expect(turnsDigest('live', session('alice', 'hero'))).toBe(false)
  })

  test('the roster puts this account first, then the owner, with busy sessions first on each machine', () => {
    const members = roster(state(), 'bob')
    expect(members.map(m => [m.name, m.mine, m.sessions])).toEqual([
      ['Bob', true, 3],
      ['Alice', false, 1],
      ['A member', false, 0],
    ])
    expect(members[0].machines.map(m => [m.name, m.sessions.map(s => s.session)])).toEqual([
      ['Bob Mac', ['lights']],
      ['Bob PC', ['build', 'rig']],
    ])
    expect(members[1].machines[0]).toMatchObject({ name: 'A machine', key: 'A machine' })
    expect(roster(state(), null)[0].name).toBe('Alice')
  })

  test('a post says who wrote it as sessions see it, and who it is for', () => {
    const s = state()
    expect(authorLabel(s, { account: 'bob', session: 'rig' })).toBe('Bob · Bob PC · OpenCode')
    expect(authorLabel(s, { account: 'alice', session: 'hero' })).toBe('Alice')
    expect(authorLabel(s, { account: 'carol', session: null })).toBe('A member')
    const post = { id: 'p', seq: 1, ts: '', account: 'bob', session: 'rig', body: { kind: 'message' as const, text: 'hi' } }
    expect(recipients(s, post)).toBeNull()
    expect(recipients(s, { ...post, body: { ...post.body, to: [{ account: 'alice', session: 'hero' }, { account: 'bob' }] } })).toBe(
      'HeroGame (Alice), Bob',
    )
    expect(eventLine({ ...post, body: { kind: 'event', text: '', event: { type: 'push', ref: 'main', count: 3 } } })).toBe(
      'push · main · 3',
    )
    expect(eventLine({ ...post, body: { kind: 'event', text: '', event: { type: 'build', ok: false } } })).toBe('build · failed')
    expect(eventLine(post)).toBeNull()
  })

  test('claims that lapsed are left out, the newest first', () => {
    const now = Date.parse('2026-11-04T12:00:00Z')
    const claim = (id: string, at: string, until?: string) => ({ id, paths: [id], account: 'bob', session: 'rig', at, until })
    const held = heldClaims(
      [claim('a', '2026-11-04T10:00:00Z'), claim('b', '2026-11-04T11:00:00Z', '2026-11-04T11:30:00Z'), claim('c', '2026-11-04T11:00:00Z')],
      now,
    )
    expect(held.map(c => c.id)).toEqual(['c', 'a'])
  })

  test('the clock: time left, the last hour, the marks in order and the next one', () => {
    const clock = {
      deadline: '2026-11-08T18:00:00Z',
      milestones: [
        { name: 'Submit', at: '2026-11-08T17:30:00Z' },
        { name: 'Art lock', at: '2026-11-08T12:00:00Z' },
        { name: 'Bad', at: 'soon' },
      ],
    }
    const early = clockView(clock, Date.parse('2026-11-08T11:00:00Z'))
    expect([early.label, early.lastHour, early.ended, early.next?.name]).toEqual(['7 h left', false, false, 'Art lock'])
    expect(early.marks.map(m => [m.name, m.passed])).toEqual([
      ['Art lock', false],
      ['Submit', false],
    ])
    const late = clockView(clock, Date.parse('2026-11-08T17:15:00Z'))
    expect([late.label, late.lastHour, late.next?.name]).toEqual(['45 min left', true, 'Submit'])
    const over = clockView(clock, Date.parse('2026-11-08T18:00:00Z'))
    expect([over.label, over.ended, over.lastHour, over.next]).toEqual(['Time is up', true, false, null])
    expect(clockView(null).left).toBeNull()
    expect(clockView({ milestones: [] }).label).toBeNull()
    expect([timeLeft(30_000), timeLeft(3_600_000), timeLeft(26 * 3_600_000)]).toEqual(['Under a minute left', '1 h left', '1 day 2 h left'])
  })
})
