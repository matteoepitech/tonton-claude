// A pool machine's workers against a real relay (docs/pool-autopilot.md): the service's pools and worker run here, the
// owner drives the pool through the website's client core, and stand-ins replace git and the terminal so that each
// rule shows: claimed once, never past the machine's capacity, the task handed to the session it starts, the session
// ended once the task is done, and the task back on the board when the session ends first or fails too often.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../relay/src/config'
import { startRelay } from '../../relay/src/main'
import { RelayClient, type SocketLike } from '../../shared/client'
import { newAccountKey, seal } from '../../shared/crypto'
import { newPoolItemId, openPoolSessionOrder, PoolVault } from '../../shared/pool'
import { PoolApi } from '../../shared/pool-api'
import type { PoolMachineProfile, PoolTask } from '../../shared/pool-protocol'
import { PoolWatch } from '../../shared/pool-watch'
import { Vault } from '../../shared/vault'
import { RelayConnection } from '../src/channel/relay-connection'
import type { AgentConfig } from '../src/config'
import type { launchForPool } from '../src/launch'
import { MachinePools } from '../src/service/pool-machines'
import { MAX_ATTEMPTS, PoolWorker } from '../src/service/pool-worker'
import type { prepareTaskTree } from '../src/service/pool-worktree'

const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-worker-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`

async function eventually<T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>, label: string): Promise<T> {
  for (let i = 0; i < 160; i++) {
    const value = await read()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const post = async (path: string, body: object, token?: string) =>
  (
    await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  ).json()

/** The sessions the stand-in launcher started: a socket for each, speaking as its agent, and whether it still runs. */
interface FakeSession {
  id: string
  socket: WebSocket
  messages: { t: string; [field: string]: unknown }[]
  alive: boolean
}

let accountId: string
let accountToken: string
let accountKey: string
let machine: { machineId: string; token: string }
let poolId: string
let poolKey: string
let watch: PoolWatch
let client: RelayClient
const sessions = new Map<string, FakeSession>()
const launched: { taskId: string; cwd: string; tool: string }[] = []
/** The model each task's session was started with, and what each session says it runs on, as its status line would. */
const models = new Map<string, string>()
const reported = new Map<string, { model?: string; problem?: string }>()
let silent = false
const prepared: { workdir: string; repo: string; taskId: string; branch: string }[] = []
let failPrepare: string | null = null

/** Starts a session the way Claude Code's channel would show up: it says hello to the relay as the machine. */
const launch: typeof launchForPool = async (taskId, cwd, tool, options) => {
  launched.push({ taskId, cwd, tool })
  const id = `ses_${taskId}`
  if (options?.model) {
    models.set(taskId, options.model)
    reported.set(id, { model: `claude-${options.model}-4-5` })
  }
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/agent`, { headers: { authorization: `Bearer ${machine.token}` } } as never)
  const session: FakeSession = { id, socket, messages: [], alive: true }
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data))
    session.messages.push(message)
    if (message.t === 'pool_join') socket.send(JSON.stringify({ t: 'pool_ack', sessionId: id, poolId: message.poolId }))
  }
  await new Promise(resolve => (socket.onopen = resolve))
  socket.send(
    JSON.stringify({ t: 'hello', sessionId: id, info: await seal(accountKey, { machine: 'PC', cwd, project: 'shop' }), channel: true }),
  )
  sessions.set(id, session)
  return { sessionId: id, tmux: `tonton-pool-${taskId}` }
}

const prepare: typeof prepareTaskTree = async (workdir, repo, taskId, branch) => {
  prepared.push({ workdir, repo, taskId, branch })
  return failPrepare ?? { cwd: join(dir, 'work', 'tasks', taskId), branch }
}

const sessionOf = (tmux: string) => sessions.get(`ses_${tmux.replace('tonton-pool-', '')}`)
const runs = (tmux: string) => sessionOf(tmux)?.alive === true
const end = (tmux: string) => {
  const session = sessionOf(tmux)
  if (session) session.alive = false
}

function worker(home: string) {
  const config: AgentConfig = { server: base, machineId: machine.machineId, token: machine.token, key: accountKey, machine: 'Studio' }
  let work: PoolWorker | null = null
  const connection: RelayConnection = new RelayConnection(config, 'service', {
    connected: () => {},
    message: message => {
      if (message.t === 'pool_machine_join') pools.receive(message.poolId, message.order)
      if (message.t === 'pool_machine_leave') pools.remove(message.poolId)
    },
    pool: update => pools.apply(update),
  })
  const pools = new MachinePools(
    accountKey,
    machine.machineId,
    build => connection.post(build),
    id => work?.changed(id),
    join(home, 'pm.json'),
  )
  const effectiveModel = (_tool: string, sessionId: string) => (silent ? null : (reported.get(sessionId) ?? null))
  work = new PoolWorker(pools, { machineName: 'Studio', home, launch, prepare, runs, end, effectiveModel, confirmMs: 300 })
  connection.connect()
  return { connection, pools, work }
}

let running: ReturnType<typeof worker>
const home = join(dir, 'home')

const state = () => watch.pool(poolId)?.state
const taskOf = (id: string) => state()?.tasks.find(item => item.id === id)
const profile: PoolMachineProfile = { name: 'Studio', tool: 'claude', capacity: 1, workdir: join(dir, 'work'), mode: 'edits' }

async function dispatch(title: string, fields: Partial<PoolTask> = {}): Promise<string> {
  const id = await watch.saveTask(poolId, null, {
    title,
    state: 'assigned',
    criteria: ['it works'],
    machine: { account: accountId, machine: machine.machineId },
    ...fields,
  })
  if (!id) throw new Error('no task')
  return id
}

beforeAll(async () => {
  const account = await post('/api/accounts', {})
  accountId = account.accountId
  accountToken = account.token
  accountKey = newAccountKey()
  const { secret } = await post('/api/account/token', {}, accountToken)
  machine = await post('/api/machines/join', { account: accountId, secret, name: await seal(accountKey, { name: 'Studio' }) })
  const api = new PoolApi({ relay: base, token: accountToken })
  const created = await api.create(accountKey, accountId, { name: 'Shop', repo: 'https://example.com/shop.git' }, { name: 'Ana' })
  poolId = created.pool.id
  poolKey = created.key
  client = new RelayClient({
    vault: new Vault(accountKey),
    connect: () => new WebSocket(`${base.replace('http', 'ws')}/ws/app`, ['tonton', `bearer.${accountToken}`]) as unknown as SocketLike,
    onChange: () => {},
    onPoolUpdate: update => void watch.handle(update),
  })
  watch = new PoolWatch({ api, accountKey, account: accountId, relay: base, link: client, onChange: () => {} })
  client.start()
  await eventually(() => client.state.connection === 'connected', 'the app')
  await watch.refresh()
  watch.open(poolId)
  await eventually(() => state(), 'the pool')
  running = worker(home)
  expect(await watch.addMachine(poolId, machine.machineId, profile)).toBe(true)
  await eventually(() => state()?.machines?.[0]?.ready, 'the machine ready')
}, 20_000)

afterAll(() => {
  running?.work.stop()
  running?.connection.stop()
  client?.stop()
  for (const session of sessions.values()) session.socket.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('a pool machine at work', () => {
  let first: string

  test('a dispatched task gets its worktree and a session, which joins the pool as a worker and holds the task', async () => {
    first = await dispatch('API client', { area: 'back' })
    const item = await eventually(() => taskOf(first)?.task?.assignee && taskOf(first), 'the task with its session')
    expect(item.task).toMatchObject({
      state: 'assigned',
      assignee: { account: accountId, session: `ses_${first}` },
      branch: `pool/${first}-api-client`,
    })
    // The folder and the tool come from the order sealed with the account key.
    expect(prepared[0]).toEqual({
      workdir: profile.workdir,
      repo: 'https://example.com/shop.git',
      taskId: first,
      branch: `pool/${first}-api-client`,
    })
    expect(launched[0]).toEqual({ taskId: first, cwd: join(dir, 'work', 'tasks', first), tool: 'claude' })
    const session = sessions.get(`ses_${first}`)
    const joined = session?.messages.find(m => m.t === 'pool_join') as { order: string } | undefined
    if (!joined) throw new Error('no order for the session')
    const order = await openPoolSessionOrder(accountKey, joined.order, `ses_${first}`, poolId)
    expect(order).toMatchObject({ autoStart: true, machine: machine.machineId, mode: 'edits', key: poolKey })
    const worker = await eventually(() => state()?.sessions.find(s => s.session === `ses_${first}`), 'the worker in the pool')
    expect(worker).toMatchObject({
      machine: machine.machineId,
      profile: { tool: 'claude', machine: 'Studio', area: 'back', project: 'shop' },
    })
    expect(state()?.events.some(e => e.body?.kind === 'task_moved' && e.machine === machine.machineId)).toBe(true)
    expect(readdirSync(join(home, 'pool-slots'))).toEqual([`${poolId}-${first}.json`])
  })

  test('past its capacity, the machine hands a task back; a dispatch is claimed once by its processes', async () => {
    const extra = await dispatch('Billing page')
    const back = await eventually(() => taskOf(extra)?.task?.state === 'todo' && taskOf(extra), 'the task back')
    expect(back.task?.machine).toBeUndefined()
    expect(back.task?.summary).toContain('as many as its owner allows')
    expect(back.task?.attempts).toBeUndefined()
    expect(state()?.events.some(e => e.body?.kind === 'refused' && e.body.taskId === extra)).toBe(true)
    // A second process of the machine, on the same files, starts nothing for the task the first one took.
    const other = worker(home)
    await eventually(() => other.pools.state(poolId), 'the second process’s pool')
    await other.work.settled()
    await Bun.sleep(300)
    expect(launched.filter(l => l.taskId === first)).toHaveLength(1)
    other.work.stop()
    other.connection.stop()
  })

  test("the session's task_done ends it: it leaves the pool and the slot is free", async () => {
    const session = sessions.get(`ses_${first}`) as FakeSession
    const item = taskOf(first)
    if (!item?.task) throw new Error('no task')
    const done: PoolTask = { ...item.task, state: 'done', summary: 'Shipped.\n\nTests: bun test' }
    session.socket.send(
      JSON.stringify({
        t: 'pool_task',
        sessionId: session.id,
        poolId,
        id: first,
        rev: item.rev,
        blob: await new PoolVault(poolKey).seal(done),
      }),
    )
    await eventually(() => session.messages.some(m => m.t === 'pool_left'), 'the session out of the pool')
    expect(session.alive).toBe(false)
    expect(existsSync(join(home, 'pool-slots', `${poolId}-${first}.json`))).toBe(false)
    expect(running.work.running(poolId)).toEqual([])
  })

  test('a session that ends before task_done puts its task back on the board, counted', async () => {
    const id = await dispatch('Search')
    await eventually(() => taskOf(id)?.task?.assignee, 'the task with its session')
    const session = sessions.get(`ses_${id}`) as FakeSession
    session.alive = false
    running.work.changed(poolId)
    const back = await eventually(() => taskOf(id)?.task?.state === 'todo' && taskOf(id), 'the task back')
    // Its session failed it: the next one may run on a stronger model.
    expect(back.task).toMatchObject({ attempts: 1, setbacks: 1 })
    expect(back.task?.assignee).toBeUndefined()
    expect(back.task?.machine).toBeUndefined()
    expect(back.task?.summary).toContain('ended before the task was done')
  })

  test('a task that keeps failing is blocked, with why', async () => {
    failPrepare = 'git clone failed: no such repository'
    const id = await dispatch('Exports', { attempts: MAX_ATTEMPTS - 1 })
    const blocked = await eventually(() => taskOf(id)?.task?.state === 'blocked' && taskOf(id), 'the task blocked')
    expect(blocked.task).toMatchObject({
      attempts: MAX_ATTEMPTS,
      summary: 'Studio could not start it: git clone failed: no such repository',
    })
    // The machine failed it, not a session: no stronger model would help.
    expect(blocked.task?.setbacks).toBeUndefined()
    failPrepare = null
  })

  test('only the orchestrator, a person, the machine itself or a reviewer hand it work', async () => {
    // Another member's session writes a task dispatched to this machine: nothing starts.
    const other = await post('/api/accounts', {})
    const otherKey = newAccountKey()
    const invite = await watch.invite(poolId, { uses: 1, hours: 1, role: 'member' })
    if (!invite) throw new Error('no invite')
    const otherApi = new PoolApi({ relay: base, token: other.token })
    await otherApi.join(otherKey, other.accountId, { relay: base, pool: poolId, token: invite.token, key: poolKey, version: 1 })
    const { secret } = await post('/api/account/token', {}, other.token)
    const otherMachine = await post('/api/machines/join', { account: other.accountId, secret, name: await seal(otherKey, { name: 'PC' }) })
    const agent = new WebSocket(`${base.replace('http', 'ws')}/ws/agent`, {
      headers: { authorization: `Bearer ${otherMachine.token}` },
    } as never)
    await new Promise(resolve => (agent.onopen = resolve))
    agent.send(
      JSON.stringify({
        t: 'hello',
        sessionId: 'ses_claude',
        info: await seal(otherKey, { machine: 'PC', cwd: '/x', project: 'x' }),
        channel: true,
      }),
    )
    const otherApp = new WebSocket(`${base.replace('http', 'ws')}/ws/app`, { headers: { authorization: `Bearer ${other.token}` } } as never)
    await new Promise(resolve => (otherApp.onopen = resolve))
    await Bun.sleep(100)
    const { sealPoolSessionOrder } = await import('../../shared/pool')
    const order = await sealPoolSessionOrder(otherKey, { poolId, sessionId: 'ses_claude', key: poolKey, version: 1 })
    otherApp.send(
      JSON.stringify({ t: 'pool_join_session', poolId, sessionId: 'ses_claude', order, profile: await new PoolVault(poolKey).seal({}) }),
    )
    await eventually(() => state()?.sessions.some(s => s.session === 'ses_claude'), 'the other session')
    const forged: PoolTask = { title: 'Forged', state: 'assigned', machine: { account: accountId, machine: machine.machineId } }
    const forgedId = newPoolItemId()
    agent.send(
      JSON.stringify({
        t: 'pool_task',
        sessionId: 'ses_claude',
        poolId,
        id: forgedId,
        rev: 0,
        blob: await new PoolVault(poolKey).seal(forged),
      }),
    )
    await eventually(() => taskOf(forgedId), 'the forged task')
    await running.work.settled()
    await Bun.sleep(300)
    expect(launched.some(l => l.taskId === forgedId)).toBe(false)
    agent.close()
    otherApp.close()
  })

  test('a restarted service finds its sessions again; one that ended meanwhile puts its task back', async () => {
    const kept = await dispatch('Profile page')
    await eventually(() => taskOf(kept)?.task?.assignee, 'the task with its session')
    running.work.stop()
    running.connection.stop()
    const count = launched.length
    running = worker(home)
    await eventually(() => running.pools.state(poolId), 'the pool after the restart')
    await running.work.settled()
    expect(running.work.running(poolId)).toEqual([kept])
    expect(launched).toHaveLength(count)

    running.work.stop()
    running.connection.stop()
    ;(sessions.get(`ses_${kept}`) as FakeSession).alive = false
    running = worker(home)
    const back = await eventually(() => taskOf(kept)?.task?.state === 'todo' && taskOf(kept), 'the task back after the restart')
    expect(back.task?.attempts).toBe(1)
    expect(running.work.running(poolId)).toEqual([])
  })

  test('stopped, the machine ends its sessions and gives their tasks back uncounted; it takes none until started again', async () => {
    const id = await dispatch('Orders page')
    await eventually(() => taskOf(id)?.task?.assignee, 'the task with its session')
    expect(watch.stopMachine(poolId, machine.machineId)).toBe(true)
    const back = await eventually(() => taskOf(id)?.task?.state === 'todo' && taskOf(id), 'the task back')
    // Said by whichever the machine heard first: its session taken out by the relay, or itself stopped.
    expect(back.task?.summary).toContain('was stopped.')
    expect(back.task?.attempts).toBeUndefined()
    expect((sessions.get(`ses_${id}`) as FakeSession).alive).toBe(false)
    // Stopped, it takes nothing dispatched to it.
    const waiting = await dispatch('Invoices page')
    await running.work.settled()
    await Bun.sleep(300)
    expect(launched.some(l => l.taskId === waiting)).toBe(false)
    // Started again, it does.
    expect(watch.stopMachine(poolId, machine.machineId, false)).toBe(true)
    await eventually(() => taskOf(waiting)?.task?.assignee, 'the task taken once started again')
    // Its slot free again for what follows.
    watch.stopMachine(poolId, machine.machineId)
    await eventually(() => taskOf(waiting)?.task?.state === 'todo', 'given back again')
    watch.stopMachine(poolId, machine.machineId, false)
    await eventually(() => state()?.machines?.[0] && !state()?.machines?.[0]?.stopped, 'started again')
  })

  test('each session starts on the model its task needs, confirmed before it gets the task', async () => {
    // A feature: balanced, Claude Code's sonnet by default.
    const api = taskOf(first)?.task
    expect(models.get(first)).toBe('sonnet')
    expect(api?.route).toMatchObject({ tier: 'balanced', model: 'sonnet', reason: 'a feature', confirmed: 'claude-sonnet-4-5' })
    expect(api?.route?.problem).toBeUndefined()

    // Routine work its session already failed once: up a tier from light, and the pool hears why.
    const docs = await dispatch('Fix typos in the README', { size: 'simple', setbacks: 1 })
    const started = await eventually(() => taskOf(docs)?.task?.route && taskOf(docs), 'the route')
    expect(models.get(docs)).toBe('sonnet')
    expect(started.task?.route).toMatchObject({ tier: 'balanced', escalated: 1, confirmed: 'claude-sonnet-4-5' })
    const said = await eventually(() => state()?.events.find(e => e.body?.kind === 'model' && e.body.taskId === docs), 'the model event')
    expect(said.body?.text).toBe(
      'Fix typos in the README: sonnet (balanced): a small task, routine work (typos); up a tier after a session failed it.',
    )
    ;(sessions.get(`ses_${docs}`) as FakeSession).alive = false
    running.work.changed(poolId)
    await eventually(() => taskOf(docs)?.task?.state === 'todo', 'the task back')

    // The next easy task is assessed on its own: light again. A session that says nothing still gets its task, and the
    // pool hears the model was not confirmed.
    silent = true
    const next = await dispatch('Rename the settings labels', { size: 'simple' })
    const quiet = await eventually(() => taskOf(next)?.task?.assignee && taskOf(next), 'the task with its session')
    expect(models.get(next)).toBe('haiku')
    expect(quiet.task?.route).toMatchObject({ tier: 'light', problem: 'Claude Code did not say which model it runs on' })
    await eventually(() => state()?.events.some(e => e.body?.kind === 'model_problem' && e.body.taskId === next), 'the problem event')
    silent = false
    ;(sessions.get(`ses_${next}`) as FakeSession).alive = false
    running.work.changed(poolId)
    await eventually(() => running.work.running(poolId).length === 0, 'the slot free')
  })

  test('taken out of the pool, the machine ends its sessions', async () => {
    const id = await dispatch('Settings page')
    await eventually(() => taskOf(id)?.task?.assignee, 'the task with its session')
    expect(watch.removeMachine(poolId, machine.machineId)).toBe(true)
    await eventually(() => running.work.running(poolId).length === 0, 'the slots free')
    expect((sessions.get(`ses_${id}`) as FakeSession).alive).toBe(false)
    // An order the relay brings back after that is refused: only a new one from the owner puts it back.
    await running.pools.settled()
    expect(running.pools.order(poolId)).toBeNull()
  })
})
