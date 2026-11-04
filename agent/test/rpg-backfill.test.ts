// The welcome backfill reads Claude Code's transcripts and OpenCode 1's database the way the live agent reads them: the
// same ids as live, nothing twice, nothing older than two weeks, nothing from subagents' transcripts.
import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newAccountKey } from '../../shared/crypto'
import { AgentRPG } from '../src/rpg'
import { backfillRewards, backfillSources } from '../src/rpg-backfill'
import { workRewards } from '../src/rpg-work'
import { CLAUDE_SESSION, claude, OPENCODE_SESSION, openCode, T0, user } from './rpg-fixtures'

const dir = mkdtempSync(join(tmpdir(), 'tonton-backfill-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const SESSION = '0b8f6a52-2c6e-4d1a-9f3e-7a1c2b3d4e5f'
const jsonl = (lines: object[]) => `${lines.map(line => JSON.stringify(line)).join('\n')}\n`

/** OpenCode 1's tables, with the columns the backfill reads, filled from the events of the same session. */
function openCodeDatabase(path: string) {
  const db = new Database(path, { create: true })
  db.run('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_updated INTEGER NOT NULL)')
  db.run('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)')
  db.run(
    'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)',
  )
  db.run('INSERT INTO session VALUES (?, NULL, ?, ?)', ['ses_1', '/work/hero', T0 + 3_000_000])
  // A subagent's session: its time is in its parent's turn.
  db.run('INSERT INTO session VALUES (?, ?, ?, ?)', ['ses_child', 'ses_1', '/work/hero', T0 + 3_000_000])
  db.run('INSERT INTO message VALUES (?, ?, ?, ?)', ['m_child', 'ses_child', T0, JSON.stringify({ role: 'user', time: { created: T0 } })])
  let order = 0
  for (const event of OPENCODE_SESSION as { type: string; properties: Record<string, Record<string, unknown>> }[]) {
    if (event.type === 'message.updated') {
      const { id, sessionID: _, ...data } = event.properties.info
      const created = (data.time as { created: number }).created
      db.run('INSERT OR REPLACE INTO message VALUES (?, ?, ?, ?)', [id as string, 'ses_1', created, JSON.stringify(data)])
    } else if (event.type === 'message.part.updated') {
      const { id, messageID, sessionID: _, ...data } = event.properties.part
      db.run('INSERT OR REPLACE INTO part VALUES (?, ?, ?, ?, ?)', [
        id as string,
        messageID as string,
        'ses_1',
        T0 + order++,
        JSON.stringify(data),
      ])
    }
  }
  db.close()
}

test('two weeks of both tools, with the ids the live agent gives them, and the same again on a second run', async () => {
  const claudeHome = join(dir, 'claude')
  const project = join(claudeHome, 'projects', '-work-hero')
  mkdirSync(join(project, SESSION, 'subagents'), { recursive: true })
  writeFileSync(join(project, `${SESSION}.jsonl`), jsonl(CLAUDE_SESSION))
  // A subagent's own transcript, and a session last written a month ago.
  writeFileSync(join(project, SESSION, 'subagents', 'agent-a1.jsonl'), jsonl(CLAUDE_SESSION))
  const old = join(project, '1c9e7b63-3d7f-4e2b-8a4f-8b2d3c4e5f60.jsonl')
  writeFileSync(old, jsonl([user('o1', 0, 'Old work', { origin: { kind: 'human' } })]))
  utimesSync(old, new Date(T0 - 30 * 86_400_000), new Date(T0 - 30 * 86_400_000))
  writeFileSync(join(project, 'notes.txt'), 'not a transcript')
  mkdirSync(join(dir, 'data', 'opencode'), { recursive: true })
  openCodeDatabase(join(dir, 'data', 'opencode', 'opencode.db'))

  const sources = backfillSources({ CLAUDE_CONFIG_DIR: claudeHome, XDG_DATA_HOME: join(dir, 'data') }, dir)
  expect(sources).toEqual({ claude: join(claudeHome, 'projects'), opencode: join(dir, 'data', 'opencode', 'opencode.db') })
  const rewards = await backfillRewards(sources)
  // A pool post reached both sessions: as live, their checklist is the pool's.
  const fromClaude = claude(CLAUDE_SESSION)
  const fromOpenCode = openCode(OPENCODE_SESSION)
  expect(fromClaude.pool && fromOpenCode.pool).toBe(true)
  const live = [...(await workRewards(SESSION, fromClaude, true)), ...(await workRewards('ses_1', fromOpenCode, true))]
  expect(live.map(reward => reward.kind).sort()).toEqual(['day', 'day', 'push', 'push', 'turn', 'turn', 'turn', 'turn'])
  expect(rewards).toEqual(live)
  expect(await backfillRewards(sources)).toEqual(rewards)
  // Two days back, only what happened since.
  expect(await backfillRewards(sources, T0 + 3600_000 + 2 * 86_400_000, 2)).toEqual(
    rewards.filter(reward => (reward.at ?? '') >= new Date(T0 + 3600_000).toISOString()),
  )
})

test('missing or foreign history gives nothing and throws nothing', async () => {
  expect(await backfillRewards({ claude: join(dir, 'nowhere'), opencode: join(dir, 'nowhere.db') })).toEqual([])
  const foreign = join(dir, 'foreign.db')
  const db = new Database(foreign, { create: true })
  db.run('CREATE TABLE session_message (id TEXT PRIMARY KEY, data TEXT)')
  db.close()
  writeFileSync(join(dir, 'garbage.db'), 'not sqlite at all')
  expect(await backfillRewards({ claude: join(dir, 'nowhere'), opencode: foreign })).toEqual([])
  expect(await backfillRewards({ claude: join(dir, 'nowhere'), opencode: join(dir, 'garbage.db') })).toEqual([])
})

test('a backfill that could not keep every reward runs again, and one that did runs once', async () => {
  const project = join(dir, 'once', 'projects', '-work-hero')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${SESSION}.jsonl`), jsonl(CLAUDE_SESSION))
  const sources = { claude: join(dir, 'once', 'projects'), opencode: join(dir, 'none.db') }
  // No relay answers: what the backfill keeps stays pending.
  const config = { server: 'http://127.0.0.1:9', key: newAccountKey(), machineId: 'm', token: 't', machine: 'test' }
  const home = join(dir, 'once', 'agent')
  const agent = new AgentRPG(config, home)
  try {
    const folder = join(home, 'rpg', createHash('sha256').update(`${config.server}\n${config.key}`).digest('hex'))
    // A folder already full of pending rewards.
    mkdirSync(folder, { recursive: true })
    for (let i = 0; i < 10_000; i++) writeFileSync(join(folder, `full-${i}`), '')
    await expect(agent.backfill(sources)).rejects.toThrow()
    expect(existsSync(join(folder, 'backfill-v2'))).toBe(false)
    for (let i = 0; i < 10_000; i++) rmSync(join(folder, `full-${i}`))
    expect(await agent.backfill(sources)).toBe(true)
    expect(readdirSync(folder).filter(name => /^[a-f0-9]{64}$/.test(name)).length).toBeGreaterThan(0)
    expect(await agent.backfill(sources)).toBe(false)
  } finally {
    await agent.settled()
    agent.stop()
  }
}, 30_000)
