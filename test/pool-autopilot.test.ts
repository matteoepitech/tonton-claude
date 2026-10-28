// The pool autopilot end to end (docs/pool-autopilot.md): a real relay, an admin with two machines, each with its real
// background service, its own TONTON_HOME and a tmux server of its own, stand-ins for Claude Code that run the real channel
// (test/stand-in-claude.ts), and temporary git repositories. The admin makes one machine the orchestrator machine: its
// service starts the orchestrator session, which plans a task and starts the dispatch; the control loop hands the task to
// the other machine, whose session does it; once every task is done the loop says so and stops. Nobody moves a card.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { RelayClient, type SocketLike } from '../shared/client'
import { newAccountKey, seal } from '../shared/crypto'
import { PoolApi } from '../shared/pool-api'
import type { PoolMachineProfile } from '../shared/pool-protocol'
import { PoolWatch } from '../shared/pool-watch'
import { Vault } from '../shared/vault'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const STAND_IN = join(import.meta.dir, 'stand-in-claude.ts')
const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-autopilot-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`
const hasTmux = process.platform !== 'win32' && Bun.spawnSync(['tmux', '-V']).exitCode === 0

writeFileSync(join(dir, 'gitconfig'), '[user]\n\tname = Stand-in\n\temail = stand-in@example.com\n[init]\n\tdefaultBranch = main\n')
const shell = join(dir, 'shell')
writeFileSync(shell, `#!/bin/sh\nexec "${process.execPath}" "${STAND_IN}"\n`)
chmodSync(shell, 0o755)

interface Machine {
  name: string
  home: string
  /** Short: tmux's socket path must stay under 104 bytes on macOS. */
  tmux: string
  env: Record<string, string>
  id: string
  service?: ReturnType<typeof Bun.spawn>
}

const machines: Machine[] = []
let watch: PoolWatch
let client: RelayClient
let poolId: string
let accountId: string
const raw: string[] = []

async function eventually<T>(read: () => T | undefined | null | false, label: string, tries = 900): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${label}\n${machines.map(logs).join('\n')}`)
}

function logs(machine: Machine): string {
  const log = existsSync(join(machine.home, 'tonton.log'))
    ? readFileSync(join(machine.home, 'tonton.log'), 'utf8').split('\n').slice(-20)
    : []
  return [`== ${machine.name}`, ...log, ...standIn(machine)].join('\n')
}

/** What the stand-ins of a machine were given and did. */
function standIn(machine: Machine): string[] {
  const folder = join(machine.home, 'stand-in')
  return existsSync(folder)
    ? readdirSync(folder)
        .filter(file => file.endsWith('.log'))
        .map(file => readFileSync(join(folder, file), 'utf8'))
    : []
}

const git = (cwd: string, ...args: string[]) => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  const result = Bun.spawnSync(['git', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

const post = async (path: string, body: object, token?: string) =>
  (
    await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  ).json()

const state = () => watch.pool(poolId)?.state

beforeAll(async () => {
  if (!hasTmux) return
  const origin = join(dir, 'shop.git')
  git(dir, 'init', '--bare', '-b', 'main', origin)
  git(dir, 'clone', origin, join(dir, 'seed'))
  writeFileSync(join(dir, 'seed', 'README.md'), '# SECRET shop\n')
  git(join(dir, 'seed'), 'add', '.')
  git(join(dir, 'seed'), 'commit', '-m', 'start')
  git(join(dir, 'seed'), 'push', 'origin', 'main')

  const account = await post('/api/accounts', {})
  accountId = account.accountId
  const key = newAccountKey()
  const { secret } = await post('/api/account/token', {}, account.token)
  for (const name of ['Lead', 'Studio']) {
    const joined = await post('/api/machines/join', { account: accountId, secret, name: await seal(key, { name }) })
    const home = join(dir, name)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.json'), JSON.stringify({ server: base, ...joined, key, machine: name, version: '0.9.0' }))
    const tmux = mkdtempSync(join(tmpdir(), 'tta-'))
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TONTON_HOME: home,
      TONTON_SERVICE: 'off',
      TMUX_TMPDIR: tmux,
      SHELL: shell,
      GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    }
    // Inside a tmux session, tmux would talk to the developer's server whatever TMUX_TMPDIR says.
    delete env.TMUX
    const machine: Machine = { name, home, tmux, env, id: joined.machineId }
    machine.service = Bun.spawn(['bun', AGENT, 'service'], { env, stdout: 'ignore', stderr: 'ignore' })
    machines.push(machine)
  }

  const api = new PoolApi({ relay: base, token: account.token })
  const created = await api.create(key, accountId, { name: 'SECRET hackathon', repo: origin }, { name: 'Ana' })
  poolId = created.pool.id
  client = new RelayClient({
    vault: new Vault(key),
    connect: () => {
      const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/app`, ['tonton', `bearer.${account.token}`])
      socket.addEventListener('message', event => raw.push(String(event.data)))
      return socket as unknown as SocketLike
    },
    onChange: () => {},
    onPoolUpdate: update => void watch.handle(update),
  })
  watch = new PoolWatch({ api, accountKey: key, account: accountId, relay: base, link: client, onChange: () => {} })
  client.start()
  await eventually(() => client.state.connection === 'connected', 'the app')
  await watch.refresh()
  watch.open(poolId)
  await eventually(() => state(), 'the pool')
}, 60_000)

afterAll(() => {
  client?.stop()
  for (const machine of machines) {
    machine.service?.kill()
    Bun.spawnSync(['tmux', 'kill-server'], { env: machine.env })
    rmSync(machine.tmux, { recursive: true, force: true })
  }
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!hasTmux)('the pool autopilot', () => {
  test('the admin puts two machines in the pool and makes one the orchestrator machine', async () => {
    const [lead, studio] = machines
    // The lead takes simple tasks only: the large one the orchestrator plans goes to the studio.
    const leadProfile: PoolMachineProfile = {
      name: 'Lead',
      tool: 'claude',
      capacity: 1,
      workdir: join(dir, 'lead-work'),
      mode: 'full',
      takes: 'simple',
    }
    const studioProfile: PoolMachineProfile = {
      name: 'Studio',
      tool: 'claude',
      capacity: 1,
      workdir: join(dir, 'studio-work'),
      mode: 'edits',
    }
    expect(await watch.addMachine(poolId, lead.id, leadProfile)).toBe(true)
    expect(await watch.addMachine(poolId, studio.id, studioProfile)).toBe(true)
    await eventually(() => state()?.machines?.length === 2 && state()?.machines?.every(m => m.ready), 'both machines ready')
    expect(watch.setOrchestratorMachine(poolId, { account: accountId, machine: lead.id })).toBe(true)
    // Its service starts the orchestrator session in its clone of the repository, and the relay makes it the orchestrator.
    const orchestrator = await eventually(() => state()?.orchestrator, 'the orchestrator session')
    expect(state()?.sessions.find(s => s.session === orchestrator.session)?.machine).toBe(lead.id)
    expect(existsSync(join(dir, 'lead-work', 'repo', 'README.md'))).toBe(true)
  }, 120_000)

  test('the orchestrator plans and starts the dispatch; the loop hands the task to the studio, whose session does it', async () => {
    const [lead, studio] = machines
    const done = await eventually(() => state()?.tasks.find(t => t.task?.state === 'done'), 'the task done')
    expect(done.task?.title).toBe('SECRET landing page')
    expect(done.task?.machine).toEqual({ account: accountId, machine: studio.id })
    expect(standIn(lead).join('\n')).toContain('runs on autopilot')
    expect(standIn(studio).join('\n')).toContain(`task="${done.id}"`)
    // What the loop did is in the pool, as the orchestrator machine's events, and in the orchestrator's conversation.
    const loopEvents =
      state()
        ?.events.filter(e => e.machine === lead.id)
        .map(e => e.body?.kind) ?? []
    expect(loopEvents).toContain('dispatched')
    await eventually(() => standIn(lead).join('\n').includes('Dispatched'), 'the notice at the orchestrator')
  }, 120_000)

  test('once every task is done, the loop says so and stops the dispatch', async () => {
    const [lead] = machines
    await eventually(() => state()?.dispatch?.value?.on === false && state(), 'the dispatch stopped')
    const finished = await eventually(() => state()?.events.find(e => e.body?.kind === 'dispatch_done'), 'the loop saying so')
    expect(finished).toMatchObject({ machine: lead.id })
    expect(finished?.body?.text).toContain('Every task is done')
    await eventually(() => standIn(lead).join('\n').includes('Every task is done'), 'the last notice at the orchestrator')
  }, 60_000)

  test('the relay saw none of it', () => {
    const traffic = raw.join('')
    for (const secret of ['SECRET', 'shop.git', 'lead-work', 'landing page', 'Dispatched', 'pool/']) expect(traffic).not.toContain(secret)
  })
})
