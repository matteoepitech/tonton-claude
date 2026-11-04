// Claude Code's transcript lines and OpenCode's events for the same work, and how the live agent reads each: the XP
// tests and the backfill's compare against them.
import { EventDetector, type VcsWork } from '../src/cluster/detect'
import { OpenCodeTracker } from '../src/opencode/events'
import { parseLine } from '../src/transcript/parser'
import { type TaskFact, TranscriptWork, type TurnFact } from '../src/transcript/work'

/** A session's work as the live agent reads it, and whether a pool post reached it. */
export interface ReadWork {
  turns: TurnFact[]
  tasks: TaskFact[]
  vcs: VcsWork[]
  cwd?: string
  pool: boolean
}

/** Two hours ago, on a whole second: recent enough for the backfill's window, far from now. */
export const T0 = Math.floor((Date.now() - 2 * 3600_000) / 1000) * 1000
export const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

/** Claude Code's lines, through the parser and the work tracker as the channel reads them. */
export function claude(lines: object[], waits: Record<number, number> = {}): ReadWork {
  const work = new TranscriptWork()
  const pushes = new EventDetector()
  const turns: TurnFact[] = []
  const tasks: TaskFact[] = []
  const vcs: VcsWork[] = []
  lines.forEach((line, index) => {
    if (waits[index]) work.waited(waits[index])
    const parsed = parseLine(JSON.stringify(line))
    const facts = work.line(parsed)
    turns.push(...facts.turns)
    tasks.push(...facts.tasks)
    vcs.push(...pushes.work(parsed.entries, id => work.command(id)))
  })
  return { turns, tasks, vcs, cwd: work.cwd, pool: work.pool }
}

/** OpenCode's events, through the tracker as the bridge reads them. */
export function openCode(events: object[]): ReadWork {
  const tracker = new OpenCodeTracker()
  const work = new TranscriptWork()
  const pushes = new EventDetector()
  const turns: TurnFact[] = []
  const tasks: TaskFact[] = []
  const vcs: VcsWork[] = []
  let pool = false
  for (const event of events) {
    for (const update of tracker.handle(event)) {
      turns.push(...(update.turns ?? []))
      tasks.push(...work.line({ entries: update.entries }).tasks)
      vcs.push(...pushes.work(update.entries, id => tracker.command('ses_1', id)))
      pool ||= update.entries.some(entry => entry.kind === 'user' && entry.text.startsWith('<pool '))
    }
  }
  return { turns, tasks, vcs, cwd: tracker.cwd('ses_1'), pool }
}

export const PUSHED =
  '[main 1a2b3c4] Fix the bug\n 1 file changed, 2 insertions(+)\nTo github.com:me/hero.git\n   0f0f0f0..1a2b3c4  main -> main'
export const POOL_POST = '<pool kind="task" from="Lead" task="t1">\nAdd the tests\n</pool>'
export const user = (uuid: string, seconds: number, content: unknown, extra: object = {}) => ({
  type: 'user',
  uuid,
  timestamp: at(seconds),
  cwd: '/work/hero',
  message: { content },
  ...extra,
})
export const assistant = (uuid: string, seconds: number, content: object[]) => ({
  type: 'assistant',
  uuid,
  timestamp: at(seconds),
  message: { content },
})
export const toolUse = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input })
export const result = (id: string, content: string, isError = false) => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
  is_error: isError,
})
export const ended = (uuid: string, seconds: number, durationMs: number) => ({
  type: 'system',
  subtype: 'turn_duration',
  uuid,
  timestamp: at(seconds),
  durationMs,
})

/** A prompt worked 3 minutes (a task done, a commit pushed), a pool post 2 minutes, a prompt interrupted after 30 s. */
export const CLAUDE_SESSION = [
  user('u1', 0, 'Fix the bug', { origin: { kind: 'human' } }),
  assistant('a1', 10, [toolUse('t1', 'TodoWrite', { todos: [{ content: ' Fix  the bug ', status: 'completed', activeForm: 'Fixing' }] })]),
  user('r1', 11, [result('t1', 'Todos have been modified successfully')]),
  assistant('a2', 20, [toolUse('t2', 'Bash', { command: 'git commit -am "Fix the bug" && git push' })]),
  user('r2', 30, [result('t2', PUSHED)]),
  ended('d1', 180, 180_000),
  user('u2', 1000, `<channel source="tonton" sender="pool">\n${POOL_POST}\n</channel>`, { isMeta: true, origin: { kind: 'channel' } }),
  ended('d2', 1120, 120_000),
  user('u3', 2000, 'Try again', { origin: { kind: 'human' } }),
  user('i3', 2030, [{ type: 'text', text: '[Request interrupted by user]' }]),
  ended('d3', 2030, 30_000),
]

/** The same work in OpenCode 1: messages, the answers naming their prompt, parts, and the session's statuses. */
export const OPENCODE_SESSION = (() => {
  const ms = (seconds: number) => T0 + seconds * 1000
  const message = (id: string, role: string, created: number, extra: object = {}) => ({
    type: 'message.updated',
    properties: { info: { id, sessionID: 'ses_1', role, time: { created: ms(created) }, ...extra } },
  })
  const part = (id: string, messageID: string, fields: object) => ({
    type: 'message.part.updated',
    properties: { part: { id, messageID, sessionID: 'ses_1', ...fields } },
  })
  const status = (type: string) => ({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type } } })
  const answer = (id: string, parent: string, created: number, completed: number, extra: object = {}) =>
    message(id, 'assistant', created, {
      parentID: parent,
      time: { created: ms(created), completed: ms(completed) },
      finish: 'stop',
      ...extra,
    })
  return [
    { type: 'session.created', properties: { info: { id: 'ses_1', directory: '/work/hero' } } },
    message('m1', 'user', 0),
    part('p1', 'm1', { type: 'text', text: 'Fix the bug' }),
    status('busy'),
    part('p2', 'a1', {
      type: 'tool',
      tool: 'todowrite',
      callID: 'c1',
      state: { status: 'completed', input: { todos: [{ content: 'Fix the bug', status: 'completed', id: '1' }] }, output: '[]' },
    }),
    part('p3', 'a1', {
      type: 'tool',
      tool: 'bash',
      callID: 'c2',
      state: { status: 'completed', input: { command: 'git commit -am "Fix the bug" && git push' }, output: PUSHED, metadata: { exit: 0 } },
    }),
    answer('a1', 'm1', 1, 180),
    status('idle'),
    message('m2', 'user', 1000),
    part('p4', 'm2', { type: 'text', text: POOL_POST }),
    status('busy'),
    answer('a2', 'm2', 1001, 1120),
    status('idle'),
    message('m3', 'user', 2000),
    part('p5', 'm3', { type: 'text', text: 'Try again' }),
    status('busy'),
    answer('a3', 'm3', 2001, 2030, { error: { name: 'MessageAbortedError' }, finish: undefined }),
    { type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'MessageAbortedError' } } },
  ]
})()
