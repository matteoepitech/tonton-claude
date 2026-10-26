// Starts a stand-in for claude in a tmux server of its own: never the developer's tmux, shell or claude.
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open, seal } from '../../shared/crypto'
import type { AgentMessage, StartDetail } from '../../shared/protocol'
import type { AgentConfig } from '../src/config'
import {
  claim,
  descendsFrom,
  fromHome,
  handleStartAnswer,
  handleStartOrder,
  newSession,
  openCodeMajor,
  readOpenCodeService,
} from '../src/launch'

const dir = mkdtempSync(join(tmpdir(), 'tonton-launch-'))
const run = join(dir, 'run')
const project = join(dir, 'project')
mkdirSync(run)
mkdirSync(project)
const tmuxDir = join(dir, 'tmux')
mkdirSync(tmuxDir)
// Inside a tmux session, tmux would talk to the developer's server whatever TMUX_TMPDIR says.
const previous = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX }
process.env.TMUX_TMPDIR = tmuxDir
delete process.env.TMUX
// Bun gives children the environment it started with, not these changes: every tmux the test runs gets them by hand,
// or it would work in, and stop, the developer's own tmux server.
const tmuxEnv = () => ({ ...process.env })

// Asks the two questions Claude Code asks, then links its session the way the hooks do, named after its process.
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
  Bun.spawnSync(['tmux', 'kill-server'], { env: tmuxEnv() })
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

type Report = Extract<AgentMessage, { t: 'session_start' }> & { opened: StartDetail }

function relay() {
  const messages: Report[] = []
  return {
    messages,
    post: (build: () => Promise<AgentMessage | null>) => {
      void build().then(async message => {
        if (message?.t === 'session_start') messages.push({ ...message, opened: await open<StartDetail>(key, message.detail) })
      })
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

const now = () => new Date().toISOString()
const order = (launchId: string, cwd: string, { issuedAt = now(), machineId = 'm' } = {}) =>
  seal(key, { launchId, machineId, cwd, issuedAt })
const answer = (launchId: string, question: string | undefined, confirm: boolean, machineId = 'm') =>
  seal(key, { launchId, machineId, question, confirm, issuedAt: now() })
const questions = (link: ReturnType<typeof relay>) => link.messages.filter(m => m.state === 'asking')

describe.skipIf(process.platform === 'win32' || !hasTmux)('starting a session from the notch', () => {
  test('each question waits for its own answer, then the session it started is reported', async () => {
    const link = relay()
    void handleStartOrder(config, 'launch0001', await order('launch0001', '~/project'), link, { run, shell, home: dir })
    const channel = await until(() => questions(link)[0], 'the first question')
    expect(channel.opened).toMatchObject({ launchId: 'launch0001', machineId: 'm', state: 'asking' })
    expect(channel.opened.text).toContain('load the Tonton Claude channel')
    await handleStartAnswer(config, 'launch0001', await answer('launch0001', channel.opened.question, true))
    const trust = await until(() => questions(link)[1], 'the second question')
    expect(trust.opened.text).toContain('trust the files in this folder')
    expect(trust.opened.question).not.toBe(channel.opened.question)
    // The relay replays the yes to the first question, or one sealed for another start or machine: none answers this one.
    await handleStartAnswer(config, 'launch0001', await answer('launch0001', channel.opened.question, true))
    await handleStartAnswer(config, 'launch0001', await answer('launch9999', trust.opened.question, true))
    await handleStartAnswer(config, 'launch0001', await answer('launch0001', trust.opened.question, true, 'other'))
    // Nor does a junk order with the id of this start fail it.
    await handleStartOrder(config, 'launch0001', 'junk', link, { run })
    await Bun.sleep(1200)
    expect(link.messages.some(m => m.state !== 'asking' && m.state !== 'starting')).toBe(false)
    await handleStartAnswer(config, 'launch0001', await answer('launch0001', trust.opened.question, true))
    const started = await until(() => link.messages.find(m => m.state === 'started'), 'the session')
    expect(started.opened).toMatchObject({ launchId: 'launch0001', state: 'started', sessionId: 'launched-1' })
    expect(link.messages[0].state).toBe('starting')
    // In the test's own tmux server, never the developer's.
    expect(Bun.spawnSync(['tmux', 'has-session', '-t', '=tonton-launch0001'], { env: tmuxEnv() }).exitCode).toBe(0)
  }, 20_000)

  test('a folder with # in its name is the one claude starts in', async () => {
    const odd = join(dir, 'odd#S##x')
    mkdirSync(odd)
    const link = relay()
    void handleStartOrder(config, 'launch0010', await order('launch0010', odd), link, { run, shell })
    for (const index of [0, 1]) {
      const asked = await until(() => questions(link)[index], `question ${index + 1}`)
      await handleStartAnswer(config, 'launch0010', await answer('launch0010', asked.opened.question, true))
    }
    const started = await until(() => link.messages.find(m => m.state === 'started'), 'the session')
    expect(started.opened.sessionId).toBe('launched-1')
  }, 20_000)

  test('cancelling stops claude', async () => {
    const link = relay()
    void handleStartOrder(config, 'launch0002', await order('launch0002', project), link, { run, shell })
    const asked = await until(() => questions(link)[0], 'the question')
    await handleStartAnswer(config, 'launch0002', await answer('launch0002', asked.opened.question, false))
    const failed = await until(() => link.messages.find(m => m.state === 'failed'), 'the end')
    expect(failed.opened.text).toBe('Cancelled.')
    expect(Bun.spawnSync(['tmux', 'has-session', '-t', '=tonton-launch0002'], { env: tmuxEnv() }).exitCode).not.toBe(0)
  }, 20_000)

  test('orders that are forged, expired, for another start or machine, or point nowhere are refused', async () => {
    const link = relay()
    const foreignKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    await handleStartOrder(
      config,
      'launch0003',
      await seal(foreignKey, { launchId: 'launch0003', machineId: 'm', cwd: project, issuedAt: now() }),
      link,
      { run },
    )
    await handleStartOrder(config, 'launch0004', await order('launch0004', project, { issuedAt: '2020-01-01T00:00:00Z' }), link, { run })
    await handleStartOrder(config, 'launch0005', await order('launch0005', join(dir, 'missing')), link, { run })
    await handleStartOrder(config, 'launch0006', await order('launch0006', 'relative/path'), link, { run })
    // The relay can't reuse an order under a new id, nor send it to another machine of the account.
    await handleStartOrder(config, 'launch0007', await order('launch0012', project), link, { run })
    await handleStartOrder(config, 'launch0011', await order('launch0011', project, { machineId: 'other' }), link, { run })
    await until(() => (link.messages.length === 6 ? true : undefined), 'six refusals')
    expect(link.messages.every(m => m.state === 'failed')).toBe(true)
    // An id tmux could misread gets no answer at all.
    await handleStartOrder(config, 'Launch#S1', await order('Launch#S1', project), link, { run })
    await Bun.sleep(200)
    expect(link.messages).toHaveLength(6)
  })

  test('a start runs once on the machine, whichever process gets it', async () => {
    const link = relay()
    const sealed = await order('launch0008', join(dir, 'missing'))
    await handleStartOrder(config, 'launch0008', sealed, link, { run })
    await handleStartOrder(config, 'launch0008', sealed, link, { run })
    // Another process of the machine already took this one.
    expect(claim('launch0009', run)).toBe('claimed')
    await handleStartOrder(config, 'launch0009', await order('launch0009', join(dir, 'missing')), link, { run })
    await Bun.sleep(200)
    expect(link.messages).toHaveLength(1)
  })
})

describe('claim', () => {
  test('old claims are cleared', () => {
    const folder = join(dir, 'claims')
    expect(claim('claim0001', folder)).toBe('claimed')
    expect(claim('claim0001', folder)).toBe('taken')
    expect(claim('claim0002', folder, Date.now() + 30 * 60_000)).toBe('claimed')
    expect(claim('claim0001', folder)).toBe('claimed')
    // A folder that can't hold claims is an error to report, not a start someone else took.
    writeFileSync(join(dir, 'not-a-folder'), '')
    expect(claim('claim0003', join(dir, 'not-a-folder'))).toBeInstanceOf(Error)
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
  test('a link written in that folder since the start, by a claude of the start', () => {
    const links = join(dir, 'links')
    mkdirSync(links)
    const since = Date.now() - 1000
    writeFileSync(join(links, '42.json'), JSON.stringify({ sessionId: 's1', cwd: '/other' }))
    writeFileSync(join(links, 'usage-s9.json'), JSON.stringify({ sessionId: 's9', cwd: '/code/api' }))
    expect(newSession('/code/api', since, links)).toBeNull()
    writeFileSync(join(links, '43.json'), JSON.stringify({ sessionId: 's2', cwd: '/code/api/' }))
    expect(newSession('/code/api', since, links)).toBe('s2')
    expect(newSession('/code/api', Date.now() + 60_000, links)).toBeNull()
    // Another claude already running in the folder.
    expect(newSession('/code/api', since, links, pid => pid !== 43)).toBeNull()
  })

  test.skipIf(process.platform === 'win32')('a process runs under its ancestors only', () => {
    expect(descendsFrom(process.pid, process.pid)).toBe(true)
    expect(descendsFrom(process.pid, process.ppid)).toBe(true)
    expect(descendsFrom(process.ppid, process.pid)).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32' || !hasTmux)('starting OpenCode from the notch', () => {
  // Stands in for the login shell: records the command tmux gave it, then stays up like a terminal app.
  const opencodeShell = join(dir, 'opencode-shell')
  const ran = join(dir, 'opencode-ran.txt')
  writeFileSync(opencodeShell, `#!/bin/sh\necho "$@" > "${ran}"\nsleep 60\n`)
  chmodSync(opencodeShell, 0o755)
  const openCodeOrder = (launchId: string) => seal(key, { launchId, machineId: 'm', cwd: project, issuedAt: now(), tool: 'opencode' })

  test('with OpenCode 2, the session is made in its service, then a terminal opens on it', async () => {
    const requests: { auth: string | null; body: unknown }[] = []
    const service = Bun.serve({
      port: 0,
      fetch: async req => {
        requests.push({ auth: req.headers.get('authorization'), body: await req.json() })
        return Response.json({ data: { id: 'ses_e86e706f9ffe3cggju' } })
      },
    })
    try {
      const link = relay()
      const openCode = { version: () => 2, service: () => ({ url: `http://127.0.0.1:${service.port}`, password: 'pw' }) }
      await handleStartOrder(config, 'launch0100', await openCodeOrder('launch0100'), link, { run, shell: opencodeShell, openCode })
      const started = await until(() => link.messages.find(m => m.state === 'started'), 'the session')
      expect(started.opened).toMatchObject({ state: 'started', sessionId: 'ses_e86e706f9ffe3cggju' })
      expect(requests).toEqual([{ auth: `Basic ${btoa('opencode:pw')}`, body: { location: { directory: project } } }])
      expect(readFileSync(ran, 'utf8').trim()).toBe('-lic opencode --session ses_e86e706f9ffe3cggju')
    } finally {
      service.stop(true)
    }
  }, 20_000)

  test('with OpenCode 1, the terminal starts it and the session comes with the first message', async () => {
    const link = relay()
    const openCode = { version: () => 1, service: () => null }
    await handleStartOrder(config, 'launch0101', await openCodeOrder('launch0101'), link, { run, shell: opencodeShell, openCode })
    const started = await until(() => link.messages.find(m => m.state === 'started'), 'the start')
    expect(started.opened.sessionId).toBeUndefined()
    expect(started.opened.text).toContain('with its first message')
    expect(readFileSync(ran, 'utf8').trim()).toBe('-lic opencode')
  }, 20_000)

  test('without opencode, or without a session from its service, the start fails and says why', async () => {
    for (const [launchId, openCode, why] of [
      ['launch0102', { version: () => null, service: () => null }, 'not found'],
      ['launch0103', { version: () => 2, service: () => null }, 'did not make the session'],
    ] as const) {
      const link = relay()
      await handleStartOrder(config, launchId, await openCodeOrder(launchId), link, { run, shell: opencodeShell, openCode })
      const failed = await until(() => link.messages.find(m => m.state === 'failed'), 'the failure')
      expect(failed.opened.text).toContain(why)
    }
  })
})

describe('OpenCode service', () => {
  test('its address and password come from its state file', () => {
    const state = join(dir, 'state', 'opencode')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'service.json'), JSON.stringify({ id: 'x', url: 'http://127.0.0.1:49374', pid: 1, password: 'secret' }))
    expect(readOpenCodeService({ XDG_STATE_HOME: join(dir, 'state') })).toEqual({ url: 'http://127.0.0.1:49374', password: 'secret' })
    expect(readOpenCodeService({ XDG_STATE_HOME: join(dir, 'nowhere') })).toBeNull()
    expect(openCodeMajor('opencode v2.0.32')).toBe(2)
    expect(openCodeMajor('1.17.5')).toBe(1)
    expect(openCodeMajor('command not found')).toBeNull()
  })
})
