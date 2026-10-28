// Both transcript formats normalize into the same successful checklist call before awarding XP.
import { expect, test } from 'bun:test'
import type { Entry } from '../../shared/protocol'
import { rpgReward } from '../../shared/rpg'
import { taskRewards } from '../src/rpg'

const call: Entry = {
  id: 'call',
  ts: '2026-10-28T12:00:00Z',
  kind: 'tool',
  name: 'TodoWrite',
  toolUseId: 'tool1',
  summary: '',
  todos: [
    { content: ' Fix  the test ', status: 'completed' },
    { content: 'Cancelled', status: 'cancelled' },
  ],
}
const result: Entry = { id: 'result', ts: '2026-10-28T12:01:00Z', kind: 'tool_result', toolUseId: 'tool1', text: 'ok', isError: false }
test('a successful task has a stable identity across whitespace, replay and tool call ids', async () => {
  const rewards = await taskRewards('session', [call, result])
  expect(rewards).toEqual([await rpgReward('task', 'session\nFix the test', call.ts)])
  expect(
    await taskRewards('session', [
      { ...call, id: 'replayed', toolUseId: 'new' },
      { ...result, toolUseId: 'new' },
    ]),
  ).toEqual(rewards)
})
test('failed, unfinished, unknown and historical calls do not earn rewards', async () => {
  expect(await taskRewards('session', [call])).toEqual([])
  expect(await taskRewards('session', [call, { ...result, isError: true }])).toEqual([])
  expect(await taskRewards('session', [{ ...call, name: 'Unknown' }, result])).toEqual([])
  expect(await taskRewards('session', [call, result], [])).toEqual([])
})
