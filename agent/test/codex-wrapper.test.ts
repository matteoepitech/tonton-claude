import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexRun, readServerRecord, runCodex, serverRecords, startedThread } from '../src/codex/wrapper'

const dir = mkdtempSync(join(tmpdir(), 'tonton-codex-'))
const run = join(dir, 'run')
const project = join(dir, 'project')
mkdirSync(project)
const out = join(dir, 'out.txt')
const fake = [process.execPath, join(import.meta.dir, 'fake-codex.ts')]
const env = { ...process.env }

afterAll(() => {
  process.env = env
  rmSync(dir, { recursive: true, force: true })
})

describe('tonton codex', () => {
  test('the TUI runs on an app-server whose threads are recorded while it runs, then everything goes', async () => {
    process.env.FAKE_CODEX_OUT = out
    process.env.FAKE_CODEX_STAY_MS = '800'
    process.env.FAKE_CODEX_EXIT = '3'
    const previous = process.cwd()
    process.chdir(project)
    const exited = runCodex(['-m', 'gpt-5-codex'], { run, codex: fake })
    let seen: ReturnType<typeof serverRecords> = []
    for (let i = 0; i < 100 && !seen.some(r => r.threads.length); i++) {
      await Bun.sleep(50)
      seen = serverRecords(run)
    }
    process.chdir(previous)
    expect(seen).toHaveLength(1)
    const record = seen[0]
    expect(record?.wrapperPid).toBe(process.pid)
    expect(record?.socket).toBe(join(codexRun(run), `${process.pid}.sock`))
    // Codex names the folder by its real path.
    expect(record?.threads).toEqual([{ id: 'thread-1', cwd: realpathSync(project), path: '/sessions/rollout-1.jsonl' }])
    expect(readServerRecord(record?.serverPid ?? 0, run)?.threads).toHaveLength(1)
    expect(await exited).toBe(3)
    // The TUI got the user's arguments after its own.
    expect(readFileSync(out, 'utf8').trim()).toBe('["-m","gpt-5-codex"]')
    expect(serverRecords(run)).toEqual([])
    expect(existsSync(record?.socket ?? '')).toBe(false)
  })

  test('a thread that cannot be read is not one', () => {
    expect(startedThread({ thread: { id: 't', cwd: '/a', path: '/p', extra: 1 } })).toEqual({ id: 't', cwd: '/a', path: '/p' })
    expect(startedThread({ thread: { cwd: '/a' } })).toBeNull()
    expect(startedThread(null)).toBeNull()
  })

  test('without a socket it can use, plain codex runs', async () => {
    rmSync(out, { force: true })
    process.env.FAKE_CODEX_OUT = out
    const long = join(dir, 'x'.repeat(120))
    expect(await runCodex(['resume'], { run: long, codex: fake })).toBe(0)
    expect(readFileSync(out, 'utf8').trim()).toBe('plain ["resume"]')
  })
})
