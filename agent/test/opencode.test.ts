// OpenCode's events as the plugin hands them over: a real OpenCode 2.0.32 run, OpenCode 1's shapes, the plugin file, and
// the bridge's reading of the plugin's stream.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lines } from '../src/opencode/bridge'
import { OpenCodeTracker, type SessionUpdate } from '../src/opencode/events'
import { pluginSource } from '../src/opencode/plugin'

const dir = mkdtempSync(join(tmpdir(), 'tonton-opencode-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function replay(events: unknown[]) {
  const tracker = new OpenCodeTracker()
  const updates: SessionUpdate[] = events.flatMap(event => tracker.handle(event))
  return {
    tracker,
    updates,
    entries: updates.flatMap(update => update.entries),
    statuses: updates.flatMap(update => (update.status ? [update.status] : [])),
  }
}

describe('OpenCode 2', () => {
  // A prompt, a shell call that asks for permission, its output and the answer, each event twice as OpenCode 2 delivers it.
  const events = readFileSync(join(import.meta.dir, 'fixtures/opencode-2.0.32.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  const sessionId = 'ses_e872d9012ffeqUp0ZMJp9G4Gx2'

  test('a real run becomes the conversation the notch shows, each entry once', () => {
    const { entries } = replay(events)
    expect(
      entries.map(entry => [entry.kind, 'text' in entry ? entry.text : entry.kind === 'tool' ? `${entry.name} ${entry.summary}` : '']),
    ).toEqual([
      ['user', 'Say hi with bash'],
      ['tool', 'Bash echo hi-from-probe'],
      ['assistant', 'Let me check.'],
      ['tool_result', 'hi-from-probe\n'],
      ['assistant', 'Done: the command printed hi-from-probe.'],
    ])
    const [, call, , result] = entries
    expect(call.kind === 'tool' && result.kind === 'tool_result' && call.toolUseId === result.toolUseId).toBe(true)
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length)
  })

  test('the status follows the run, through the permission it asked for', () => {
    expect(replay(events).statuses).toEqual([
      { hook: 'UserPromptSubmit' },
      { hook: 'Notification', notificationType: 'permission_prompt', text: 'OpenCode needs your permission to use Bash' },
      { hook: 'UserPromptSubmit' },
      { hook: 'Stop' },
    ])
  })

  test('title, folder, cost, tokens and context make the meta, the window once the models are known', () => {
    const { tracker } = replay(events)
    expect(tracker.cwd(sessionId)).toBe('/Users/me/code/shop')
    expect(tracker.meta(sessionId)).toEqual({
      title: 'Probe title',
      costUSD: 0,
      tokens: { input: 240, output: 60, cacheRead: 0, cacheWrite: 0 },
      context: { usedTokens: 120, windowTokens: undefined },
      lastMessage: 'Done: the command printed hi-from-probe.',
      terminal: false,
      commands: ['compact', 'interrupt', 'model'],
      model: 'mock-model',
    })
    expect(tracker.model(sessionId)).toEqual({ providerID: 'mock', modelID: 'mock-model' })
    const models = tracker.handle({
      type: 'tonton.models',
      data: { models: [{ providerID: 'mock', modelID: 'mock-model', context: 200_000 }] },
    })
    expect(models.map(update => update.sessionId)).toEqual([sessionId])
    expect(tracker.meta(sessionId).context).toEqual({ usedTokens: 120, windowTokens: 200_000 })
  })

  test('the model menu picks the latest of a family, from the session provider first, then Anthropic', () => {
    const { tracker } = replay(events)
    tracker.handle({
      type: 'tonton.models',
      data: {
        models: [
          { providerID: 'anthropic', modelID: 'claude-sonnet-4-5', released: 1_750_000_000_000 },
          { providerID: 'anthropic', modelID: 'claude-sonnet-5-5', released: 1_790_000_000_000 },
          { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-5-5', released: 1_790_000_000_000 },
          { providerID: 'openrouter', modelID: 'anthropic/claude-haiku-4-5', released: 1_760_000_000_000 },
          { providerID: 'mock', modelID: 'mock-model' },
        ],
      },
    })
    expect(tracker.familyModel(sessionId, 'sonnet')).toMatchObject({ providerID: 'anthropic', modelID: 'claude-sonnet-5-5' })
    expect(tracker.familyModel(sessionId, 'haiku')).toMatchObject({ providerID: 'openrouter', modelID: 'anthropic/claude-haiku-4-5' })
    expect(tracker.familyModel(sessionId, 'opus')).toBeUndefined()
    // Once on OpenRouter, the session stays with it.
    tracker.handle({
      id: 'sw',
      created: 9,
      type: 'session.model.switched',
      data: { sessionID: sessionId, model: { id: 'anthropic/claude-haiku-4-5', providerID: 'openrouter' } },
    })
    expect(tracker.meta(sessionId).model).toBe('anthropic/claude-haiku-4-5')
    expect(tracker.familyModel(sessionId, 'sonnet')).toMatchObject({ providerID: 'openrouter' })
  })

  test("a pool machine's model is a family or a provider's model OpenCode has, once it said which it has", () => {
    const { tracker } = replay(events)
    expect(tracker.knowsModels).toBe(false)
    tracker.handle({
      type: 'tonton.models',
      data: {
        models: [
          { providerID: 'anthropic', modelID: 'claude-sonnet-5-5', released: 1_790_000_000_000 },
          { providerID: 'ollama', modelID: 'qwen3:32b' },
        ],
      },
    })
    expect(tracker.knowsModels).toBe(true)
    expect(tracker.namedModel(sessionId, 'sonnet')).toMatchObject({ providerID: 'anthropic', modelID: 'claude-sonnet-5-5' })
    expect(tracker.namedModel(sessionId, 'ollama/qwen3:32b')).toMatchObject({ providerID: 'ollama', modelID: 'qwen3:32b' })
    expect(tracker.namedModel(sessionId, 'ollama/llama3')).toBeUndefined()
    expect(tracker.namedModel(sessionId, 'opus')).toBeUndefined()
  })

  test('the permission it asked for becomes a request card, closed once answered', () => {
    const { updates } = replay(events)
    expect(updates.flatMap(update => (update.permission ? [update.permission] : []))).toEqual([
      {
        requestId: 'per_178d2702e001LspZ8bx422WJrW',
        detail: { toolName: 'Bash', description: 'echo hi-from-probe', inputPreview: '{"command":"echo hi-from-probe"}' },
        input: { command: 'echo hi-from-probe' },
      },
    ])
    expect(updates.flatMap(update => (update.permissionClosed ? [update.permissionClosed] : []))).toEqual([
      'per_178d2702e001LspZ8bx422WJrW',
    ])
  })

  test("OpenCode's history of a session gives the same entries as its events, live ones kept in place", () => {
    const history = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/opencode-2.0.32-context.json'), 'utf8'))
    const id = history.info.id
    const tracker = new OpenCodeTracker()
    // A message typed while the history was on its way.
    tracker.handle({
      id: 'late',
      created: 1_893_456_000_000,
      type: 'session.inbox.enqueued',
      data: { sessionID: id, inboxID: 'msg_late', item: { type: 'user', payload: { text: 'And now?' } } },
    })
    const [update] = tracker.handle({ type: 'tonton.history', data: { sessionID: id, ...history } })
    expect(update.history?.map(entry => [entry.kind, 'text' in entry ? entry.text : entry.kind === 'tool' ? entry.name : ''])).toEqual([
      ['user', 'Say hi with bash'],
      ['assistant', 'Let me check.'],
      ['tool', 'Bash'],
      ['tool_result', 'hi-from-probe\n'],
      ['assistant', 'Done: the command printed hi-from-probe.'],
      ['user', 'And now?'],
    ])
    expect(tracker.meta(id)).toMatchObject({ title: 'Probe title', tokens: { input: 240, output: 60 }, context: { usedTokens: 120 } })
    expect(tracker.cwd(id)).toBe('/Users/me/code/shop')
    // The live events of the same calls add nothing.
    const again = tracker.handle({
      type: 'session.text.ended',
      data: { sessionID: id, assistantMessageID: history.messages[1].id, ordinal: 0, text: 'Let me check.' },
    })
    expect(again).toEqual([])
  })

  test('a command that failed in OpenCode says so in the conversation, a compaction empties the gauge', () => {
    const { entries, tracker } = replay([
      ...events,
      { type: 'tonton.failed', data: { sessionID: sessionId, op: 'compact', message: 'nothing to compact' } },
      { id: 'c1', created: 2, type: 'session.compaction.ended', data: { sessionID: sessionId } },
      // A real refusal from OpenCode 2.0.32, and the cancel an interruption brings, which says nothing.
      {
        id: 'c2',
        created: 3,
        type: 'session.compaction.failed',
        data: {
          sessionID: sessionId,
          error: { type: 'compaction.failed', message: 'Compaction summary did not match the required template' },
        },
      },
      {
        id: 'c3',
        created: 4,
        type: 'session.compaction.failed',
        data: { sessionID: sessionId, error: { type: 'aborted', message: 'Compaction cancelled' } },
      },
    ])
    expect(entries.slice(-3)).toMatchObject([
      { kind: 'system', text: 'OpenCode did not compact the conversation: nothing to compact' },
      { kind: 'system', text: 'Conversation compacted' },
      { kind: 'system', text: 'OpenCode did not compact the conversation: Compaction summary did not match the required template' },
    ])
    expect(tracker.meta(sessionId).context?.usedTokens).toBe(0)
  })

  test('a failed run stays in error until the next prompt, an interrupted one says so', () => {
    const at = (type: string, data: object, id = crypto.randomUUID()) => ({ id, created: 1, type, data: { sessionID: 's', ...data } })
    const failed = replay([
      at('session.execution.started', {}),
      at('session.execution.failed', { error: { type: 'unknown', message: 'Provider is down' } }),
      at('session.execution.succeeded', {}),
    ])
    expect(failed.statuses.map(status => status.hook)).toEqual(['UserPromptSubmit', 'StopFailure'])
    expect(failed.statuses[1].text).toBe('Provider is down')

    const interrupted = replay([at('session.execution.started', {}), at('session.execution.interrupted', {})])
    expect(interrupted.statuses.map(status => status.hook)).toEqual(['UserPromptSubmit', 'Stop'])
    expect(interrupted.entries).toMatchObject([{ kind: 'system', text: 'Interrupted by user' }])
  })
})

describe('task lists', () => {
  const input = {
    todos: [
      { id: '1', content: 'Write the fix', status: 'completed', priority: 'high' },
      { id: '2', content: 'Run the tests', status: 'in_progress', priority: 'medium' },
    ],
  }
  const expected = [
    { content: 'Write the fix', status: 'completed' },
    { content: 'Run the tests', status: 'in_progress' },
  ]

  test("OpenCode 2's todowrite is a TodoWrite with its list", () => {
    const { entries } = replay([
      { type: 'session.created', data: { sessionID: 'ses_2', location: { directory: '/home/me/api' } } },
      { type: 'session.tool.called', data: { sessionID: 'ses_2', callID: 'call_t', tool: 'todowrite', input, timestamp: 1 } },
    ])
    expect(entries).toMatchObject([{ kind: 'tool', name: 'TodoWrite', todos: expected }])
  })

  test("OpenCode 1's todowrite part too", () => {
    const { entries } = replay([
      { type: 'session.created', properties: { info: { id: 'ses_1', directory: '/home/me/api', version: '1', time: {} } } },
      {
        type: 'message.updated',
        properties: { info: { id: 'm1', sessionID: 'ses_1', role: 'assistant', time: { created: 1_700_000_000_000 } } },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            sessionID: 'ses_1',
            id: 'p1',
            messageID: 'm1',
            type: 'tool',
            callID: 'c1',
            tool: 'todowrite',
            state: { status: 'running', input },
          },
        },
      },
    ])
    expect(entries.find(entry => entry.kind === 'tool')).toMatchObject({ name: 'TodoWrite', todos: expected })
  })
})

describe('OpenCode 1', () => {
  const session = { id: 'ses_1', directory: '/home/me/api', title: 'Fix the login', projectID: 'p', version: '1', time: {} }
  const message = (id: string, role: string, extra: object = {}) => ({
    type: 'message.updated',
    properties: { info: { id, sessionID: 'ses_1', role, time: { created: 1_700_000_000_000 }, ...extra } },
  })
  const part = (part: object) => ({ type: 'message.part.updated', properties: { part: { sessionID: 'ses_1', ...part } } })

  test('messages and parts become entries once complete, tools with their result', () => {
    const { entries, tracker } = replay([
      { type: 'session.created', properties: { info: session } },
      part({ id: 'p1', messageID: 'm1', type: 'text', text: 'Fix it' }),
      message('m1', 'user'),
      message('m2', 'assistant', { cost: 0.02, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } } }),
      part({ id: 'p2', messageID: 'm2', type: 'text', text: 'Look', time: { start: 1 } }),
      part({ id: 'p2', messageID: 'm2', type: 'text', text: 'Looking at it', time: { start: 1, end: 2 } }),
      part({ id: 'p3', messageID: 'm2', type: 'tool', callID: 'c1', tool: 'edit', state: { status: 'pending', input: {} } }),
      part({
        id: 'p3',
        messageID: 'm2',
        type: 'tool',
        callID: 'c1',
        tool: 'edit',
        state: { status: 'running', input: { filePath: '/home/me/api/a.ts', oldString: 'a', newString: 'b' } },
      }),
      part({
        id: 'p3',
        messageID: 'm2',
        type: 'tool',
        callID: 'c1',
        tool: 'edit',
        state: { status: 'completed', input: { filePath: '/home/me/api/a.ts', oldString: 'a', newString: 'b' }, output: 'Edited' },
      }),
      part({ id: 'p4', messageID: 'm2', type: 'text', text: 'injected', synthetic: true, time: { end: 3 } }),
    ])
    expect(entries).toMatchObject([
      { id: 'p1', kind: 'user', text: 'Fix it' },
      { id: 'p2', kind: 'assistant', text: 'Looking at it' },
      { id: 'p3', kind: 'tool', name: 'Edit', summary: '/home/me/api/a.ts', toolUseId: 'c1', edits: [{ oldText: 'a', newText: 'b' }] },
      { id: 'p3:result', kind: 'tool_result', text: 'Edited', isError: false },
    ])
    expect(tracker.meta('ses_1')).toMatchObject({ title: 'Fix the login', costUSD: 0.02, tokens: { input: 10, output: 7, cacheRead: 1 } })
    expect(tracker.cwd('ses_1')).toBe('/home/me/api')
  })

  test('its history is the messages and their parts', () => {
    const { updates } = replay([
      {
        type: 'tonton.history',
        data: {
          sessionID: 'ses_1',
          info: session,
          messages: [
            {
              info: { id: 'm1', role: 'user', time: { created: 1_700_000_000_000 } },
              parts: [{ id: 'p1', messageID: 'm1', type: 'text', text: 'Hi' }],
            },
            {
              info: {
                id: 'm2',
                role: 'assistant',
                time: { created: 1_700_000_001_000, completed: 1 },
                providerID: 'anthropic',
                modelID: 'x',
              },
              parts: [{ id: 'p2', messageID: 'm2', type: 'text', text: 'Hello' }],
            },
          ],
        },
      },
    ])
    expect(updates.at(-1)?.history?.map(entry => entry.id)).toEqual(['p1', 'p2'])
  })

  test('a permission names what it touches from its pattern', () => {
    const { updates } = replay([
      {
        type: 'permission.updated',
        properties: { id: 'per_1', type: 'edit', pattern: '/home/me/api/a.ts', sessionID: 'ses_1', title: 'Edit a.ts', metadata: {} },
      },
      { type: 'permission.replied', properties: { sessionID: 'ses_1', permissionID: 'per_1', response: 'once' } },
    ])
    expect(updates.find(update => update.permission)?.permission).toEqual({
      requestId: 'per_1',
      detail: { toolName: 'Edit', description: 'Edit a.ts', inputPreview: '{"file_path":"/home/me/api/a.ts"}' },
      input: { file_path: '/home/me/api/a.ts' },
    })
    expect(updates.find(update => update.permissionClosed)?.permissionClosed).toBe('per_1')
  })

  test('text that only came as deltas is kept for the end of the message', () => {
    const { entries } = replay([
      message('m1', 'assistant'),
      part({ id: 'p1', messageID: 'm1', type: 'text', text: '' }),
      { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'm1', partID: 'p1', field: 'text', delta: 'Hel' } },
      { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'm1', partID: 'p1', field: 'text', delta: 'lo' } },
      message('m1', 'assistant', { time: { created: 1, completed: 2 } }),
    ])
    expect(entries).toMatchObject([{ kind: 'assistant', text: 'Hello' }])
  })

  test('idle is said once, an abort reads as an interruption, subagents stay out of the list', () => {
    const { statuses, entries } = replay([
      { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
      { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
      { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
      { type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'MessageAbortedError', data: {} } } },
      { type: 'session.created', properties: { info: { ...session, id: 'ses_child', parentID: 'ses_1' } } },
      { type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'busy' } } },
    ])
    expect(statuses.map(status => status.hook)).toEqual(['UserPromptSubmit', 'Stop', 'UserPromptSubmit', 'Stop'])
    expect(entries).toMatchObject([{ kind: 'system', text: 'Interrupted by user' }])
  })

  test('images come as data URLs, other files are left out', () => {
    const png = 'iVBORw0KGgo='
    const { entries } = replay([
      message('m1', 'user'),
      part({ id: 'p1', messageID: 'm1', type: 'file', mime: 'image/png', filename: 'shot.png', url: `data:image/png;base64,${png}` }),
      part({ id: 'p2', messageID: 'm1', type: 'file', mime: 'application/pdf', filename: 'a.pdf', url: 'file:///tmp/a.pdf' }),
      {
        id: 'e1',
        created: 1,
        type: 'session.tool.success',
        data: {
          sessionID: 'ses_1',
          id: 'call_1',
          content: [
            { type: 'text', text: 'Took it' },
            { type: 'file', mime: 'image/png', url: `data:image/png;base64,${png}` },
          ],
        },
      },
    ])
    expect(entries).toMatchObject([
      { id: 'p1', kind: 'user', text: 'shot.png', images: [{ mediaType: 'image/png', data: png }] },
      { kind: 'tool_result', text: 'Took it', images: [{ mediaType: 'image/png', data: png }] },
    ])
  })

  test('a shell command that exits with an error is an error, as in Claude Code', () => {
    const shell = (id: string, exit: unknown) => ({
      id,
      created: 1,
      type: 'session.tool.success',
      data: { sessionID: 'ses_1', id, content: [{ type: 'text', text: 'out' }], metadata: { status: 'completed', exit } },
    })
    const bash = (id: string, exit: unknown) =>
      part({
        id,
        messageID: 'm1',
        type: 'tool',
        callID: id,
        tool: 'bash',
        state: { status: 'completed', input: {}, output: 'out', metadata: { exit } },
      })
    const { entries } = replay([
      message('m1', 'assistant'),
      shell('c1', 0),
      shell('c2', 2),
      shell('c3', null),
      bash('c4', 0),
      bash('c5', 1),
    ])
    const results = entries.filter(entry => entry.kind === 'tool_result')
    // A failed command starts with its exit code, as in Claude Code; one stopped before it ended (null) is an error too.
    expect(results.map(entry => entry.kind === 'tool_result' && [entry.toolUseId, entry.isError, entry.text])).toEqual([
      ['c1', false, 'out'],
      ['c2', true, 'Exit code 2\nout'],
      ['c3', true, 'out'],
      ['c4', false, 'out'],
      ['c5', true, 'Exit code 1\nout'],
    ])
  })

  test('so does a failed command in the history OpenCode 2 keeps', () => {
    const tool = (id: string, exit: unknown) => ({
      type: 'tool',
      id,
      name: 'shell',
      state: {
        status: 'completed',
        input: { command: 'make' },
        content: [{ type: 'text', text: 'out' }],
        metadata: { status: 'completed', exit },
      },
    })
    const messages = [{ id: 'm1', type: 'assistant', time: { created: 1_793_032_549_195 }, content: [tool('c1', 0), tool('c2', 2)] }]
    const tracker = new OpenCodeTracker()
    const [update] = tracker.handle({ type: 'tonton.history', data: { sessionID: 'ses_1', messages } })
    const results = (update?.history ?? []).filter(entry => entry.kind === 'tool_result')
    expect(results.map(entry => entry.kind === 'tool_result' && [entry.toolUseId, entry.isError, entry.text])).toEqual([
      ['c1', false, 'out'],
      ['c2', true, 'Exit code 2\nout'],
    ])
    expect(tracker.command('ses_1', 'c2')).toBe('make')
  })

  test('a long result keeps its start and its end', () => {
    const output = `start\n${'x'.repeat(10_000)}\nResult: Failed`
    const { entries } = replay([
      message('m1', 'assistant'),
      part({ id: 'p1', messageID: 'm1', type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'completed', input: {}, output } }),
    ])
    const result = entries.find(entry => entry.kind === 'tool_result')
    expect(result?.kind === 'tool_result' && result.text).toMatch(/^start\n[\s\S]*characters truncated\)\n[\s\S]*Result: Failed$/)
  })

  test('anything unexpected is skipped', () => {
    const tracker = new OpenCodeTracker()
    for (const event of [null, 3, 'x', {}, { type: 'message.updated' }, { type: 'message.part.updated', properties: { part: 5 } }]) {
      expect(tracker.handle(event)).toEqual([])
    }
  })
})

describe('plugin', () => {
  const eventually = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 80; i++) {
      if (check()) return
      await Bun.sleep(50)
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  test('hands the events the bridge reads to one bridge, from OpenCode 1 and 2 alike', async () => {
    const received = join(dir, 'received.jsonl')
    const sink = join(dir, 'sink.ts')
    writeFileSync(
      sink,
      `for await (const chunk of Bun.stdin.stream()) require('node:fs').appendFileSync(${JSON.stringify(received)}, chunk)\n`,
    )
    const file = join(dir, 'tonton-claude.js')
    writeFileSync(file, pluginSource([process.execPath, sink]))
    const plugin = (await import(file)).default

    expect(plugin.id).toBe('tonton-claude')
    // OpenCode 1
    const hooks = await plugin.server({})
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'a' } } })
    await hooks.event({ event: { type: 'lsp.updated', properties: {} } })
    // OpenCode 2
    async function* stream() {
      yield { id: 'e1', type: 'session.execution.started', data: { sessionID: 'b' } }
      yield { id: 'e2', type: 'session.text.delta', data: { sessionID: 'b', delta: 'x' } }
    }
    await plugin.setup({ event: { subscribe: () => stream() } })

    await eventually(() => existsSync(received) && readFileSync(received, 'utf8').split('\n').filter(Boolean).length === 2, 'two events')
    const lines = readFileSync(received, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line).type)
    expect(lines.sort()).toEqual(['session.execution.started', 'session.idle'])
    ;(globalThis as { __tontonClaude?: { bridge?: { kill(): void } } }).__tontonClaude?.bridge?.kill()
  })

  test('asks the bridge before an edit, in OpenCode 1 and 2, and the edit fails with its reason', async () => {
    // A bridge that holds every Main.umap.
    const bridge = join(dir, 'guard-bridge.ts')
    writeFileSync(
      bridge,
      `let buffer = ''
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const event = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    if (event.type !== 'tonton.guard') continue
    const held = JSON.stringify(event.data.args).includes('Main.umap')
    process.stdout.write(JSON.stringify({ op: 'tool_result', callID: event.data.callID, output: held ? event.data.sessionID + ' held' : '' }) + '\\n')
  }
}
`,
    )
    const file = join(dir, 'tonton-claude-guard.js')
    writeFileSync(file, pluginSource([process.execPath, bridge]))
    const plugin = (await import(file)).default

    // OpenCode 1
    const hooks = await plugin.server({})
    const before = hooks['tool.execute.before']
    await expect(before({ tool: 'edit', sessionID: 'a', callID: 'c1' }, { args: { filePath: 'Content/Maps/Main.umap' } })).rejects.toThrow(
      'a held',
    )
    await expect(
      before({ tool: 'write', sessionID: 'a', callID: 'c2' }, { args: { filePath: 'Content/Free.umap' } }),
    ).resolves.toBeUndefined()
    // Not an edit: the bridge is not asked.
    await expect(before({ tool: 'bash', sessionID: 'a', callID: 'c3' }, { args: { command: 'cat Main.umap' } })).resolves.toBeUndefined()

    // OpenCode 2
    let hooked: ((event: unknown) => Promise<void>) | undefined
    await plugin.setup({
      event: { subscribe: async function* () {} },
      tool: {
        hook: (name: string, run: (event: unknown) => Promise<void>) => {
          if (name === 'execute.before') hooked = run
        },
      },
    })
    if (!hooked) throw new Error('no execute.before hook')
    await expect(hooked({ tool: 'edit', sessionID: 'b', id: 'c4', input: { filePath: 'Content/Maps/Main.umap' } })).rejects.toThrow(
      'b held',
    )
    await expect(
      hooked({ tool: 'apply_patch', sessionID: 'b', id: 'c5', input: { patchText: '*** Update File: a.ts' } }),
    ).resolves.toBeUndefined()
    ;(globalThis as { __tontonClaude?: { bridge?: { kill(): void } } }).__tontonClaude?.bridge?.kill()
  })
})

describe("the bridge's lines", () => {
  /** The stream the plugin writes to the bridge, in the chunks given. */
  async function read(chunks: (string | Uint8Array)[]) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
        controller.close()
      },
    })
    const read: string[] = []
    for await (const line of lines(stream)) read.push(line)
    return read
  }

  test('a long line in many chunks, then the next one', async () => {
    const long = JSON.stringify({ type: 'message.part.updated', output: 'x'.repeat(4 * 1024 * 1024) })
    const data = new TextEncoder().encode(`${long}\n{"type":"session.idle"}\n`)
    const chunks = Array.from({ length: Math.ceil(data.length / 4096) }, (_, index) => data.subarray(index * 4096, (index + 1) * 4096))
    expect(await read(chunks)).toEqual([long, '{"type":"session.idle"}'])
  })

  test('several lines in one chunk, blank ones skipped, and a line cut across chunks', async () => {
    expect(await read(['a\nb\n\n  \nc\n'])).toEqual(['a', 'b', 'c'])
    expect(await read(['a\nb', 'c', 'd\ne\n'])).toEqual(['a', 'bcd', 'e'])
    expect(await read(['\n', '\n', 'a', '\n'])).toEqual(['a'])
  })

  test('the last line without a newline, and a character cut between chunks', async () => {
    expect(await read(['a\nlast'])).toEqual(['a', 'last'])
    const word = new TextEncoder().encode('réponse\nfin')
    expect(await read([word.subarray(0, 2), word.subarray(2)])).toEqual(['réponse', 'fin'])
  })
})
