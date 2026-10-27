// Checks and repairs of a machine's setup, on a home of their own: never the developer's Claude Code, shell profiles,
// login items or claude CLI.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open, seal } from '../../shared/crypto'
import type { AgentMessage, Diagnosis, SetupCheck, SetupFix } from '../../shared/protocol'
import type { AgentConfig } from '../src/config'
import { handleDiagnoseRequest, type MachineAccess } from '../src/diagnose'
import { HOOK_EVENTS } from '../src/install/claude-settings'
import type { Setup } from '../src/install/setup'
import { PLUGIN_FILE } from '../src/opencode/plugin'

const dir = mkdtempSync(join(tmpdir(), 'tonton-diagnose-'))
const newKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
const key = newKey()
const config = { server: 'https://relay.example.com', machineId: 'machine00001', token: 'tm_x', key, machine: 'PC' } as AgentConfig
// Repairs are claimed with files, whose times are the clock's.
const now = Date.now()

afterAll(() => rmSync(dir, { recursive: true, force: true }))

let setup: Setup
let access: MachineAccess & { calls: string[]; pid: number | null; version: string | null; autostart: boolean; status: number | null }
let requests = 0

beforeEach(() => {
  const home = join(dir, `home-${++requests}`)
  mkdirSync(home, { recursive: true })
  setup = {
    binary: join(home, '.tonton', 'bin', 'tonton'),
    home,
    claudeSettings: join(home, '.claude', 'settings.json'),
    claudeState: join(home, '.claude.json'),
    launcherSettings: join(home, '.tonton', 'claude-settings.json'),
    run: join(home, '.tonton', 'run'),
    profiles: [{ file: join(home, '.zshrc'), shell: 'posix' }],
    openCode: join(home, '.config', 'opencode'),
  }
  const calls: string[] = []
  access = {
    calls,
    pid: 4242,
    version: null,
    autostart: true,
    status: 200,
    service() {
      return { pid: this.pid, version: this.version, autostart: this.autostart, disabled: false }
    },
    async ping() {
      return this.status === null ? { status: null, ms: 0, error: 'Unable to connect' } : { status: this.status, ms: 42 }
    },
    addMcpServer: binary => {
      calls.push(`mcp ${binary}`)
      writeFileSync(setup.claudeState, JSON.stringify({ mcpServers: { tonton: { command: binary, args: ['channel'] } } }))
      return true
    },
    registerAutostart: () => {
      calls.push('autostart')
      return true
    },
    restartService: ({ reload }) => {
      calls.push(reload ? 'restart and reload' : 'restart')
    },
  }
})

async function ask(fields: { fix?: SetupFix | string; machineId?: string; requestId?: string; issuedAt?: string } = {}, sealWith = key) {
  const requestId = `request${String(requests).padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`
  const messages: AgentMessage[] = []
  const relay = {
    post: (build: () => Promise<AgentMessage | null>) => void build().then(m => m && messages.push(m)),
    flushed: async () => {},
  }
  const request = { requestId, machineId: config.machineId, issuedAt: new Date(now).toISOString(), ...fields }
  const sealed = await seal(sealWith, request)
  await handleDiagnoseRequest(config, requestId, sealed, relay, { role: 'channel', setup, access, now })
  await Bun.sleep(10)
  const answer = messages[0]
  if (!answer) return null
  if (answer.t !== 'diagnosis') throw new Error('unexpected message')
  const diagnosis = await open<Diagnosis>(key, answer.diagnosis)
  expect(diagnosis).toMatchObject({ requestId: request.requestId, machineId: config.machineId })
  return { diagnosis, again: () => handleDiagnoseRequest(config, requestId, sealed, relay, { role: 'channel', setup, access, now }) }
}

const check = (diagnosis: Diagnosis | undefined, id: string): SetupCheck | undefined => diagnosis?.checks.find(c => c.id === id)

describe('a machine where nothing is installed', () => {
  test('every part of the install step is missing, each with its repair', async () => {
    const result = await ask()
    const diagnosis = result?.diagnosis
    expect(check(diagnosis, 'agent')).toMatchObject({ ok: true })
    expect(check(diagnosis, 'relay')).toEqual({ id: 'relay', label: 'Relay', ok: true, detail: 'relay.example.com answers in 42 ms.' })
    for (const id of ['hooks', 'mcp', 'launcher', 'statusline']) expect(check(diagnosis, id)).toMatchObject({ ok: false, fix: id })
    expect(check(diagnosis, 'mcp')?.detail).toBe('Claude Code has not run on this machine yet.')
  })

  test('each repair makes its check pass, and only touches files of the home it was given', async () => {
    for (const fix of ['hooks', 'launcher', 'statusline', 'mcp'] as const) {
      const diagnosis = (await ask({ fix }))?.diagnosis
      expect(diagnosis?.fixed).toMatchObject({ fix, ok: true })
      expect(check(diagnosis, fix)).toMatchObject({ ok: true })
    }
    const settings = JSON.parse(readFileSync(setup.claudeSettings, 'utf8'))
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort())
    expect(readFileSync(join(setup.home, '.zshrc'), 'utf8')).toContain('# >>> tonton >>>')
    expect(JSON.parse(readFileSync(setup.launcherSettings, 'utf8')).statusLine.command).toContain(setup.binary)
    expect(access.calls).toEqual([`mcp ${setup.binary}`])
  })

  test('the OpenCode plugin is checked once OpenCode is there', async () => {
    mkdirSync(setup.openCode, { recursive: true })
    expect(check((await ask())?.diagnosis, 'opencode')).toMatchObject({ ok: false, fix: 'opencode' })
    const diagnosis = (await ask({ fix: 'opencode' }))?.diagnosis
    expect(check(diagnosis, 'opencode')).toMatchObject({ ok: true })
    expect(readFileSync(join(setup.openCode, 'plugins', PLUGIN_FILE), 'utf8')).toContain(setup.binary)
  })
})

describe('what must not be repaired from afar', () => {
  test('settings that are not valid JSON are left alone', async () => {
    mkdirSync(join(setup.home, '.claude'), { recursive: true })
    writeFileSync(setup.claudeSettings, '{ "model": "opus", ')
    const diagnosis = (await ask({ fix: 'hooks' }))?.diagnosis
    expect(diagnosis?.fixed).toEqual({ fix: 'hooks', ok: false, text: `${setup.claudeSettings} is not valid JSON: fix it by hand first.` })
    expect(check(diagnosis, 'hooks')).toMatchObject({ ok: false })
    expect(check(diagnosis, 'hooks')).not.toHaveProperty('fix')
    expect(readFileSync(setup.claudeSettings, 'utf8')).toBe('{ "model": "opus", ')
  })

  test('hooks the user turned off stay off', async () => {
    mkdirSync(join(setup.home, '.claude'), { recursive: true })
    writeFileSync(setup.claudeSettings, JSON.stringify({ disableAllHooks: true }))
    const hooks = check((await ask())?.diagnosis, 'hooks')
    expect(hooks).toMatchObject({ ok: false, detail: `Hooks are turned off: disableAllHooks is set in ${setup.claudeSettings}.` })
    expect(hooks).not.toHaveProperty('fix')
  })

  test('a repair this agent does not know is refused', async () => {
    // From a newer app: the agent reads whatever it was sent.
    const fixed: unknown = (await ask({ fix: 'everything' }))?.diagnosis.fixed
    expect(fixed).toEqual({ fix: 'everything', ok: false, text: 'This agent does not know that repair. Update it first.' })
  })
})

describe('the background service', () => {
  test('stopped, it is started, and the checks wait for it', async () => {
    access.pid = null
    expect(check((await ask())?.diagnosis, 'service')).toMatchObject({ ok: false, fix: 'service' })
    const started = ask({ fix: 'service' })
    await Bun.sleep(300)
    access.pid = 5151
    const diagnosis = (await started)?.diagnosis
    expect(access.calls).toEqual(['autostart', 'restart and reload'])
    expect(diagnosis?.fixed?.ok).toBe(true)
    expect(check(diagnosis, 'service')).toMatchObject({ ok: true, detail: 'Running, and starts at login.' })
  })

  test('running an older agent, or not starting at login, it says so', async () => {
    access.version = '0.1.0'
    expect(check((await ask())?.diagnosis, 'service')?.detail).toMatch(/^Runs 0\.1\.0, though .* is installed\.$/)
    access.version = null
    access.autostart = false
    expect(check((await ask())?.diagnosis, 'service')).toMatchObject({ ok: false, detail: 'Running, but it does not start at login.' })
    // Registered at login, not restarted: it already runs the installed agent.
    await ask({ fix: 'service' })
    expect(access.calls).toEqual(['autostart'])
  })
})

test('the relay refusing the machine, or out of reach', async () => {
  access.status = 401
  expect(check((await ask())?.diagnosis, 'relay')?.detail).toStartWith("relay.example.com refused this machine's credential.")
  access.status = null
  expect(check((await ask())?.diagnosis, 'relay')?.detail).toBe(
    "relay.example.com is not reachable over HTTP: Unable to connect. Hooks can't report the state of sessions.",
  )
})

test('the status line says when a session last reported', async () => {
  await ask({ fix: 'statusline' })
  mkdirSync(setup.run, { recursive: true })
  writeFileSync(join(setup.run, 'usage-abc.json'), '{}')
  expect(check((await ask())?.diagnosis, 'statusline')?.detail).toBe('Last reading from a session less than a minute ago.')
})

describe('requests', () => {
  test('sealed with another key, for another machine or relabelled: no answer', async () => {
    expect(await ask({}, newKey())).toBeNull()
    expect(await ask({ machineId: 'machine00002' })).toBeNull()
    expect(await ask({ requestId: 'request9999' })).toBeNull()
  })

  test('an old one gets a reason, and repairs nothing', async () => {
    const diagnosis = (await ask({ fix: 'hooks', issuedAt: new Date(now - 11 * 60_000).toISOString() }))?.diagnosis
    expect(diagnosis).toMatchObject({ checks: [], error: 'The request expired. Check the clock of this machine.' })
    expect(() => readFileSync(setup.claudeSettings)).toThrow()
  })

  test('a repair runs once, though the relay hands it again', async () => {
    const first = await ask({ fix: 'service' })
    access.pid = null
    expect(await first?.again()).toBeNull()
    expect(access.calls).toEqual(['autostart'])
  })
})
