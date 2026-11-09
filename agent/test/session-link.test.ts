import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newestTranscript, type SessionLink, SessionLinkWatcher } from '../src/channel/session-link'
import { codexRun } from '../src/codex/wrapper'
import { paths } from '../src/config'

const AGENT = join(import.meta.dir, '../src/main.ts')
const temps: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tonton-link-'))
  temps.push(dir)
  return dir
}
const daysAgo = (file: string, days: number) => {
  const time = new Date(Date.now() - days * 24 * 3600_000)
  utimesSync(file, time, time)
}
const configDir = process.env.CLAUDE_CONFIG_DIR

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = configDir
})

/** Runs the hook as Claude Code does, as a child of this process: its link is named after this test's pid. */
async function hook(home: string, hook_event_name: string, session_id: string) {
  const input = { hook_event_name, session_id, transcript_path: join(home, `${session_id}.jsonl`), cwd: home }
  await Bun.spawn([process.execPath, AGENT, 'hook'], {
    env: { ...process.env, TONTON_HOME: home, TONTON_SERVICE: 'off' },
    stdin: new Blob([JSON.stringify(input)]),
  }).exited
}

test('a session that ends takes its link with it, so a claude that gets the same pid later never follows it', async () => {
  const home = temp()
  const run = join(home, 'run')
  const link = join(run, `${process.pid}.json`)
  mkdirSync(run, { recursive: true })
  // Left by a claude killed a week ago, and plan usage, which is not a link.
  writeFileSync(join(run, '4242.json'), '{"sessionId":"old"}')
  daysAgo(join(run, '4242.json'), 8)
  writeFileSync(join(run, 'usage-old.json'), '{}')
  daysAgo(join(run, 'usage-old.json'), 8)
  writeFileSync(join(run, '4343.json'), '{"sessionId":"idle"}')
  daysAgo(join(run, '4343.json'), 2)

  await hook(home, 'SessionStart', 'first')
  expect(JSON.parse(readFileSync(link, 'utf8')).sessionId).toBe('first')
  expect(existsSync(join(run, '4242.json'))).toBe(false)
  expect(existsSync(join(run, '4343.json'))).toBe(true)
  expect(existsSync(join(run, 'usage-old.json'))).toBe(true)

  // After /clear, the next session may start before the last one's SessionEnd: its link stays.
  await hook(home, 'SessionStart', 'second')
  await hook(home, 'SessionEnd', 'first')
  expect(JSON.parse(readFileSync(link, 'utf8')).sessionId).toBe('second')

  await hook(home, 'SessionEnd', 'second')
  expect(existsSync(link)).toBe(false)
})

test('the transcript of a folder whose path is over 200 characters is found in the folder Claude Code cut short', () => {
  const projects = temp()
  const cwd = `/${'deep/'.repeat(50)}`.slice(0, 250)
  expect(cwd).toHaveLength(250)
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const transcript = (folder: string, session: string, days: number) => {
    mkdirSync(join(projects, folder), { recursive: true })
    writeFileSync(join(projects, folder, `${session}.jsonl`), '')
    daysAgo(join(projects, folder, `${session}.jsonl`), days)
  }
  // Claude Code ends the name with a hash of the path. Another path that starts the same way has its own.
  transcript(`${name.slice(0, 200)}-1k2j3h`, 'this-one', 0)
  transcript(`${name.slice(0, 200)}-9z8y7x`, 'same-start', 1)
  transcript(`${name.slice(0, 199)}x-1k2j3h`, 'other-path', 0)

  expect(newestTranscript(cwd, projects)).toMatchObject({
    sessionId: 'this-one',
    file: join(projects, `${name.slice(0, 200)}-1k2j3h`, 'this-one.jsonl'),
  })
  expect(newestTranscript('/short/path', projects)).toBeNull()

  transcript('-short-path', 'short', 0)
  expect(newestTranscript('/short/path', projects)?.sessionId).toBe('short')
})

test('transcripts are looked for where CLAUDE_CONFIG_DIR puts them', () => {
  const configDir = temp()
  mkdirSync(join(configDir, 'projects', '-work-game'), { recursive: true })
  writeFileSync(join(configDir, 'projects', '-work-game', 'abc.jsonl'), '')
  process.env.CLAUDE_CONFIG_DIR = configDir
  expect(newestTranscript('/work/game')).toMatchObject({ sessionId: 'abc', file: join(configDir, 'projects', '-work-game', 'abc.jsonl') })
})

test('a Codex run by tonton codex is followed from the first thread its server started, before any hook or rollout', () => {
  // As `tonton codex` records its server, the parent of this channel, while its wrapper (this process here) runs.
  mkdirSync(codexRun(), { recursive: true })
  const record = join(codexRun(), `${process.ppid}.json`)
  const threads = [
    { id: 'thread-1', cwd: '/work/shop', path: '/codex/sessions/rollout-1.jsonl' },
    { id: 'thread-2', cwd: '/work/shop' },
  ]
  writeFileSync(record, JSON.stringify({ socket: '/s.sock', serverPid: process.ppid, wrapperPid: process.pid, startedAt: '', threads }))
  try {
    const follow = (tool: 'claude' | 'codex') => {
      const seen: SessionLink[] = []
      const watcher = new SessionLinkWatcher(link => seen.push(link), tool)
      watcher.start()
      watcher.stop()
      return seen
    }
    expect(follow('codex')).toEqual([
      { sessionId: 'thread-1', transcriptPath: '/codex/sessions/rollout-1.jsonl', cwd: '/work/shop', tool: 'codex' },
    ])
    // Claude Code's channel has no such server.
    expect(follow('claude')).toEqual([])
  } finally {
    rmSync(record, { force: true })
  }
})

test('every read of the link is told, for cluster delivery to compare what it published with what the hooks say now', async () => {
  mkdirSync(paths.run, { recursive: true })
  const file = join(paths.run, `${process.ppid}.json`)
  writeFileSync(file, JSON.stringify({ sessionId: 'mode', transcriptPath: null, cwd: '/work', event: 'Stop', permissionMode: 'default' }))
  const followed: string[] = []
  let reads = 0
  const watcher = new SessionLinkWatcher(
    link => followed.push(link.sessionId),
    'claude',
    () => reads++,
  )
  watcher.start()
  try {
    expect(reads).toBe(1)
    // A mode that came and went between two reads leaves the link as it was: it is told all the same.
    for (let i = 0; i < 40 && reads < 2; i++) await Bun.sleep(50)
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(followed).toEqual(['mode'])
  } finally {
    watcher.stop()
    rmSync(file, { force: true })
  }
})
