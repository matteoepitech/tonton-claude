// Subagents write their own transcripts next to the session's: a temporary folder stands in for ~/.claude/projects.
import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Entry } from '../../shared/protocol'
import { Subagents, subEntries } from '../src/transcript/subagents'

const dir = mkdtempSync(join(tmpdir(), 'tonton-subagents-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const line = (fields: object) => `${JSON.stringify({ isSidechain: true, timestamp: '2026-10-27T10:00:00Z', ...fields })}\n`
const call = (uuid: string, id: string, command: string) =>
  line({ type: 'assistant', uuid, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
const result = (uuid: string, id: string, text: string) =>
  line({ type: 'user', uuid, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })

describe('subEntries', () => {
  test("a subagent's calls and results, under its Task call, and nothing else", () => {
    const lines = [
      line({ type: 'user', uuid: 'p', message: { content: 'Review the diff' } }),
      call('a1', 'toolu_1', 'git diff'),
      result('r1', 'toolu_1', 'diff --git'),
      line({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'text', text: 'Looks fine' }] } }),
      line({ type: 'assistant', uuid: 'a3', message: { content: [{ type: 'tool_use', id: 'x', name: 'SubagentHandback', input: {} }] } }),
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
        id: 'agent7:r1:0',
        ts: '2026-10-27T10:00:00Z',
        kind: 'sub_result',
        parent: 'toolu_task',
        toolUseId: 'toolu_1',
        text: 'diff --git',
        isError: false,
      },
    ])
  })
})

describe('Subagents', () => {
  test('follows each subagent named in a meta file, as it writes', async () => {
    const transcript = join(dir, 'session.jsonl')
    const folder = join(dir, 'session', 'subagents')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 'toolu_task1', description: 'Review' }))
    writeFileSync(join(folder, 'agent-a1.jsonl'), call('c1', 'toolu_1', 'ls'))
    // Meta files that name no Task call, or a strange one, are left alone.
    writeFileSync(join(folder, 'agent-a2.meta.json'), JSON.stringify({ toolUseId: '../../etc' }))
    writeFileSync(join(folder, 'agent-a2.jsonl'), call('c2', 'toolu_2', 'rm -rf /'))
    const seen: Entry[] = []
    const subagents = new Subagents(transcript, entries => seen.push(...entries))
    subagents.start()
    try {
      expect(seen.map(entry => entry.id)).toEqual(['a1:c1:0'])
      appendFileSync(join(folder, 'agent-a1.jsonl'), result('r1', 'toolu_1', 'README.md'))
      for (let i = 0; i < 40 && seen.length < 2; i++) await Bun.sleep(50)
      expect(seen.map(entry => entry.kind)).toEqual(['sub_tool', 'sub_result'])
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
