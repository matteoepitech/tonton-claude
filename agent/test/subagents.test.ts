// Subagents write their own transcripts next to the session's: a temporary folder stands in for ~/.claude/projects.
import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STEPS_PER_TASK, StepBudget, Subagents, type SubEntry, subEntries } from '../src/transcript/subagents'

const dir = mkdtempSync(join(tmpdir(), 'tonton-subagents-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const line = (fields: object) => `${JSON.stringify({ isSidechain: true, timestamp: '2026-10-27T10:00:00Z', ...fields })}\n`
const call = (uuid: string, id: string, command: string) =>
  line({ type: 'assistant', uuid, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
const result = (uuid: string, id: string, text: string) =>
  line({ type: 'user', uuid, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })

describe('subEntries', () => {
  test("a subagent's calls under its Task call, its failures without their text, and nothing else", () => {
    const lines = [
      line({ type: 'user', uuid: 'p', message: { content: 'Review the diff' } }),
      call('a1', 'toolu_1', 'git diff'),
      result('r1', 'toolu_1', 'diff --git'),
      call('a2', 'toolu_2', 'npm test'),
      line({
        type: 'user',
        uuid: 'r2',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'FAIL secret output', is_error: true }] },
      }),
      line({ type: 'assistant', uuid: 'a3', message: { content: [{ type: 'text', text: 'Looks fine' }] } }),
      line({ type: 'assistant', uuid: 'a4', message: { content: [{ type: 'tool_use', id: 'x', name: 'SubagentHandback', input: {} }] } }),
    ].map(raw => raw.trim())
    expect(subEntries(lines, 'agent7', 'toolu_task')).toEqual([
      {
        id: 'agent7:a1:0',
        ts: '2026-10-27T10:00:00Z',
        kind: 'sub_tool',
        parent: 'toolu_task',
        toolUseId: 'toolu_1',
        name: 'Bash',
        summary: 'git diff',
      },
      {
        id: 'agent7:a2:0',
        ts: '2026-10-27T10:00:00Z',
        kind: 'sub_tool',
        parent: 'toolu_task',
        toolUseId: 'toolu_2',
        name: 'Bash',
        summary: 'npm test',
      },
      {
        id: 'agent7:r2:0',
        ts: '2026-10-27T10:00:00Z',
        kind: 'sub_result',
        parent: 'toolu_task',
        toolUseId: 'toolu_2',
        text: '',
        isError: true,
      },
    ])
  })

  test('each Task sends its first calls, then one line saying there were more', () => {
    const budget = new StepBudget()
    const calls = (parent: string, count: number): SubEntry[] =>
      Array.from({ length: count }, (_, index) => ({
        id: `${parent}-${index}`,
        ts: '2026-10-27T10:00:00Z',
        kind: 'sub_tool',
        parent,
        toolUseId: `${parent}-call-${index}`,
        name: 'Bash',
        summary: `step ${index}`,
      }))
    const sent = budget.take(calls('task1', STEPS_PER_TASK + 10))
    expect(sent).toHaveLength(STEPS_PER_TASK + 1)
    expect(sent.at(-1)).toMatchObject({ id: 'task1:more', name: '', summary: 'More calls not shown' })
    expect(budget.take(calls('task1', 5))).toEqual([])
    expect(budget.take(calls('task2', 3))).toHaveLength(3)
  })
})

describe('Subagents', () => {
  test('what subagents wrote before is backlog, what comes after is news, and finished ones are let go', async () => {
    const transcript = join(dir, 'session.jsonl')
    const folder = join(dir, 'session', 'subagents')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 'toolu_task1', description: 'Review' }))
    writeFileSync(join(folder, 'agent-a1.jsonl'), call('c1', 'toolu_1', 'ls'))
    // Done an hour ago: read once with the backlog.
    writeFileSync(join(folder, 'agent-old.meta.json'), JSON.stringify({ toolUseId: 'toolu_task0' }))
    writeFileSync(join(folder, 'agent-old.jsonl'), call('c0', 'toolu_0', 'pwd'))
    const anHourAgo = new Date(Date.now() - 3600_000)
    utimesSync(join(folder, 'agent-old.jsonl'), anHourAgo, anHourAgo)
    // Meta files that name no Task call, or a strange one, are left alone.
    writeFileSync(join(folder, 'agent-a2.meta.json'), JSON.stringify({ toolUseId: '../../etc' }))
    writeFileSync(join(folder, 'agent-a2.jsonl'), call('c2', 'toolu_2', 'rm -rf /'))
    const seen: { id: string; backlog: boolean }[] = []
    const subagents = new Subagents(transcript, (entries, backlog) => seen.push(...entries.map(entry => ({ id: entry.id, backlog }))))
    subagents.start()
    try {
      expect(seen.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: 'a1:c1:0', backlog: true },
        { id: 'old:c0:0', backlog: true },
      ])
      appendFileSync(join(folder, 'agent-a1.jsonl'), call('c3', 'toolu_3', 'cat README.md'))
      appendFileSync(join(folder, 'agent-old.jsonl'), call('c4', 'toolu_4', 'never read'))
      for (let i = 0; i < 40 && seen.length < 3; i++) await Bun.sleep(50)
      await Bun.sleep(500)
      expect(seen.slice(2)).toEqual([{ id: 'a1:c3:0', backlog: false }])
    } finally {
      subagents.stop()
    }
  })

  test('a session without subagents has nothing to follow', () => {
    const subagents = new Subagents(join(dir, 'none.jsonl'), () => {
      throw new Error('no entries expected')
    })
    subagents.start()
    subagents.stop()
  })
})
