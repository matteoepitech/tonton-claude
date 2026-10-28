// Merging end to end: a real relay, two accounts and two Claude Code sessions behind real agents, and real git
// repositories in a temporary folder. The orchestrator's session runs at the top of its clone. A worker finishes a task
// and pushes its branch; task_merge lands it on main once the checks pass. A second branch conflicts with main: it goes
// back to its worker with the conflict. The test plays Claude Code with MCP clients, and the worker's git with plain
// commands. The relay only ever carries sealed blobs.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { git, isolateGit, makeRepos, originMain, pushBranch, pushMain, type Repos } from '../agent/test/git-repos'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { RelayClient, type SocketLike } from '../shared/client'
import { newAccountKey, seal } from '../shared/crypto'
import { type PoolState, PoolVault, sealPoolSessionOrder } from '../shared/pool'
import { PoolApi } from '../shared/pool-api'
import { PoolKeyring } from '../shared/pool-keys'
import { formatPoolInvite, parsePoolInvite } from '../shared/pool-link'
import type { PoolSessionProfile, PoolUpdate } from '../shared/pool-protocol'
import { Vault } from '../shared/vault'

const AGENT = join(import.meta.dir, '../agent/src/main.ts')
const stamp = Date.now()
const LEAD = `lead-${stamp}`
const WORKER = `worker-${stamp}`
const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-merge-e2e-'))
const restoreGit = isolateGit(dir)
const repos: Repos = makeRepos(join(dir, 'repos'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'data') }))
const base = `http://127.0.0.1:${relay.server.port}`
const CHECKS = ['test ! -e BROKEN']

interface App {
  accountId: string
  token: string
  key: string
  client: RelayClient
  updates: PoolUpdate[]
  raw: string[]
}

interface Claude {
  client: Client
  notifications: { method: string; params?: { content?: string; meta?: { sender?: string } } }[]
}

const apps: App[] = []
const claudes: Claude[] = []
let owner: App
let lead: Claude
let worker: Claude
let poolId: string
let poolKey: string

async function eventually<T>(read: () => T | undefined | false | Promise<T | undefined | false>, label: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
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

/** An account with one machine running one Claude Code session in `cwd`, its app on the client core. */
async function member(name: string, sessionId: string, cwd: string): Promise<{ app: App; claude: Claude }> {
  const created = await post('/api/accounts', {})
  const key = newAccountKey()
  const { secret } = await post('/api/account/token', {}, created.token)
  const machine = await post('/api/machines/join', { account: created.accountId, secret, name: await seal(key, { name }) })
  const home = join(dir, name)
  mkdirSync(join(home, 'run'), { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: base, ...machine, key, machine: name, version: '0.9.0' }))
  const app: App = { accountId: created.accountId, token: created.token, key, updates: [], raw: [], client: undefined as never }
  app.client = new RelayClient({
    vault: new Vault(key),
    connect: () => {
      const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/app`, {
        headers: { authorization: `Bearer ${created.token}` },
      } as never)
      socket.addEventListener('message', event => app.raw.push(String(event.data)))
      return socket as unknown as SocketLike
    },
    onChange: () => {},
    onPoolUpdate: update => app.updates.push(update),
  })
  app.client.start()
  await eventually(() => app.client.state.connection === 'connected', `${name}'s app`)
  const transcript = join(home, `${sessionId}.jsonl`)
  writeFileSync(
    transcript,
    [
      { sessionId, type: 'user', uuid: 'u1', message: { content: 'hello' } },
      { sessionId, type: 'assistant', uuid: 'a1', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }] } },
    ]
      .map(line => JSON.stringify(line))
      .join('\n')
      .concat('\n'),
  )
  writeFileSync(join(home, 'run', `${process.pid}.json`), JSON.stringify({ sessionId, transcriptPath: transcript, cwd }))
  const claude: Claude = { client: new Client({ name: 'claude-code', version: 'test' }), notifications: [] }
  claude.client.fallbackNotificationHandler = async notification => {
    claude.notifications.push(notification as Claude['notifications'][number])
  }
  // The agent gets this test's git config too, never the developer's.
  const env = { ...process.env, TONTON_HOME: home, TONTON_CHANNEL: '1', TONTON_SERVICE: 'off' } as Record<string, string>
  await claude.client.connect(new StdioClientTransport({ command: 'bun', args: [AGENT, 'channel'], env, cwd }))
  await eventually(() => app.client.state.sessions.some(s => s.id === sessionId && s.agentOnline), `${name}'s session`)
  apps.push(app)
  claudes.push(claude)
  return { app, claude }
}

const call = async (claude: Claude, name: string, args: Record<string, unknown> = {}) => {
  const result = (await claude.client.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return result.content[0].text
}

const pooled = (claude: Claude, kind: string) =>
  claude.notifications.filter(n => n.params?.meta?.sender === 'pool' && n.params.content?.startsWith(`<pool kind="${kind}"`))

async function stateOf(peer: App): Promise<PoolState | null> {
  const vault = new PoolVault(new PoolKeyring(poolKey, 1))
  let state: PoolState | null = null
  for (const update of peer.updates) {
    if (update.t === 'pool_snapshot') state = await vault.snapshot(update.pool)
    else if (state) state = await vault.apply(state, update)
  }
  return state
}

async function joinSession(app: App, sessionId: string, profile: PoolSessionProfile) {
  const order = await sealPoolSessionOrder(app.key, { poolId, sessionId, key: poolKey, version: 1, autoStart: true })
  const sealed = await new PoolVault(new PoolKeyring(poolKey, 1)).seal(profile)
  app.client.sendPool({ t: 'pool_join_session', poolId, sessionId, order, profile: sealed })
}

/** The worker takes the task it was handed, and returns its id and branch. */
async function handed(title: string): Promise<{ id: string; branch: string }> {
  const task = await eventually(() => pooled(worker, 'task').find(n => n.params?.content?.includes(title)), `${title} at the worker`)
  const content = task.params?.content ?? ''
  const id = /task="([^"]+)"/.exec(content)?.[1] as string
  const branch = /Branch: (pool\/[a-z0-9-]+)\./.exec(content)?.[1] as string
  expect(content).toContain(`git push -u origin ${branch}`)
  expect(await call(worker, 'task_claim', { task: id })).toStartWith('Started.')
  return { id, branch }
}

const big = (title: string) => ({
  title,
  goal: `SECRET ${title}, with its storage, its validation and its tests`,
  criteria: ['the contract holds', 'its tests pass'],
  area: 'back',
  assign: 'auto',
})

beforeAll(async () => {
  ;({ app: owner, claude: lead } = await member('Lead', LEAD, repos.lead))
  const workerMember = await member('Ana', WORKER, repos.ana)
  worker = workerMember.claude
  const api = new PoolApi({ relay: base, token: owner.token })
  const created = await api.create(owner.key, owner.accountId, { name: 'SECRET shop', goal: 'Ship the shop' }, { name: 'Lea' })
  poolId = created.pool.id
  poolKey = created.key
  const invite = await api.createInvite(poolId, { uses: 1, hours: 1 })
  const pasted = parsePoolInvite(formatPoolInvite({ relay: base, pool: poolId, token: invite.token, key: poolKey, version: 1 }))
  if (!pasted) throw new Error('the invite does not parse')
  await new PoolApi({ relay: base, token: workerMember.app.token }).join(workerMember.app.key, workerMember.app.accountId, pasted, {
    name: 'Ana',
  })
  for (const app of apps) app.client.subscribePool(poolId)
  await joinSession(owner, LEAD, { tool: 'claude', repo: repos.lead })
  await joinSession(workerMember.app, WORKER, { area: 'back', tool: 'claude', repo: repos.ana })
  await eventually(async () => {
    const state = await stateOf(owner)
    return state?.sessions.length === 2 && state.sessions.every(s => s.ready)
  }, 'two sessions ready')
  owner.client.sendPool({ t: 'pool_orchestrator', poolId, orchestrator: { account: owner.accountId, session: LEAD } })
  await eventually(async () => (await lead.client.listTools()).tools.some(t => t.name === 'task_merge'), 'the merge tool')
}, 60_000)

afterAll(async () => {
  for (const app of apps) app.client.stop()
  await Promise.all(claudes.map(claude => claude.client.close()))
  relay.stop()
  restoreGit()
  rmSync(dir, { recursive: true, force: true })
}, 20_000)

describe('merging end to end', () => {
  test('a finished, pushed branch lands on main once its checks pass, and the pool sees it merged', async () => {
    expect(await call(lead, 'task_create', big('Items API'))).toContain('Assigned to Ana · back')
    const { id, branch } = await handed('Items API')
    pushBranch(repos.ana, branch, { 'items.txt': 'GET /v1/items\n' })
    expect(await call(worker, 'task_done', { task: id, summary: 'SECRET items done', tests: 'bun test' })).toContain('Done')
    const notice = await eventually(() => pooled(lead, 'notice').find(n => n.params?.content?.includes('is done by')), 'the done notice')
    expect(notice.params?.content).toContain(`Merge ${branch} with task_merge.`)
    const overview = JSON.parse(await call(lead, 'pool_overview'))
    expect(overview.toMerge).toEqual([{ id, title: 'Items API', branch, waitsFor: [] }])

    const said = await call(lead, 'task_merge', { checks: CHECKS })
    expect(said).toContain(`Merged ${branch} into main as ${originMain(repos).slice(0, 10)}, pushed to origin`)
    expect(git(repos.origin, 'show', 'main:items.txt')).toBe('GET /v1/items')
    expect(git(repos.lead, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    const merged = await eventually(async () => {
      const state = await stateOf(owner)
      const task = state?.tasks.find(t => t.id === id)?.task
      return task?.merge?.state === 'merged' && state
    }, 'the task merged for everyone')
    expect(merged.tasks.find(t => t.id === id)?.task?.merge?.commit).toBe(originMain(repos))
    expect(merged.events.some(e => e.body?.kind === 'merged' && e.body.taskId === id)).toBe(true)
    expect(JSON.parse(await call(lead, 'pool_overview')).toMerge).toEqual([])
  })

  test('a branch that conflicts with main goes back to its worker, with the conflict, and main does not move', async () => {
    expect(await call(lead, 'task_create', big('Orders API'))).toContain('Assigned to Ana · back')
    const { id, branch } = await handed('Orders API')
    pushBranch(repos.ana, branch, { 'app.txt': 'orders\n' })
    // Meanwhile someone changed the same line on main.
    pushMain(repos.ana, { 'app.txt': 'SECRET changed on main\n' })
    const before = originMain(repos)
    expect(await call(worker, 'task_done', { task: id, summary: 'SECRET orders done', tests: 'bun test' })).toContain('Done')
    await eventually(async () => (await stateOf(owner))?.tasks.find(t => t.id === id)?.task?.state === 'done', 'the task done')

    const said = await call(lead, 'task_merge', { task: id, checks: CHECKS })
    expect(said).toContain(`${branch} conflicts with main in app.txt: nothing was merged.`)
    expect(said).toContain('Sent back to Ana · back')
    expect(originMain(repos)).toBe(before)
    const back = await eventually(
      () => pooled(worker, 'task').find(n => n.params?.content?.includes('Sent back by the merge')),
      'the task back at the worker',
    )
    expect(back.params?.content).toContain(`${branch} conflicts with main in app.txt`)
    expect(back.params?.content).toContain('git merge origin/main')
    // The short message an older agent would show too, in the pool's activity as well.
    await eventually(
      () => pooled(worker, 'message').find(n => n.params?.content?.includes('came back from the merge')),
      'the message to the worker',
    )
    const state = await eventually(async () => {
      const current = await stateOf(owner)
      return current?.events.some(e => e.body?.kind === 'merge_conflict') && current
    }, 'the conflict in the activity')
    expect(state.tasks.find(t => t.id === id)?.task).toMatchObject({ state: 'assigned', merge: { state: 'conflict', files: ['app.txt'] } })
  })

  test('the relay only ever carried sealed blobs', () => {
    for (const peer of apps) {
      const traffic = peer.raw.join('')
      for (const secret of ['SECRET', 'Items API', 'pool/', 'app.txt', 'items.txt', '<<<<<<<', 'BROKEN', 'origin/main']) {
        expect(traffic).not.toContain(secret)
      }
    }
  })
})
