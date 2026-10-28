import { expect, test } from 'bun:test'
import { decodePoolInfo } from '../pool'
import {
  countdown,
  countdownLabel,
  HACKATHON_ROLES,
  hackathonInfo,
  hackathonNotes,
  hackathonRoleLabel,
  timeMarks,
  timeNotice,
} from '../pool-hackathon'
import table from './pool-countdown.json'

test('the countdown reads as the notch shows it', () => {
  for (const { ms, label } of table.cases) expect(countdownLabel(ms)).toBe(label)
  const now = Date.parse('2026-10-27T10:00:00Z')
  expect(countdown('2026-10-27T12:05:00Z', now)).toEqual({ left: 7_500_000, ended: false, label: '2 h 05 min left' })
  expect(countdown('2026-10-27T09:00:00Z', now)).toEqual({ left: 0, ended: true, label: 'Time is up' })
  expect(countdown(undefined, now)).toBeNull()
  expect(countdown('tomorrow', now)).toBeNull()
})

test('the template puts the deadline and the repo in the info, and the roles in the notes', () => {
  const now = new Date('2026-10-27T10:00:00Z')
  const setup = { deadline: '2026-10-28T10:00:00Z', repo: ' github.com/ana/shop ', roles: [...HACKATHON_ROLES, 'Front', ' '] }
  const info = hackathonInfo({ name: 'Basel Hack', goal: 'A shop' }, setup, now)
  expect(info).toEqual({
    name: 'Basel Hack',
    goal: 'A shop',
    template: 'hackathon',
    deadline: '2026-10-28T10:00:00Z',
    startedAt: '2026-10-27T10:00:00.000Z',
    repo: 'github.com/ana/shop',
  })
  // What another member sealed is read back as written; anything else is dropped.
  expect(decodePoolInfo(info)).toEqual(info)
  expect(decodePoolInfo({ name: 'x', template: 'party', deadline: 'soon', startedAt: 3 })).toEqual({ name: 'x' })
  const notes = hackathonNotes(setup)
  expect(notes.areas).toEqual(['front', 'back', 'infra', 'qa'].map(name => ({ name, paths: [] })))
  expect(notes.sections?.decisions).toContain('2026-10-28T10:00:00Z, in github.com/ana/shop')
  expect(HACKATHON_ROLES.map(hackathonRoleLabel)).toEqual(['front', 'back', 'infra', 'QA'])
})

test('the orchestrator is told at half time, one hour and fifteen minutes before the end', () => {
  const at = (iso: string) => Date.parse(iso)
  const info = { name: 'x', deadline: '2026-10-27T20:00:00Z', startedAt: '2026-10-27T10:00:00Z' }
  expect(timeMarks(info, 'then')).toEqual([
    { mark: 'half', at: at('2026-10-27T15:00:00Z') },
    { mark: 'hour', at: at('2026-10-27T19:00:00Z') },
    { mark: 'quarter', at: at('2026-10-27T19:45:00Z') },
  ])
  // A short hackathon has no "one hour left": it would come before the start. Without startedAt, the pool's creation.
  expect(timeMarks({ name: 'x', deadline: '2026-10-27T10:50:00Z' }, '2026-10-27T10:00:00Z').map(m => m.mark)).toEqual(['half', 'quarter'])
  expect(timeMarks({ name: 'x' }, '2026-10-27T10:00:00Z')).toEqual([])
  expect(timeMarks({ name: 'x', deadline: '2026-10-27T09:00:00Z' }, '2026-10-27T10:00:00Z')).toEqual([])
  expect(timeNotice('half', 5 * 3_600_000)).toStartWith('Half the time is gone: 5 h left.')
  expect(timeNotice('quarter', 900_000)).toStartWith('15 min left: freeze main.')
})
