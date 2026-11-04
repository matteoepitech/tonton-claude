// XP version 2 from a session's work: Claude Code's transcript lines and OpenCode's events, read the way the live agent
// and the backfill read them, give the same facts, the same ids and the same XP for the same work.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { awardRPGAt, newRPGState, type RPGReward, type RPGState, rpgReward } from '../../shared/rpg'
import { OpenCodeTracker } from '../src/opencode/events'
import { checklistRewards, turnRewards, workRewards } from '../src/rpg-work'
import { assistant, at, CLAUDE_SESSION, claude, ended, OPENCODE_SESSION, openCode, result, T0, toolUse, user } from './rpg-fixtures'

const award = (rewards: RPGReward[], state: RPGState = newRPGState()) =>
  rewards.reduce((hero, reward) => awardRPGAt(hero, reward, Date.now()), state)

describe('turns', () => {
  test('Claude Code: who started each turn, how long it worked, and what broke it', () => {
    const work = claude(CLAUDE_SESSION)
    expect(work.turns).toEqual([
      { id: 'd1', at: at(180), seconds: 180, prompted: true },
      { id: 'd2', at: at(1120), seconds: 120, prompted: false },
      { id: 'd3', at: at(2030), seconds: 30, prompted: false },
    ])
    expect(work.pool).toBe(true)
    expect(work.cwd).toBe('/work/hero')
  })

  test('a read that starts in the middle of a long transcript names the same turns', () => {
    const whole = claude(CLAUDE_SESSION).turns
    // The channel reads only the end of a long transcript: here from inside the first turn, past its prompt.
    const tail = claude(CLAUDE_SESSION.slice(2)).turns
    expect(tail.map(turn => turn.id)).toEqual(whole.map(turn => turn.id))
    // Its prompt was not read: the turn earns its minutes, and the whole read, which saw the prompt, the rest.
    expect(tail[0]).toEqual({ ...whole[0], prompted: false })
  })

  test('OpenCode 1: a prompt and the answers that name it, from the prompt to the last answer', () => {
    const work = openCode(OPENCODE_SESSION)
    expect(work.turns).toEqual([
      { id: 'm1', at: at(180), seconds: 180, prompted: true },
      { id: 'm2', at: at(1120), seconds: 120, prompted: false },
      { id: 'm3', at: at(2030), seconds: 30, prompted: false },
    ])
    // Read again, as when the bridge gets the history: no turn twice.
    const tracker = new OpenCodeTracker()
    const twice = [...OPENCODE_SESSION, ...OPENCODE_SESSION].flatMap(event => tracker.handle(event)).flatMap(update => update.turns ?? [])
    expect(twice.map(turn => turn.id)).toEqual(['m1', 'm2', 'm3'])
  })

  test('OpenCode 1: the history of a session met halfway is the past, its running turn is not', () => {
    const tracker = new OpenCodeTracker()
    const message = (info: object) => ({ info: { sessionID: 'ses_1', ...info }, parts: [] })
    const updates = tracker.handle({
      type: 'tonton.history',
      properties: {
        sessionID: 'ses_1',
        messages: [
          message({ id: 'm1', role: 'user', time: { created: T0 } }),
          message({ id: 'a1', role: 'assistant', parentID: 'm1', time: { created: T0, completed: T0 + 90_000 }, finish: 'stop' }),
          message({ id: 'm2', role: 'user', time: { created: T0 + 100_000 } }),
          message({ id: 'a2', role: 'assistant', parentID: 'm2', time: { created: T0 + 100_000 } }),
        ],
      },
    })
    expect(updates.flatMap(update => update.turns ?? [])).toEqual([])
    const answer = { id: 'a2', sessionID: 'ses_1', role: 'assistant', parentID: 'm2', finish: 'stop' }
    const later = [
      { type: 'message.updated', properties: { info: { ...answer, time: { created: T0 + 100_000, completed: T0 + 220_000 } } } },
      { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
    ].flatMap(event => tracker.handle(event))
    expect(later.flatMap(update => update.turns ?? [])).toEqual([{ id: 'm2', at: at(220), seconds: 120, prompted: true }])
  })

  test('OpenCode 1: an answer that completes after the session went idle still ends its turn', () => {
    const tracker = new OpenCodeTracker()
    const info = (fields: object) => ({ type: 'message.updated', properties: { info: { sessionID: 'ses_1', ...fields } } })
    const status = (type: string) => ({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type } } })
    const events = [
      info({ id: 'm1', role: 'user', time: { created: T0 } }),
      status('busy'),
      info({ id: 'a1', role: 'assistant', parentID: 'm1', time: { created: T0 } }),
      status('idle'),
      info({ id: 'a1', role: 'assistant', parentID: 'm1', time: { created: T0, completed: T0 + 61_000 }, finish: 'stop' }),
    ]
    expect(events.flatMap(event => tracker.handle(event)).flatMap(update => update.turns ?? [])).toEqual([
      { id: 'm1', at: at(61), seconds: 61, prompted: true },
    ])
  })

  test('OpenCode 2: from busy to idle, named by the prompt that started it', () => {
    const fixture = readFileSync(join(import.meta.dir, 'fixtures/opencode-2.0.32.jsonl'), 'utf8')
    const tracker = new OpenCodeTracker()
    const turns = fixture
      .split('\n')
      .filter(Boolean)
      .flatMap(line => tracker.handle(JSON.parse(line)))
      .flatMap(update => update.turns ?? [])
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ id: 'msg_178d26ff40016ZgvbQygYl0hq5', prompted: true })
    expect(turns[0].seconds).toBeCloseTo(0.549, 3)
  })

  test('what starts a turn: the notch, a background task, another session, a queued prompt, a scheduled wakeup', () => {
    const work = claude([
      user('n1', 0, '<channel source="tonton" sender="notch">Ship it</channel>', { isMeta: true, origin: { kind: 'channel' } }),
      ended('e1', 60, 60_000),
      user('b1', 100, '<task-notification><summary>Tests finished</summary></task-notification>', {
        origin: { kind: 'task-notification' },
      }),
      // The user types while Claude works: the prompt waits in the queue, and the turn is theirs too.
      {
        type: 'attachment',
        uuid: 'q1',
        timestamp: at(110),
        attachment: { type: 'queued_command', prompt: 'and docs', origin: { kind: 'human' } },
      },
      ended('e2', 200, 100_000),
      // Another Claude session's message is a meta line: nothing names the turn but its end.
      user('x1', 300, 'Another Claude session sent a message', { isMeta: true, origin: { kind: 'peer' } }),
      ended('e3', 400, 100_000),
      { type: 'system', subtype: 'scheduled_task_fire', uuid: 's1', timestamp: at(500), content: 'Claude resuming /loop wakeup' },
      ended('e4', 600, 100_000),
      // An old transcript without origins, then a summary after a compaction, which starts nothing.
      user('o1', 700, 'Old prompt'),
      user('c1', 710, 'This session is being continued from a previous conversation', { isCompactSummary: true }),
      {
        type: 'assistant',
        uuid: 'api',
        timestamp: at(720),
        isApiErrorMessage: true,
        message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] },
      },
      ended('e5', 730, 30_000),
    ])
    expect(work.turns.map(({ id, prompted }) => ({ id, prompted }))).toEqual([
      { id: 'e1', prompted: true },
      { id: 'e2', prompted: true },
      { id: 'e3', prompted: false },
      { id: 'e4', prompted: false },
      { id: 'e5', prompted: false },
    ])
  })

  test('time waiting on a permission prompt is not work', () => {
    const work = claude([user('u1', 0, 'Deploy', { origin: { kind: 'human' } }), ended('d1', 600, 600_000)], { 1: 240_000 })
    expect(work.turns).toEqual([{ id: 'd1', at: at(600), seconds: 360, prompted: true }])
  })
})

describe('tasks', () => {
  test('TodoWrite keeps version 1 identities: spaces collapsed, failed, cancelled and unanswered calls left out', async () => {
    const work = claude([
      assistant('a1', 0, [
        toolUse('t1', 'TodoWrite', {
          todos: [
            { content: ' Fix  the test ', status: 'completed' },
            { content: 'Cancelled', status: 'cancelled' },
          ],
        }),
        toolUse('t2', 'TodoWrite', { todos: [{ content: 'Failed', status: 'completed' }] }),
        toolUse('t3', 'TodoWrite', { todos: [{ content: 'Unanswered', status: 'completed' }] }),
      ]),
      user('r1', 1, [result('t1', 'ok'), result('t2', 'no', true)]),
    ])
    expect(work.tasks).toEqual([{ content: 'Fix the test', at: at(0) }])
    expect(await checklistRewards('session', work.tasks ?? [])).toEqual([await rpgReward('task', 'session\nFix the test', at(0))])
  })

  test('TaskUpdate to completed names the task by the subject TaskCreate gave it, or a new one', () => {
    const work = claude([
      assistant('a1', 0, [toolUse('t1', 'TaskCreate', { subject: 'Write the docs', description: 'All of them' })]),
      user('r1', 1, [result('t1', 'Task #1 created successfully: Write the docs')]),
      assistant('a2', 2, [toolUse('t2', 'TaskCreate', { subject: 'Old name', description: '' })]),
      user('r2', 3, [result('t2', 'Task #2 created successfully: Old name')]),
      assistant('a3', 4, [toolUse('t3', 'TaskUpdate', { taskId: '1', status: 'in_progress' })]),
      assistant('a4', 5, [toolUse('t4', 'TaskUpdate', { taskId: '1', status: 'completed' })]),
      assistant('a5', 6, [toolUse('t5', 'TaskUpdate', { taskId: '2', subject: 'New  name', status: 'completed' })]),
      assistant('a6', 7, [toolUse('t6', 'TaskUpdate', { taskId: '9', status: 'completed' })]),
      user('r3', 8, [result('t3', 'Updated'), result('t4', 'Updated task #1 status'), result('t5', 'Updated'), result('t6', 'Updated')]),
    ])
    expect(work.tasks).toEqual([
      { content: 'Write the docs', at: at(5) },
      { content: 'New name', at: at(6) },
    ])
  })
})

describe('rewards', () => {
  test('Claude Code and OpenCode earn the same XP for the same work', async () => {
    const fromClaude = claude(CLAUDE_SESSION)
    const fromOpenCode = openCode(OPENCODE_SESSION)
    const claudeRewards = await workRewards('session-a', fromClaude, false)
    const openCodeRewards = await workRewards('ses_1', fromOpenCode, false)
    const summary = (rewards: RPGReward[]) => rewards.map(({ kind, seconds, prompted, note }) => ({ kind, seconds, prompted, note }))
    expect(summary(claudeRewards)).toEqual(summary(openCodeRewards))
    // The turn: 5 for the prompt and 3 for its minutes. The pool's turn: its 2 minutes. The interrupted one earns nothing.
    // The day's first prompt 20, the task 10, the commit pushed 15.
    expect(award(claudeRewards).xp).toBe(55)
    expect(award(openCodeRewards).xp).toBe(55)
    // The commit is the same commit wherever it was pushed from: one reward for both.
    expect(claudeRewards.find(r => r.kind === 'push')?.id).toBe(openCodeRewards.find(r => r.kind === 'push')?.id)
    expect(award([...claudeRewards, ...openCodeRewards]).xp).toBe(55 + 8 + 2 + 10)
  })

  test('a push at the end of a long command counts: the whole command is read, not its cut summary', async () => {
    const command = `npm run build -- --label ${'x'.repeat(320)} && git push`
    const work = claude([
      assistant('a1', 0, [toolUse('t1', 'Bash', { command })]),
      user('r1', 5, [result('t1', 'To github.com:me/hero.git\n   0f0f0f0..9a9a9a9  main -> main')]),
    ])
    expect(work.vcs).toEqual([{ kind: 'push', ts: at(5), branch: 'main', commits: ['9a9a9a9'] }])
  })

  test('a pool session earns its turns and pushes, not its checklist', async () => {
    const rewards = await workRewards('session', claude(CLAUDE_SESSION), true)
    expect(rewards.map(reward => reward.kind).sort()).toEqual(['day', 'push', 'turn', 'turn'])
  })

  test('the same lines give the same ids, and nothing older than the backfill earns', async () => {
    const first = await workRewards('session', claude(CLAUDE_SESSION), false)
    expect(await workRewards('session', claude(CLAUDE_SESSION), false)).toEqual(first)
    expect(await workRewards('session', claude(CLAUDE_SESSION), false, T0 + 1000 * 1000)).toEqual(
      first.filter(reward => (reward.at ?? '') >= at(1000)),
    )
  })

  test('a turn carries its facts, never an amount', async () => {
    const [turn, day] = await turnRewards('s', { id: 'u1', at: at(180), seconds: 180.4, prompted: true }, '/work/hero/')
    expect(turn).toEqual(await rpgReward('turn', 's\nu1', at(180), { seconds: 180, prompted: true, note: 'hero' }))
    expect(day).toEqual(await rpgReward('day', at(180).slice(0, 10), at(180)))
    expect(await turnRewards('s', { id: 'u2', at: at(10), seconds: 59, prompted: false })).toEqual([])
  })
})
