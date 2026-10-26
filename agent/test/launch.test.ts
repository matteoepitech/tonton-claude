// Starts a stand-in for claude in a tmux server of its own: never the developer's tmux, shell or claude.
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage } from '../../shared/protocol'
import type { AgentConfig } from '../src/config'
import { open, seal } from '../src/crypto'
import { fromHome, handleStartAnswer, handleStartOrder, newSession } from '../src/launch'

const dir = mkdtempSync(join(tmpdir(), 'tonton-launch-'))
const run = join(dir, 'run')
const project = join(dir, 'project')
mkdirSync(run)
mkdirSync(project)
const tmuxDir = join(dir, 'tmux')
mkdirSync(tmuxDir)
const previousTmux = process.env.TMUX_TMPDIR
process.env.TMUX_TMPDIR = tmuxDir

// Asks the two questions Claude Code asks, then links its session the way the hooks do.
const shell = join(dir, 'shell')
writeFileSync(
  shell,
  `#!/bin/sh
echo "WARNING: Loading development channels"
read answer
echo "Quick safety check: Is this a project you created or one you trust?"
read answer
echo "{\\"sessionId\\":\\"launched-1\\",\\"cwd\\":\\"$PWD\\"}" > "${run}/$$.json"
sleep 60
`,
)
chmodSync(shell, 0o755)

const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
const config = { server: 'http://x', machineId: 'm', token: 't', key, machine: 'PC' } as AgentConfig
const hasTmux = Bun.spawnSync(['tmux', '-V']).exitCode === 0

afterAll(() => {
  Bun.spawnSync(['tmux', 'kill-server'])
  if (previousTmux === undefined) delete process.env.TMUX_TMPDIR
  else process.env.TMUX_TMPDIR = previousTmux
  rmSync(dir, { recursive: true, force: true })
})

function relay() {
  const messages: Extract<AgentMessage, { t: 'session_start' }>[] = []
  return {
    messages,
    post: (build: () => Promise<AgentMessage | null>) => {
      void build().then(message => message?.t === 'session_start' && messages.push(message))
    },
  }
}

async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const order = (launchId: string, cwd: string, issuedAt = new Date().toISOString()) => seal(key, { launchId, cwd, issuedAt })
const answer = (launchId: string, step: number, confirm: boolean) =>
  seal(key, { launchId, step, confirm, issuedAt: new Date().toISOString() })
const text = async (detail: string | null) => (detail ? (await open<{ text: string }>(key, detail)).text : '')

describe.skipIf(process.platform === 'win32' || !hasTmux)('starting a session from the notch', () => {
  test('each question waits for the user, then the session it started is reported', async () => {
    const link = relay()
    void handleStartOrder(config, 'launch0001', await order('launch0001', '~/project'), link, { run, shell, home: dir })
    const channel = await until(() => link.messages.find(m => m.state === 'asking'), 'the first question')
    expect(await text(channel.detail)).toContain('load the Tonton Claude channel')
    await handleStartAnswer(config, 'launch0001', await answer('launch0001', 1, true))
    await until(() => (link.messages.filter(m => m.state === 'asking').length === 2 ? true : undefined), 'the second question')
    const trust = link.messages.filter(m => m.state === 'asking')[1]
    expect(await text(trust.detail)).toContain('trust the files in this folder')
    expect((await open<{ step: number }>(key, trust.detail ?? '')).step).toBe(2)
    // The relay replays the yes to the first question: the second still waits for its own.
    await handleStartAnswer(config, 'launch0001', await answer('launch0001', 1, true))
    await handleStartAnswer(config, 'launch0001', await answer('launch9999', 2, true))
    await Bun.sleep(1200)
    expect(link.messages.some(m => m.state === 'started')).toBe(false)
    await handleStartAnswer(config, 'launch0001', await answer('launch0001', 2, true))
    const started = await until(() => link.messages.find(m => m.state === 'started'), 'the session')
    expect(started.sessionId).toBe('launched-1')
    expect(link.messages[0].state).toBe('starting')
  }, 20_000)

  test('cancelling stops claude', async () => {
    const link = relay()
    void handleStartOrder(config, 'launch0002', await order('launch0002', project), link, { run, shell })
    await until(() => link.messages.find(m => m.state === 'asking'), 'the question')
    await handleStartAnswer(config, 'launch0002', await answer('launch0002', 1, false))
    const failed = await until(() => link.messages.find(m => m.state === 'failed'), 'the end')
    expect(await text(failed.detail)).toBe('Cancelled.')
    expect(Bun.spawnSync(['tmux', 'has-session', '-t', 'tonton-launch0002']).exitCode).not.toBe(0)
  }, 20_000)

  test('orders that are forged, expired or point nowhere are refused', async () => {
    const link = relay()
    const foreignKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    const issuedAt = new Date().toISOString()
    await handleStartOrder(config, 'launch0003', await seal(foreignKey, { launchId: 'launch0003', cwd: project, issuedAt }), link)
    await handleStartOrder(config, 'launch0004', await order('launch0004', project, '2020-01-01T00:00:00Z'), link)
    await handleStartOrder(config, 'launch0005', await order('launch0005', join(dir, 'missing')), link)
    await handleStartOrder(config, 'launch0006', await order('launch0006', 'relative/path'), link)
    // Sealed for another start: the relay cannot reuse an order under a new id.
    await handleStartOrder(config, 'launch0007', await order('launch0001', project), link)
    await until(() => (link.messages.length === 5 ? true : undefined), 'five refusals')
    expect(link.messages.every(m => m.state === 'failed')).toBe(true)
  })

  test('a replayed order starts nothing', async () => {
    const link = relay()
    const sealed = await order('launch0008', join(dir, 'missing'))
    await handleStartOrder(config, 'launch0008', sealed, link)
    await handleStartOrder(config, 'launch0008', sealed, link)
    await Bun.sleep(200)
    expect(link.messages).toHaveLength(1)
  })
})

describe('fromHome', () => {
  test('a folder typed from the home folder', () => {
    expect(fromHome('~/code/api', '/home/me')).toBe('/home/me/code/api')
    expect(fromHome('~', '/home/me')).toBe('/home/me')
    expect(fromHome('/srv/api', '/home/me')).toBe('/srv/api')
    expect(fromHome('~other/api', '/home/me')).toBe('~other/api')
  })
})

describe('newSession', () => {
  test('a link written in that folder since the start', () => {
    const links = join(dir, 'links')
    mkdirSync(links)
    const since = Date.now() - 1000
    writeFileSync(join(links, '42.json'), JSON.stringify({ sessionId: 's1', cwd: '/other' }))
    writeFileSync(join(links, 'usage-s9.json'), JSON.stringify({ sessionId: 's9', cwd: '/code/api' }))
    expect(newSession('/code/api', since, links)).toBeNull()
    writeFileSync(join(links, '43.json'), JSON.stringify({ sessionId: 's2', cwd: '/code/api/' }))
    expect(newSession('/code/api', since, links)).toBe('s2')
    expect(newSession('/code/api', Date.now() + 60_000, links)).toBeNull()
  })
})
