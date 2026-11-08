// Codex's rollouts read as Claude Code's transcripts are: the conversation, its tools under Claude Code's names, the
// changed files, the task list, the turns, the tokens and the plan's usage. The fixture is made by hand in the shapes of
// Codex 0.142.2 (codex-rs/protocol), with nothing from a real session; what Codex may add later is skipped.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { changedFiles } from '../../shared/changed-files'
import type { Entry } from '../../shared/protocol'
import namesTable from '../../shared/test/codex-tool-names.json'
import { latestTodos, taskProgress } from '../../shared/todos'
import { EventDetector } from '../src/cluster/detect'
import { patchFiles } from '../src/codex/patch'
import { CodexRollout, execResult, parseRollout } from '../src/codex/rollout'
import { codexToolName, shellCommand } from '../src/codex/tools'
import { TranscriptWork } from '../src/transcript/work'

const FIXTURE = readFileSync(join(import.meta.dir, 'fixtures', 'codex-0.142.2.jsonl'), 'utf8').split('\n')
const parsed = parseRollout(FIXTURE)
const entries = parsed.flatMap(line => line.entries)
const shown = (list: Entry[]) => list.map(entry => [entry.kind, 'name' in entry ? entry.name : 'text' in entry ? entry.text : ''])

describe('a Codex rollout', () => {
  test('reads as the conversation the user saw, its tools under Claude Code names', () => {
    expect(shown(entries)).toEqual([
      ['user', 'Fix the failing test [Image #1]'],
      ['system', 'Reproducing the failure'],
      ['assistant', 'Running the tests to see the failure.'],
      ['tool', 'Bash'],
      [
        'tool_result',
        'Exit code 1\nsrc/math.test.ts:\n(fail) add > adds two numbers [0.21ms]\n\n 0 pass\n 1 fail\nRan 1 test across 1 file.\n',
      ],
      ['tool', 'TodoWrite'],
      ['tool_result', 'Plan updated'],
      ['tool', 'Edit'],
      ['tool', 'Write'],
      ['tool_result', 'Success. Updated the following files:\nM src/math.ts\nA docs/math.md\n'],
      ['tool', 'Bash'],
      ['tool_result', expect.stringContaining('1 pass')],
      ['tool', 'Bash'],
      ['tool_result', expect.stringContaining('[main 1a2b3c4] fix: add adds')],
      ['tool', 'Bash'],
      ['tool_result', 'Command running in background\n'],
      ['tool', 'Bash'],
      ['tool_result', 'To github.com:hero/hero.git\n   0a1b2c3..1a2b3c4  main -> main\n'],
      ['tool', 'TodoWrite'],
      ['tool_result', 'Plan updated'],
      ['assistant', '`add` subtracted. It adds now, the test passes, and the fix is pushed to `main`.'],
      ['user', 'Which flags does bun test take?'],
      ['tool', 'WebSearch'],
      ['tool_result', ''],
      ['tool', 'mcp__tonton__cluster_status'],
      ['tool_result', 'Status posted.'],
      ['tool', 'Read'],
      ['tool_result', ''],
      ['tool', 'Bash'],
      ['tool_result', 'math.test.ts\nmath.ts\n'],
      ['tool', 'Bash'],
      ['tool_result', 'exec command rejected by user'],
      ['system', 'Interrupted by user'],
      ['user', 'Say hello'],
      ['tool', 'Bash'],
      ['tool_result', 'hello\n'],
      ['system', 'Conversation compacted'],
      ['assistant', 'Hello!'],
    ])
    // The instructions Codex adds as the developer's and the user's, the tool search and lines of a newer Codex: none.
    expect(JSON.stringify(entries)).not.toContain('environment_context')
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length)
  })

  test('summaries, results and errors as the notch shows Claude Code calls', () => {
    const tools = entries.flatMap(entry => (entry.kind === 'tool' ? [[entry.toolUseId, entry.summary]] : []))
    expect(tools).toContainEqual(['call_commit', "git commit -am 'fix: add adds'"])
    expect(tools).toContainEqual(['call_poll', 'git push'])
    expect(tools).toContainEqual(['ws_1', 'bun test flags'])
    expect(tools).toContainEqual(['call_mcp', 'Reading bun docs'])
    expect(tools).toContainEqual(['call_view', '/work/hero/shot.png'])
    expect(tools).toContainEqual(['call_echo', 'echo hello'])
    const errors = entries.flatMap(entry => (entry.kind === 'tool_result' && entry.isError ? [entry.toolUseId] : []))
    expect(errors).toEqual(['call_test1', 'call_rm'])
    // The whole command of each shell call stays on the machine, for the cluster detector.
    expect(Object.assign({}, ...parsed.map(line => line.commands))).toMatchObject({ call_test1: 'bun test', call_poll: 'git push' })
  })

  test('images: the pasted screenshot on the prompt, the viewed one on its result', () => {
    const prompt = entries.find(entry => entry.kind === 'user')
    const viewed = entries.find(entry => entry.kind === 'tool_result' && entry.toolUseId === 'call_view')
    for (const entry of [prompt, viewed]) expect(entry).toMatchObject({ images: [{ mediaType: 'image/png', data: expect.any(String) }] })
  })

  test("the patch's files are changed files, with their edits", () => {
    expect(changedFiles(entries).map(({ path, written, edits, changes }) => ({ path, written, edits, changes }))).toEqual([
      { path: '/work/hero/docs/math.md', written: true, edits: [], changes: 1 },
      {
        path: '/work/hero/src/math.ts',
        written: false,
        edits: [{ oldText: '  return a - b\n}', newText: '  return a + b\n}' }],
        changes: 1,
      },
    ])
  })

  test('update_plan is the task list', () => {
    const plans = entries.filter(entry => entry.kind === 'tool' && entry.name === 'TodoWrite')
    expect(plans[0]).toMatchObject({
      todos: [
        { content: 'Reproduce the failure', status: 'completed' },
        { content: 'Fix add()', status: 'in_progress' },
        { content: 'Run the tests again', status: 'pending' },
      ],
    })
    expect(taskProgress(latestTodos(entries.slice(0, entries.indexOf(plans[1]))))).toEqual({ done: 1, total: 3 })
    // All done: the progress goes, as for Claude Code.
    expect(taskProgress(latestTodos(entries))).toBeNull()
  })

  test('the meta: title, model, window, tokens once per response, and the plan usage for later', () => {
    expect(parsed.find(line => line.title)?.title).toBe('Fix the failing test [Image #1]')
    expect(parsed.filter(line => line.title)).toHaveLength(1)
    expect(parsed.find(line => line.model)?.model).toBe('gpt-5.5')
    expect(parsed.find(line => line.contextWindow)?.contextWindow).toBe(258400)
    expect(parsed.find(line => line.session)?.session).toEqual({
      sessionId: '01a2b3c4-5d6e-7f80-91a2-b3c4d5e6f708',
      threadId: '01a2b3c4-5d6e-7f80-91a2-b3c4d5e6f708',
      cwd: '/work/hero',
      branch: 'main',
      cliVersion: '0.142.2',
      subagent: false,
    })
    // Cached input is apart, as Claude Code's cache reads are; the token_count with no info counts nothing.
    expect(parsed.flatMap(line => (line.usage ? [line.usage] : []))).toEqual([
      { requestId: 'codex-total-12900', input: 4000, output: 300, cacheRead: 8000, cacheWrite: 0 },
      { requestId: 'codex-total-25400', input: 1100, output: 400, cacheRead: 11000, cacheWrite: 0 },
      { requestId: 'codex-total-31000', input: 4000, output: 20, cacheRead: 0, cacheWrite: 0 },
    ])
    expect(parsed.findLast(line => line.rateLimits)?.rateLimits).toEqual({
      limitId: 'codex',
      planType: 'plus',
      primary: { usedPercent: 14, windowMinutes: 300, resetsAt: '2026-11-04T13:46:40.000Z' },
      secondary: { usedPercent: 3, windowMinutes: 10080, resetsAt: '2026-11-10T08:40:00.000Z' },
    })
    expect(parsed.filter(line => line.compacted)).toHaveLength(2)
  })

  test('turns: when each ended and how long it took, who started it, and the status they mean', () => {
    expect(parsed.flatMap(line => (line.turn ? [line.turn] : []))).toEqual([
      { end: '2026-11-04T10:01:35.000Z', seconds: 95 },
      { end: '2026-11-04T10:05:20.000Z', seconds: 20 },
      { end: '2026-11-04T10:10:06.000Z', seconds: 6 },
    ])
    expect(parsed.flatMap(line => (line.status ? [line.status] : []))).toEqual(['working', 'idle', 'working', 'idle', 'working', 'idle'])
    const work = new TranscriptWork()
    const facts = parsed.map(line => work.line(line))
    // The interrupted turn is no prompted one.
    expect(facts.flatMap(fact => fact.turns).map(({ id, seconds, prompted }) => ({ id, seconds, prompted }))).toEqual([
      { id: '01a2b3c4-6000-7000-8000-000000000001', seconds: 95, prompted: true },
      { id: '01a2b3c4-6000-7000-8000-000000000002', seconds: 20, prompted: false },
      { id: '01a2b3c4-6000-7000-8000-000000000003', seconds: 6, prompted: true },
    ])
    expect(facts.flatMap(fact => fact.tasks).map(task => task.content)).toEqual([
      'Reproduce the failure',
      'Reproduce the failure',
      'Fix add()',
      'Run the tests again',
    ])
    expect(work.cwd).toBe('/work/hero')
  })

  test('its shell calls tell the cluster about the tests, the commit and the push', () => {
    const commands = Object.assign({}, ...parsed.map(line => line.commands))
    const detected = new EventDetector('/work/hero').read(entries, id => commands[id])
    expect(detected.map(({ event }) => event)).toEqual([
      { type: 'test', ok: false, ref: 'bun test', count: 1 },
      { type: 'test', ok: true, ref: 'bun test', count: 1 },
      { type: 'commit', ok: true, ref: '1a2b3c4', count: 2 },
      { type: 'push', ok: true, ref: 'main', count: 1 },
    ])
  })

  test('read again or from the middle, it gives the same ids, and never throws', () => {
    expect(parseRollout(FIXTURE)).toEqual(parsed)
    const half = parseRollout(FIXTURE.slice(30)).flatMap(line => line.entries)
    const ids = new Set(entries.map(entry => entry.id))
    expect(half.length).toBeGreaterThan(0)
    for (const entry of half) expect(ids.has(entry.id)).toBe(true)
    const rollout = new CodexRollout()
    for (const raw of [
      '',
      'null',
      '[]',
      '{"type":"event_msg"}',
      '{"payload":3}',
      '{"type":"response_item","payload":{"type":"function_call"}}',
    ])
      expect(rollout.line(raw).entries).toEqual([])
    // Each line cut short, each field of the wrong type.
    for (const raw of FIXTURE) {
      for (const cut of [raw.length / 3, raw.length / 2].map(Math.floor)) expect(() => rollout.line(raw.slice(0, cut))).not.toThrow()
      expect(() => rollout.line(raw.replace(/"[^"]*"/g, '7'))).not.toThrow()
      expect(() => rollout.line(raw.replace(/:"[^"]*"/g, ':null'))).not.toThrow()
    }
  })
})

describe("Codex's other shapes", () => {
  const line = (type: string, payload: object) => JSON.stringify({ timestamp: '2026-11-04T10:00:00.000Z', type, payload })

  test('a patch run through the shell shows its files from what Codex applied', () => {
    const rollout = new CodexRollout()
    const call = rollout.line(
      line('response_item', {
        type: 'function_call',
        name: 'shell',
        arguments: JSON.stringify({ command: ['apply_patch', '*** Begin Patch\n*** Delete File: old.txt\n*** End Patch'] }),
        call_id: 'c1',
      }),
    )
    expect(call.entries).toMatchObject([{ name: 'Bash', toolUseId: 'c1' }])
    const applied = rollout.line(
      line('event_msg', {
        type: 'patch_apply_end',
        call_id: 'c1',
        success: true,
        changes: {
          '/w/old.txt': { type: 'delete', content: 'bye\n' },
          '/w/a.ts': { type: 'update', unified_diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n', move_path: '/w/b.ts' },
        },
      }),
    )
    expect(applied.entries).toMatchObject([
      { name: 'Edit', summary: '/w/old.txt', toolUseId: 'c1', edits: [{ oldText: 'bye\n', newText: '' }] },
      { name: 'Edit', summary: '/w/b.ts', toolUseId: 'c1', edits: [{ oldText: 'x', newText: 'y' }] },
    ])
  })

  test('a patch Codex could not apply is a failed call, and its files are not changed', () => {
    const rollout = new CodexRollout()
    const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch\n'
    const list = [
      line('turn_context', { cwd: '/w', model: 'gpt-5.5' }),
      line('response_item', { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ input: patch }), call_id: 'p1' }),
      line('event_msg', { type: 'patch_apply_end', call_id: 'p1', success: false, changes: {} }),
      line('response_item', { type: 'function_call_output', call_id: 'p1', output: 'apply_patch verification failed: no such hunk' }),
    ].flatMap(raw => rollout.line(raw).entries)
    expect(list).toMatchObject([
      { name: 'Edit', summary: '/w/a.ts' },
      { kind: 'tool_result', isError: true },
    ])
    expect(changedFiles(list)).toMatchObject([{ path: '/w/a.ts', changes: 0, lastFailed: true }])
  })

  test("the patch format's adds, deletes, moves and hunks", () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: new.md',
      '+# New',
      '*** Update File: src/a.ts',
      '*** Move to: src/b.ts',
      '@@ function one',
      ' keep',
      '-old',
      '+new',
      '@@',
      '-gone',
      '*** End of File',
      '*** Delete File: /abs/old.ts',
      '*** End Patch',
    ].join('\n')
    expect(patchFiles(patch, '/w')).toEqual([
      { tool: 'Write', path: '/w/new.md', edits: [] },
      {
        tool: 'Edit',
        path: '/w/src/b.ts',
        edits: [
          { oldText: 'keep\nold', newText: 'keep\nnew' },
          { oldText: 'gone', newText: '' },
        ],
      },
      { tool: 'Edit', path: '/abs/old.ts', edits: [] },
    ])
    expect(patchFiles('not a patch')).toEqual([])
  })

  test("shell outputs, as each of Codex's shell tools writes them", () => {
    expect(execResult('Exit code: 2\nWall time: 0.1 seconds\nOutput:\nboom\n')).toEqual({ text: 'Exit code 2\nboom\n', isError: true })
    expect(execResult('Wall time: 1.0 seconds\nProcess exited with code 0\nOutput:\nok')).toEqual({ text: 'ok', isError: false })
    expect(execResult('Chunk ID: a\nWall time: 1 seconds\nProcess running with session ID 3\nOutput:\npartial')).toEqual({
      text: 'Command running in background\npartial',
      isError: false,
      session: '3',
    })
    expect(execResult('{"output":"x","metadata":{"exit_code":1,"duration_seconds":0}}')).toEqual({ text: 'Exit code 1\nx', isError: true })
    expect(execResult('exec command rejected by user')).toEqual({ text: 'exec command rejected by user', isError: true })
    expect(execResult('something else')).toEqual({ text: 'something else', isError: false })
  })

  test('commands as a person types them, from each shape Codex gives', () => {
    expect(shellCommand({ cmd: 'bun test' })).toBe('bun test')
    expect(shellCommand({ command: 'ls -la' })).toBe('ls -la')
    expect(shellCommand({ command: ['bash', '-lc', 'cd web && bun test'] })).toBe('cd web && bun test')
    expect(shellCommand({ command: ['/bin/zsh', '-c', 'git push'] })).toBe('git push')
    expect(shellCommand({ command: ['powershell.exe', '-NoProfile', '-Command', 'git status'] })).toBe('git status')
    expect(shellCommand({ command: ['git', 'commit', '-m', "it's done"] })).toBe(`git commit -m 'it'\\''s done'`)
    expect(shellCommand({ command: [1, 2] })).toBeUndefined()
    expect(shellCommand({})).toBeUndefined()
  })

  test("a subagent's rollout and a prompt from a pool say so", () => {
    const rollout = new CodexRollout()
    const meta = rollout.line(line('session_meta', { id: 't2', session_id: 't1', cwd: '/w', source: { subagent: { thread_spawn: {} } } }))
    expect(meta.session).toMatchObject({ sessionId: 't1', threadId: 't2', subagent: true })
    const post = rollout.line(line('event_msg', { type: 'user_message', message: '<pool kind="task" from="Lead">Do it</pool>' }))
    expect(post.work?.start).toMatchObject({ from: 'pool', queued: false })
  })
})

test("Codex's tool names under Claude Code's, as shared/test/codex-tool-names.json has them", () => {
  for (const { tool, namespace, name } of namesTable.cases as { tool: string; namespace?: string; name: string }[])
    expect([tool, namespace, codexToolName(tool, namespace)]).toEqual([tool, namespace, name])
})
