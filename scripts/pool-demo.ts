// A pool on autopilot on one computer (docs/pool-autopilot.md, #261): a relay, three machines that each run their real
// background service with a TONTON_HOME and a tmux server of their own, a sample project in a local git repository, and
// a pool whose orchestrator machine plans it and hands its tasks out. Its sessions are stand-ins for Claude Code that run
// the real channel (test/stand-in-claude.ts): the orchestrator writes the plan below and proposes it, the demo accepts
// it as the admin would on the website, and the dispatch starts; workers
// claim their task, commit on its branch, push it and finish it. No account, no token spent, nothing outside a temporary
// folder. `bun scripts/pool-demo.ts` keeps it running and says how to watch it on the website; test/pool-demo.test.ts
// runs it to the end.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { RelayClient, type SocketLike } from '../shared/client'
import { newAccountKey, seal } from '../shared/crypto'
import type { PoolState } from '../shared/pool'
import { PoolApi } from '../shared/pool-api'
import { pendingPlan } from '../shared/pool-plan'
import type { PoolMachineProfile } from '../shared/pool-protocol'
import { PoolWatch } from '../shared/pool-watch'
import { encodeRecoveryKey } from '../shared/recovery-key'
import { Vault } from '../shared/vault'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const STAND_IN = join(import.meta.dir, '../test/stand-in-claude.ts')

/** What the orchestrator plans, in the stand-in's format: `after` lists the tasks a task waits for, by their index. */
export const DEMO_PLAN = {
  goal: 'A small online shop: a catalog API, a cart and checkout on top of it, a landing page, and how to run it all.',
  contracts: 'GET /api/products returns [{ id, name, priceCents }]. POST /api/cart takes { productId, quantity }. Pages live in web/.',
  stack: 'TypeScript on Bun. `bun test` runs the tests.',
  areas: ['back: src/', 'front: web/', 'docs: README.md, docs/'],
  tasks: [
    {
      title: 'Product catalog API',
      goal: 'Serve the products from a JSON file at GET /api/products, as the contracts say, with tests.',
      criteria: ['GET /api/products returns every product', 'prices are in cents'],
      size: 'large',
      area: 'back',
    },
    {
      title: 'Cart and checkout',
      goal: 'Add products to a cart through POST /api/cart and check out, on top of the catalog API.',
      criteria: ['an unknown product is refused', 'the total is the sum of the lines'],
      size: 'large',
      area: 'back',
      after: [0],
    },
    {
      title: 'Landing page',
      goal: 'A landing page that says what the shop sells and lists the products from the catalog.',
      criteria: ['the page says what the shop sells', 'it lists the products'],
      size: 'large',
      area: 'front',
    },
    {
      title: 'README and setup',
      goal: 'Say in the README how to install, run and test the shop.',
      criteria: ['the README says how to run the shop', 'the README says how to run the tests'],
      size: 'simple',
      area: 'docs',
    },
  ],
} as const

/** The machines of the demo: the orchestrator machine also takes the simple tasks; the two others, the features. */
const MACHINES: (Omit<PoolMachineProfile, 'workdir'> & { name: string })[] = [
  { name: 'Lead', tool: 'claude', capacity: 1, mode: 'full', takes: 'simple', areas: ['docs'] },
  { name: 'Studio', tool: 'claude', capacity: 2, mode: 'full', takes: 'large', areas: ['back'] },
  { name: 'Laptop', tool: 'claude', capacity: 1, mode: 'full', takes: 'large', areas: ['front'] },
]

export interface DemoMachine {
  name: string
  id: string
  home: string
  /** Short: tmux's socket path must stay under 104 bytes on macOS. */
  tmux: string
  env: Record<string, string>
  /** Its background service. */
  service: { kill(): void }
}

export interface PoolDemo {
  /** The relay's address: the website is there. */
  relay: string
  /** Signs the website or the app in to the demo's account. */
  token: string
  dir: string
  /** The sample project's repository, a bare one in `dir`. */
  origin: string
  account: string
  poolId: string
  machines: DemoMachine[]
  watch: PoolWatch
  state(): PoolState | undefined
  stop(): void
}

export interface PoolDemoOptions {
  /** The relay's port: 0 picks a free one. */
  port?: number
  /** Called on every change of the pool, once it is open. */
  onChange?: (state: PoolState) => void
  /**
   * How long the demo leaves the orchestrator's plan waiting before it accepts it, as the admin would with Accept on the
   * website. Accepted there first, it goes on from there. 0: at once.
   */
  acceptAfterMs?: number
}

/** True where the demo runs: its sessions live in tmux, as on any pool machine. */
export function canRunDemo(): boolean {
  return process.platform !== 'win32' && Bun.spawnSync(['tmux', '-V'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
}

export async function startPoolDemo(options: PoolDemoOptions = {}): Promise<PoolDemo> {
  if (!canRunDemo()) throw new Error('The demo needs tmux, on macOS or Linux: pool machines run their sessions in it.')
  const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-demo-'))
  const relayServer = startRelay(loadConfig({ PORT: String(options.port ?? 7777), TONTON_DATA_DIR: join(dir, 'relay') }))
  const relay = `http://127.0.0.1:${relayServer.server.port}`
  const machines: DemoMachine[] = []
  let client: RelayClient | undefined

  const stop = () => {
    client?.stop()
    for (const machine of machines) {
      machine.service.kill()
      Bun.spawnSync(['tmux', 'kill-server'], { env: machine.env, stdout: 'ignore', stderr: 'ignore' })
      rmSync(machine.tmux, { recursive: true, force: true })
    }
    relayServer.stop()
    rmSync(dir, { recursive: true, force: true })
  }

  try {
    const gitEnv = { GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
    writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[user]\n\tname = Stand-in\n\temail = stand-in@example.com\n[init]\n\tdefaultBranch = main\n')
    const origin = sampleProject(dir, gitEnv)
    const plan = join(dir, 'plan.json')
    writeFileSync(plan, JSON.stringify(DEMO_PLAN))
    // Pool machines start `$SHELL -lic 'claude --model sonnet'`: this shell starts the stand-in instead, which takes its
    // model from those arguments and says it runs on it, as Claude Code's status line would.
    const shell = join(dir, 'shell')
    writeFileSync(shell, `#!/bin/sh\nexec "${process.execPath}" "${STAND_IN}" "$@"\n`)
    chmodSync(shell, 0o755)

    const created = await post(relay, '/api/accounts', {})
    const account: string = created.accountId
    const key = newAccountKey()
    const { secret } = await post(relay, '/api/account/token', {}, created.token)
    for (const { name } of MACHINES) {
      const joined = await post(relay, '/api/machines/join', { account, secret, name: await seal(key, { name }) })
      const home = join(dir, 'machines', name)
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'config.json'), JSON.stringify({ server: relay, ...joined, key, machine: name, version: '0.9.0' }))
      const tmux = mkdtempSync(join(tmpdir(), 'ttd-'))
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...gitEnv,
        TONTON_HOME: home,
        TONTON_SERVICE: 'off',
        TONTON_STAND_IN_PLAN: plan,
        TMUX_TMPDIR: tmux,
        SHELL: shell,
      }
      // Inside a tmux session, tmux would talk to the developer's server whatever TMUX_TMPDIR says.
      delete env.TMUX
      const service = Bun.spawn(['bun', AGENT, 'service'], { env, stdout: 'ignore', stderr: 'ignore' })
      machines.push({ name, id: joined.machineId, home, tmux, env, service })
    }

    const api = new PoolApi({ relay, token: created.token })
    const pool = await api.create(key, account, { name: 'Shop hackathon', repo: origin }, { name: 'Demo' })
    const poolId = pool.pool.id
    let watch: PoolWatch | undefined
    /** The proposal the demo accepts, once. */
    let accepting = ''
    const state = () => watch?.pool(poolId)?.state ?? undefined
    client = new RelayClient({
      vault: new Vault(key),
      connect: () => new WebSocket(`${relay.replace('http', 'ws')}/ws/app`, ['tonton', `bearer.${created.token}`]) as unknown as SocketLike,
      onChange: () => {},
      onPoolUpdate: update => void watch?.handle(update),
    })
    watch = new PoolWatch({
      api,
      accountKey: key,
      account,
      relay,
      link: client,
      onChange: () => {
        const now = state()
        if (!now) return
        options.onChange?.(now)
        const plan = pendingPlan(now)
        if (plan && plan.id !== accepting) {
          accepting = plan.id
          setTimeout(() => void watch?.acceptPlan(poolId), options.acceptAfterMs ?? 0)
        }
      },
    })
    client.start()
    const link = client
    await eventually(() => link.state.connection === 'connected', 'the connection to the relay')
    await watch.refresh()
    watch.open(poolId)
    await eventually(() => state(), 'the pool')

    for (const [i, machine] of machines.entries()) {
      const { name, ...profile } = MACHINES[i]
      const added = await watch.addMachine(poolId, machine.id, { name, ...profile, workdir: join(dir, 'work', machine.name) })
      if (!added) throw new Error(`${machine.name} could not join the pool`)
    }
    await eventually(() => state()?.machines?.length === machines.length && state()?.machines?.every(m => m.ready), 'the machines')
    // The first machine runs the orchestrator session and the control loop: from here on, nobody moves a card.
    if (!watch.setOrchestratorMachine(poolId, { account, machine: machines[0].id })) throw new Error('No orchestrator machine')
    await eventually(() => state()?.orchestrator, 'the orchestrator session')

    // What the website signs in with: the recovery key, as the Mac app shows it in Settings › Relay.
    const token = encodeRecoveryKey({ relay, accountId: account, token: created.token, key, joinSecret: secret })
    return { relay, token, dir, origin, account, poolId, machines, watch, state, stop }
  } catch (error) {
    stop()
    throw error
  }
}

/** The shop the pool builds: a README and a package, on `main` of a bare repository. */
function sampleProject(dir: string, gitEnv: Record<string, string>): string {
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, ...gitEnv }, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  }
  const origin = join(dir, 'shop.git')
  const seed = join(dir, 'seed')
  git(dir, 'init', '--bare', '-b', 'main', origin)
  git(dir, 'clone', origin, seed)
  writeFileSync(join(seed, 'README.md'), '# Shop\n\nA small online shop, built by a Tonton Claude pool.\n')
  writeFileSync(join(seed, 'package.json'), `${JSON.stringify({ name: 'shop', private: true, scripts: { test: 'bun test' } }, null, 2)}\n`)
  git(seed, 'add', '.')
  git(seed, 'commit', '-m', 'start the shop')
  git(seed, 'push', 'origin', 'main')
  rmSync(seed, { recursive: true, force: true })
  return origin
}

/** The relay's answer to an account or machine request: ids, tokens and secrets. */
async function post(relay: string, path: string, body: object, token?: string): Promise<Record<string, string>> {
  const response = await fetch(relay + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
  return (await response.json()) as Record<string, string>
}

async function eventually<T>(read: () => T | undefined | null | false, label: string, tries = 600): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(100)
  }
  throw new Error(`The demo timed out waiting for ${label}.`)
}

/** One line per task: its state and the machine that runs it. */
export function board(state: PoolState, machines: DemoMachine[]): string {
  return state.tasks
    .filter(item => item.task)
    .map(item => {
      const machine = machines.find(m => m.id === item.task?.machine?.machine)?.name
      return `  ${(item.task?.state ?? '').padEnd(11)} ${item.task?.title}${machine ? `  (${machine})` : ''}`
    })
    .join('\n')
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 7777)
  let shown = ''
  let demo: PoolDemo | undefined
  const show = (state: PoolState) => {
    const now = demo ? board(state, demo.machines) : ''
    if (now && now !== shown) console.log(`\n${new Date().toLocaleTimeString()}\n${now}`)
    shown = now
  }
  console.log('Starting a relay, three machines and a pool…')
  // Time to see the plan's card on the website and accept it there; the demo accepts it otherwise.
  demo = await startPoolDemo({ port, onChange: show, acceptAfterMs: 60_000 })
  const running = demo
  console.log(`
The pool runs on autopilot at ${running.relay}

Open it in a browser and sign in with this recovery key:

  ${running.token}

The orchestrator proposes its plan in a moment: accept it on the website, or the demo does in a minute.
The sample project is ${running.origin}; each task is pushed on its own branch there.
Machines' logs: ${join(running.dir, 'machines', '<name>', 'tonton.log')}. Ctrl+C stops everything and deletes it.`)
  const quit = () => {
    running.stop()
    process.exit(0)
  }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)
}
