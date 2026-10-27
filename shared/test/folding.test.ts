import { expect, test } from 'bun:test'
import { foldSummary, machineFoldKey, toggledFold } from '../folding'
import type { SessionStatus } from '../protocol'

const sessions = (...statuses: SessionStatus[]) => statuses.map(status => ({ status }))

test('a folded machine says how many sessions it hides and the most pressing one, as in the notch', () => {
  expect(foldSummary([])).toEqual({ hidden: 0, attention: null })
  expect(foldSummary(sessions('working', 'idle'))).toEqual({ hidden: 2, attention: null })
  expect(foldSummary(sessions('waiting', 'error', 'idle'))).toEqual({ hidden: 3, attention: 'error' })
  expect(foldSummary(sessions('waiting', 'error', 'permission'))).toEqual({ hidden: 3, attention: 'permission' })
})

test('folding toggles one machine, with the notch key', () => {
  expect(machineFoldKey('PC-Studio')).toBe('machine:PC-Studio')
  const folded = toggledFold(new Set(), machineFoldKey('PC'))
  expect([...folded]).toEqual(['machine:PC'])
  expect([...toggledFold(folded, machineFoldKey('PC'))]).toEqual([])
})
