// Codex's folder as Codex lays it out: a rollout per thread under sessions/YYYY/MM/DD, the names users gave threads in
// session_index.jsonl, and which rollout a channel follows while no hook told it.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexHome, homeOfRollout, newestRollout, rolloutFiles, rolloutLines, threadName } from '../src/codex/home'

const dir = mkdtempSync(join(tmpdir(), 'tonton-codex-home-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const NOW = new Date(2026, 10, 4, 12, 0, 0).getTime()
const sessions = join(dir, 'sessions')
const today = join(sessions, '2026', '11', '04')
mkdirSync(today, { recursive: true })

function rollout(name: string, meta: object | null, modified = NOW) {
  const file = join(today, name)
  const first = meta ? JSON.stringify({ timestamp: '2026-11-04T10:00:00.000Z', type: 'session_meta', payload: meta }) : 'garbage'
  writeFileSync(file, `${first}\n{"type":"event_msg","payload":{"type":"task_started"}}\n`)
  utimesSync(file, new Date(modified), new Date(modified))
  return file
}

test("Codex's folder, from CODEX_HOME or the home folder, and from a rollout's path", () => {
  expect(codexHome({ CODEX_HOME: '/custom' }, '/home/me')).toBe('/custom')
  expect(codexHome({}, '/home/me')).toBe(join('/home/me', '.codex'))
  expect(homeOfRollout(join(dir, 'sessions', '2026', '11', '04', 'rollout-x.jsonl'))).toBe(dir)
  expect(homeOfRollout('/tmp/elsewhere/a/b/rollout-x.jsonl')).toBeUndefined()
})

test('the rollout a channel follows: the newest of its folder since it started, never a subagent or another folder', () => {
  const mine = rollout('rollout-2026-11-04T11-59-00-aaaa.jsonl', { id: 'thread-a', session_id: 'thread-a', cwd: '/work/hero' }, NOW - 1000)
  rollout('rollout-2026-11-04T11-59-30-bbbb.jsonl', { id: 'sub', session_id: 'thread-a', cwd: '/work/hero', parent_thread_id: 'thread-a' })
  rollout('rollout-2026-11-04T11-59-40-cccc.jsonl', { id: 'other', cwd: '/work/other' })
  rollout('rollout-2026-11-04T11-59-50-dddd.jsonl', null)
  rollout('rollout-2026-11-04T10-00-00-eeee.jsonl', { id: 'old', cwd: '/work/hero' }, NOW - 3600_000)
  expect(newestRollout('/work/hero', NOW - 60_000, sessions, NOW)).toEqual({ sessionId: 'thread-a', file: mine, modified: NOW - 1000 })
  expect(newestRollout('/work/none', NOW - 60_000, sessions, NOW)).toBeNull()
  expect(newestRollout('/work/hero', NOW - 60_000, join(dir, 'nowhere'), NOW)).toBeNull()
  // The backfill's files: plain and compressed, back to `since`.
  writeFileSync(join(today, 'rollout-z.jsonl.zst'), Bun.zstdCompressSync(Buffer.from('{"a":1}\n{"b":2}\n')))
  utimesSync(join(today, 'rollout-z.jsonl.zst'), new Date(NOW), new Date(NOW))
  writeFileSync(join(today, 'notes.txt'), '')
  const files = rolloutFiles(sessions, NOW - 2 * 3600_000, NOW)
  expect(files.map(file => file.slice(today.length + 1)).sort()).toEqual([
    'rollout-2026-11-04T10-00-00-eeee.jsonl',
    'rollout-2026-11-04T11-59-00-aaaa.jsonl',
    'rollout-2026-11-04T11-59-30-bbbb.jsonl',
    'rollout-2026-11-04T11-59-40-cccc.jsonl',
    'rollout-2026-11-04T11-59-50-dddd.jsonl',
    'rollout-z.jsonl.zst',
  ])
  expect(rolloutLines(join(today, 'rollout-z.jsonl.zst'))).toEqual(['{"a":1}', '{"b":2}', ''])
})

test("a thread's name, the newest entry winning", () => {
  const names = [
    { id: 'thread-a', thread_name: 'First name', updated_at: '2026-11-04T10:00:00Z' },
    { id: 'thread-b', thread_name: 'Other', updated_at: '2026-11-04T10:01:00Z' },
    { id: 'thread-a', thread_name: 'Fix the hero', updated_at: '2026-11-04T10:02:00Z' },
  ]
  writeFileSync(join(dir, 'session_index.jsonl'), `${names.map(entry => JSON.stringify(entry)).join('\n')}\nnot json thread-a\n`)
  expect(threadName(dir, 'thread-a')).toBe('Fix the hero')
  expect(threadName(dir, 'thread-c')).toBeUndefined()
  expect(threadName(join(dir, 'nowhere'), 'thread-a')).toBeUndefined()
})
