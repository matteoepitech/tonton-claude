// Pool workers end to end (docs/pool-autopilot.md): a real relay, the real background service of a machine with its own
// TONTON_HOME, a tmux server of its own (never the developer's), a stand-in for Claude Code that runs the real channel
// (test/stand-in-claude.ts), and temporary git repositories. The owner puts the machine in the pool and dispatches tasks
// to it from the website's client core: the machine clones the repository, makes a worktree per task, starts a session
// there that gets the task as its first message, ends it on task_done, and puts back a task whose session crashed. A
// second machine runs OpenCode: a stand-in for its service makes the session, and the real bridge hands it the task.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginCommand } from '../agent/src/opencode/bridge'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { RelayClient, type SocketLike } from '../shared/client'
import { newAccountKey, seal } from '../shared/crypto'
import { PoolApi } from '../shared/pool-api'
import type { PoolTask } from '../shared/pool-protocol'
import { PoolWatch } from '../shared/pool-watch'
import { Vault } from '../shared/vault'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const STAND_IN = join(import.meta.dir, 'stand-in-claude.ts')
const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-workers-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`
const home = join(dir, 'agent')
// tmux's socket path must stay short: macOS takes 104 bytes at most.
const tmuxDir = mkdtempSync(join(tmpdir(), 'ttw-'))
const workdir = join(dir, 'work')
const hasTmux = process.platform !== 'win32' && Bun.spawnSync(['tmux', '-V']).exitCode === 0

// Git reads an empty config of its own, not the developer's (signing, hooks).
writeFileSync(join(dir, 'gitconfig'), '[user]\n\tname = Stand-in\n\temail = stand-in@example.com\n[init]\n\tdefaultBranch = main\n')
// The login shell tmux runs claude with: here, the stand-in.
const shell = join(dir, 'shell')
// The shell's arguments (`-lic 'claude --model sonnet'`) go to the stand-in, which takes its model from them.
writeFileSync(shell, `#!/bin/sh\nexec "${process.execPath}" "${STAND_IN}" "$@"\n`)
chmodSync(shell, 0o755)
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  TONTON_HOME: home,
  TONTON_SERVICE: 'off',
  TMUX_TMPDIR: tmuxDir,
  SHELL: shell,
  GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
}
// Inside a tmux session, tmux would talk to the developer's server whatever TMUX_TMPDIR says.
delete env.TMUX

// The OpenCode machine: its home, its login shell answering for opencode, and where OpenCode 2 says its service listens.
const openHome = join(dir, 'opencode-agent')
const openState = join(dir, 'state')
const openShell = join(dir, 'opencode-shell')
writeFileSync(
  openShell,
  `#!/bin/sh\ncase "$2" in\n  "opencode --version") echo "opencode v2.0.32" ;;\n  "opencode service start") ;;\n  *) exec sleep 600 ;;\nesac\n`,
)
chmodSync(openShell, 0o755)
const openEnv: Record<string, string> = { ...env, TONTON_HOME: openHome, SHELL: openShell, XDG_STATE_HOME: openState }

let service: ReturnType<typeof Bun.spawn>
let openService: ReturnType<typeof Bun.spawn>
let bridge: ReturnType<typeof Bun.spawn>
let openCode: ReturnType<typeof Bun.serve>
const commands: PluginCommand[] = []
let openMachineId: string
let watch: PoolWatch
let client: RelayClient
let poolId: string
let accountId: string
let machineId: string
const raw: string[] = []

async function eventually<T>(read: () => T | undefined | null | false, label: string, tries = 600): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${label}\n${logs()}`)
}

const logs = () => {
  const log = existsSync(join(home, 'tonton.log')) ? readFileSync(join(home, 'tonton.log'), 'utf8').split('\n').slice(-25).join('\n') : ''
  const folder = join(home, 'stand-in')
  const stand = existsSync(folder)
    ? readdirSync(folder)
        .filter(file => file.endsWith('.log'))
        .map(file => readFileSync(join(folder, file), 'utf8'))
        .join('\n')
    : ''
  return `${log}\n${stand}`
}

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}
const tmux = (...args: string[]) => Bun.spawnSync(['tmux', ...args], { env, stdout: 'pipe', stderr: 'pipe' })

const post = async (path: string, body: object, token?: string) =>
  (
    await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  ).json()

const state = () => watch.pool(poolId)?.state
const taskOf = (id: string) => state()?.tasks.find(item => item.id === id)?.task

async function dispatch(title: string, machine = machineId): Promise<string> {
  const task: PoolTask = { title, state: 'assigned', criteria: ['a file says it is done'], machine: { account: accountId, machine } }
  const id = await watch.saveTask(poolId, null, task)
  if (!id) throw new Error('no task')
  return id
}

beforeAll(async () => {
  if (!hasTmux) return
  // The pool's repository: a bare origin with one commit on main.
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
  const machine = await post('/api/machines/join', { account: accountId, secret, name: await seal(key, { name: 'Studio' }) })
  machineId = machine.machineId
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: base, ...machine, key, machine: 'Studio', version: '0.9.0' }))
  service = Bun.spawn(['bun', AGENT, 'service'], { env, stdout: 'ignore', stderr: 'ignore' })

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
  const added = await watch.addMachine(poolId, machineId, { name: 'Studio', tool: 'claude', capacity: 2, workdir, mode: 'edits' })
  expect(added).toBe(true)
  await eventually(() => state()?.machines?.[0]?.ready, 'the machine ready')

  // The OpenCode machine, with its bridge as OpenCode's plugin runs it, and a stand-in for OpenCode 2's service.
  openCode = Bun.serve({ port: 0, fetch: () => Response.json({ data: { id: `ses_${crypto.randomUUID().replaceAll('-', '')}` } }) })
  mkdirSync(join(openState, 'opencode'), { recursive: true })
  writeFileSync(join(openState, 'opencode', 'service.json'), JSON.stringify({ url: `http://127.0.0.1:${openCode.port}`, password: 'pw' }))
  const second = await post('/api/machines/join', { account: accountId, secret, name: await seal(key, { name: 'Linux' }) })
  openMachineId = second.machineId
  mkdirSync(openHome, { recursive: true })
  writeFileSync(join(openHome, 'config.json'), JSON.stringify({ server: base, ...second, key, machine: 'Linux', version: '0.9.0' }))
  openService = Bun.spawn(['bun', AGENT, 'service'], { env: openEnv, stdout: 'ignore', stderr: 'ignore' })
  bridge = Bun.spawn(['bun', AGENT, 'opencode'], { env: openEnv, stdin: 'pipe', stdout: 'pipe' })
  void (async () => {
    let buffer = ''
    for await (const chunk of bridge.stdout as ReadableStream<Uint8Array>) {
      buffer += new TextDecoder().decode(chunk)
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        commands.push(JSON.parse(buffer.slice(0, newline)))
        buffer = buffer.slice(newline + 1)
      }
    }
  })()
  // What OpenCode's plugin answers the bridge's `models`: the catalog a pool session's model is chosen from.
  const models = [
    { providerID: 'anthropic', modelID: 'claude-haiku-4-5', released: 1_760_000_000_000 },
    { providerID: 'anthropic', modelID: 'claude-sonnet-5-5', released: 1_790_000_000_000 },
  ]
  bridge.stdin.write(`${JSON.stringify({ type: 'tonton.models', data: { models } })}\n`)
  bridge.stdin.flush()
  const openWorkdir = join(dir, 'opencode-work')
  expect(await watch.addMachine(poolId, openMachineId, { tool: 'opencode', capacity: 1, workdir: openWorkdir, mode: 'ask' })).toBe(true)
  await eventually(() => state()?.machines?.find(m => m.machine === openMachineId)?.ready, 'the OpenCode machine ready')
}, 60_000)

afterAll(() => {
  service?.kill()
  openService?.kill()
  bridge?.kill()
  openCode?.stop(true)
  client?.stop()
  if (hasTmux) tmux('kill-server')
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
  rmSync(tmuxDir, { recursive: true, force: true })
})

describe.skipIf(!hasTmux)('pool workers on a machine', () => {
  test('a dispatched task runs in its own worktree, in a session that gets it first, pushes its branch and ends on task_done', async () => {
    const id = await dispatch('SECRET API client')
    const done = await eventually(() => taskOf(id)?.state === 'done' && taskOf(id), 'the task done')
    expect(done.branch).toBe(`pool/${id}-secret-api-client`)
    expect(done.summary).toContain('Wrote the file.')
    // A feature: its session was started on a balanced model, which its status line confirmed before it got the task.
    expect(done.route).toMatchObject({ tier: 'balanced', model: 'sonnet', confirmed: 'claude-sonnet-stand-in' })
    expect(logs()).toContain('on sonnet')
    // The worktree is the task's, on its branch, under the folder the owner chose; the branch reached the origin.
    const tree = join(workdir, 'tasks', id)
    expect(git(tree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(done.branch)
    expect(git(join(dir, 'shop.git'), 'log', '--format=%s', '-1', done.branch as string)).toBe(`work on ${id}`)
    // The session got the task as a pool task to start at once, with the worker's steps.
    expect(logs()).toContain(`<pool kind="task" from="Ana" task="${id}">`)
    expect(logs()).toContain('already on it')
    // Then it ended: its tmux is gone, its slot free, and it left the pool.
    await eventually(() => tmux('has-session', '-t', `=tonton-pool-${id}`).exitCode !== 0, 'the session ended')
    await eventually(() => !existsSync(join(home, 'pool-slots', `${poolId}-${id}.json`)), 'the slot free')
    await eventually(() => state()?.sessions.length === 0, 'no session left in the pool')
  }, 90_000)

  test('a session that crashes before task_done puts its task back on the board, and the next one runs a tier up', async () => {
    const id = await dispatch('crash on start')
    const back = await eventually(() => taskOf(id)?.state === 'todo' && taskOf(id), 'the task back')
    expect(back.attempts).toBe(1)
    expect(back.setbacks).toBe(1)
    expect(back.machine).toBeUndefined()
    expect(back.summary).toContain('ended before the task was done')
    expect(back.route).toMatchObject({ tier: 'balanced', model: 'sonnet' })
    // Dispatched again, as the control loop would: strong this time, and no further after it fails again (one tier at most).
    await watch.saveTask(poolId, id, { ...back, state: 'assigned', machine: { account: accountId, machine: machineId } })
    const again = await eventually(() => taskOf(id)?.state === 'todo' && taskOf(id)?.attempts === 2 && taskOf(id), 'the task back again')
    expect(again.route).toMatchObject({ tier: 'strong', model: 'opus', escalated: 1, confirmed: 'claude-opus-stand-in' })
    expect(again.setbacks).toBe(2)
    expect(state()?.events.some(e => e.body?.kind === 'model' && e.body.taskId === id && e.body.text?.includes('up a tier'))).toBe(true)
  }, 120_000)

  test('on an OpenCode machine, its service makes the session and the bridge hands it the task', async () => {
    const id = await dispatch('SECRET docs page', openMachineId)
    const prompt = await eventually(
      () =>
        commands.find(c => c.op === 'prompt' && c.text.includes(`task="${id}"`)) as Extract<PluginCommand, { op: 'prompt' }> | undefined,
      'the task given to OpenCode',
    )
    expect(prompt.directory).toBe(realpathSync(join(dir, 'opencode-work', 'tasks', id)))
    expect(prompt.text).toContain('Start it: call task_claim')
    // Routine docs: a light model, switched to by the bridge before the task, which the task's first message carries.
    expect(commands.find(c => c.op === 'model' && c.sessionID === prompt.sessionID)).toMatchObject({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
    })
    expect(prompt).toMatchObject({ providerID: 'anthropic', modelID: 'claude-haiku-4-5' })
    expect(taskOf(id)?.route).toMatchObject({ tier: 'light', model: 'haiku', confirmed: 'anthropic/claude-haiku-4-5' })
    // OpenCode calls the pool tools through Tonton's plugin; the bridge answers them.
    const tool = (callID: string, name: string, args: Record<string, unknown>) => {
      bridge.stdin.write(`${JSON.stringify({ type: 'tonton.tool', data: { callID, sessionID: prompt.sessionID, name, args } })}\n`)
      bridge.stdin.flush()
    }
    tool('call-1', 'task_claim', { task: id })
    await eventually(() => commands.some(c => c.op === 'tool_result' && c.callID === 'call-1'), 'the claim')
    tool('call-2', 'task_done', { task: id, summary: 'Wrote the docs.', branch: `pool/${id}-secret-docs-page`, tests: 'none: docs' })
    await eventually(() => taskOf(id)?.state === 'done', 'the task done')
    // Its terminal goes; the OpenCode session stays in OpenCode's service, idle.
    await eventually(() => tmux('has-session', '-t', `=tonton-pool-${id}`).exitCode !== 0, 'the terminal closed')
    await eventually(() => !existsSync(join(openHome, 'pool-slots', `${poolId}-${id}.json`)), 'the slot free')
  }, 90_000)

  test('the relay saw none of it: not the repository, the tasks, the folders nor what the sessions wrote', () => {
    const traffic = raw.join('')
    for (const secret of ['SECRET', 'shop.git', workdir, 'Wrote the file', 'pool/']) expect(traffic).not.toContain(secret)
  })
})
