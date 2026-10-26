// Starts a stand-in for claude in a tmux server of its own: never the developer's tmux, shell or claude.
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage } from '../../shared/protocol'
import type { AgentConfig } from '../src/config'
import { open, seal } from '../src/crypto'
import { handleStartAnswer, handleStartOrder, newSession } from '../src/launch'

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

const order = (cwd: string, issuedAt = new Date().toISOString()) => seal(key, { cwd, issuedAt })
const answer = (confirm: boolean) => seal(key, { confirm, issuedAt: new Date().toISOString() })
const text = async (detail: string | null) => (detail ? (await open<{ text: string }>(key, detail)).text : '')

describe.skipIf(process.platform === 'win32' || !hasTmux)('starting a session from the notch', () => {
  test('each question waits for the user, then the session it started is reported', async () => {
    const link = relay()
    void handleStartOrder(config, 'launch0001', await order(project), link, { run, shell })
    const channel = await until(() => link.messages.find(m => m.state === 'asking'), 'the first question')
    expect(await text(channel.detail)).toContain('load the Tonton Claude channel')
    await handleStartAnswer(config, 'launch0001', await answer(true))
    await until(() => (link.messages.filter(m => m.state === 'asking').length === 2 ? true : undefined), 'the second question')
    expect(await text(link.messages.filter(m => m.state === 'asking')[1].detail)).toContain('trust the files in this folder')
    await handleStartAnswer(config, 'launch0001', await answer(true))
    const started = await until(() => link.messages.find(m => m.state === 'started'), 'the session')
    expect(started.sessionId).toBe('launched-1')
    expect(link.messages[0].state).toBe('starting')
  }, 20_000)

  test('cancelling stops claude', async () => {
    const link = relay()
    void handleStartOrder(config, 'launch0002', await order(project), link, { run, shell })
    await until(() => link.messages.find(m => m.state === 'asking'), 'the question')
    await handleStartAnswer(config, 'launch0002', await answer(false))
    const failed = await until(() => link.messages.find(m => m.state === 'failed'), 'the end')
    expect(await text(failed.detail)).toBe('Cancelled.')
    expect(Bun.spawnSync(['tmux', 'has-session', '-t', 'tonton-launch0002']).exitCode).not.toBe(0)
  }, 20_000)

  test('orders that are forged, expired or point nowhere are refused', async () => {
    const link = relay()
    const foreignKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    await handleStartOrder(config, 'launch0003', await seal(foreignKey, { cwd: project, issuedAt: new Date().toISOString() }), link)
    await handleStartOrder(config, 'launch0004', await order(project, '2020-01-01T00:00:00Z'), link)
    await handleStartOrder(config, 'launch0005', await order(join(dir, 'missing')), link)
    await handleStartOrder(config, 'launch0006', await order('relative/path'), link)
    await until(() => (link.messages.length === 4 ? true : undefined), 'four refusals')
    expect(link.messages.every(m => m.state === 'failed')).toBe(true)
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
