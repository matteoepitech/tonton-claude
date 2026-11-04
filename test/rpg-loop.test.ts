// Reproducible isolated demo: two accounts, two coding tools, loot, upgrades, durable standings and team rewards. Then XP
// version 2 against a real relay: the welcome backfill, restarts, an older app rewriting the hero, and an older relay.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRPG } from '../agent/src/rpg'
import { TranscriptWork } from '../agent/src/transcript/work'
import { CLAUDE_SESSION, claude } from '../agent/test/rpg-fixtures'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { newAccountKey, seal } from '../shared/crypto'
import { PoolApi } from '../shared/pool-api'
import { PoolKeyring } from '../shared/pool-keys'
import type { Entry } from '../shared/protocol'
import { awardRPG, equipRPG, openRPGBooster, RPG_CATALOG, rpgReward, upgradeRPG } from '../shared/rpg'
import { RPGClient } from '../shared/rpg-client'
import { claimRPGMilestones, drawRPGItem } from '../shared/rpg-loot'
import { claimRPGTeam, RPGPoolClient, rpgStandings, syncRPGPool } from '../shared/rpg-pool'
import { rpgDemoPool } from '../shared/test/rpg-fixture'

test('isolated work → boss reward → booster → upgrade → team loop survives replay, rotation and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tonton-rpg-loop-'))
  let relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir }))
  let url = `http://127.0.0.1:${relay.server.port}`
  const agents: AgentRPG[] = []
  try {
    const account = async () => {
      const a = await (await fetch(`${url}/api/accounts`, { method: 'POST' })).json()
      return { ...a, key: newAccountKey() } as { accountId: string; token: string; key: string }
    }
    const alice = await account(),
      bob = await account(),
      viewer = await account()
    const api = new PoolApi({ relay: url, token: alice.token })
    const { pool, key } = await api.create(
      alice.key,
      alice.accountId,
      { name: 'RPG demo', startedAt: '2026-10-28T10:00:00.000Z' },
      { name: 'Alice' },
    )
    const joinAs = async (who: typeof bob, role: 'member' | 'viewer') => {
      const invite = await api.createInvite(pool.id, { uses: 1, hours: 1, role })
      await new PoolApi({ relay: url, token: who.token }).join(
        who.key,
        who.accountId,
        { relay: url, pool: pool.id, key, version: 1, token: invite.token },
        { name: role },
      )
    }
    await joinAs(bob, 'member')
    await joinAs(viewer, 'viewer')
    for (const [index, who] of [alice, bob].entries()) {
      const request = async (path: string, body: unknown, token = who.token) =>
        (
          await fetch(url + path, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).json()
      const { secret } = await request('/api/account/token', {})
      const machine = await request(
        '/api/machines/join',
        { account: who.accountId, secret, name: await seal(who.key, { name: 'Isolated fixture' }) },
        '',
      )
      const agent = new AgentRPG(
        { server: url, key: who.key, account: who.accountId, machineId: machine.machineId, token: machine.token, machine: 'fixture' },
        join(dir, `agent-${index}`),
      )
      agents.push(agent)
      const at = (seconds: number) => new Date(Date.now() - 600_000 + seconds * 1000).toISOString()
      const entries: Entry[] = [
        {
          id: 'tool',
          ts: at(0),
          kind: 'tool',
          name: 'TodoWrite',
          summary: '',
          toolUseId: 'call',
          todos: [{ content: 'Private fixture task', status: 'completed' }],
        },
        { id: 'result', ts: at(1), kind: 'tool_result', toolUseId: 'call', isError: false, text: 'done' },
      ]
      agent.work(index === 0 ? 'claude' : 'opencode', new TranscriptWork().line({ entries }), false)
      await agent.settled()
      const client = new RPGClient(`${url}/api/rpg`, who.token, who.key)
      expect((await client.read()).state.xp).toBe(10)
    }
    const state = rpgDemoPool()
    state.id = pool.id
    state.members = state.members.map(m => ({
      ...m,
      account: m.account === 'alice' ? alice.accountId : m.account === 'bob' ? bob.accountId : viewer.accountId,
    }))
    state.tasks = state.tasks.map(t => ({
      ...t,
      task: t.task
        ? {
            ...t.task,
            completion: t.task.completion
              ? {
                  ...t.task.completion,
                  assignee: {
                    ...t.task.completion.assignee,
                    account: t.task.completion.assignee.account === 'alice' ? alice.accountId : bob.accountId,
                  },
                  reviewer: {
                    account: t.task.completion.reviewer?.account === 'alice' ? alice.accountId : bob.accountId,
                    session: 'review',
                  },
                }
              : undefined,
          }
        : null,
    }))
    const keys = new PoolKeyring(key, 1)
    const a = new RPGPoolClient(`${url}/api/pools/${pool.id}/rpg`, alice.token, keys)
    const b = new RPGPoolClient(`${url}/api/pools/${pool.id}/rpg`, bob.token, keys)
    const hero = new RPGClient(`${url}/api/rpg`, alice.token, alice.key)
    await Promise.all([a.change(l => syncRPGPool(l, state, alice.accountId)), b.change(l => syncRPGPool(l, state, bob.accountId))])
    const ledger = (await a.read()).ledger
    expect(Object.keys(ledger.completions)).toHaveLength(3)
    expect(Object.values(ledger.goals)[0].eligible).toEqual([alice.accountId, bob.accountId].sort())
    const combat = await Promise.all([1, 2, 3].map(w => rpgReward(w === 3 ? 'boss' : 'encounter', `arena-v1/demo/${w}`, '2026-10-28')))
    await hero.change(h => claimRPGMilestones(claimRPGTeam(combat.reduce(awardRPG, h), ledger, alice.accountId)))
    const before = (await hero.read()).state
    expect(before.xp).toBe(115)
    const booster = before.boosters[0]
    const item = drawRPGItem(0.999, 0)
    await Promise.all([hero.change(h => openRPGBooster(h, booster, item.id)), hero.change(h => openRPGBooster(h, booster, 'hat-common'))])
    const opened = (await hero.read()).state
    const committed = opened.openings[booster].item
    await hero.change(h => upgradeRPG(equipRPG(h, RPG_CATALOG.find(item => item.id === committed)?.slot ?? 'skin', committed), 'health', 1))
    const once = (await hero.read()).state
    await hero.change(h => claimRPGTeam(combat.reduce(awardRPG, h), ledger, alice.accountId))
    expect((await hero.read()).state).toEqual(once)
    keys.add(2, newAccountKey())
    await a.change(l => syncRPGPool(l, { ...state, tasks: [], events: [] }, alice.accountId, once))
    const rotated = (await a.read()).ledger
    expect(rpgStandings(rotated, state, 'run')[0].xp).toBe(120)
    expect(JSON.stringify(rotated)).not.toContain('Private fixture task')
    const ciphertext = await (
      await fetch(`${url}/api/pools/${pool.id}/rpg`, { headers: { authorization: `Bearer ${alice.token}` } })
    ).json()
    expect(ciphertext.blob.startsWith('2:')).toBe(true)
    expect(ciphertext.blob).not.toContain('completions')
    const old = new RPGPoolClient(`${url}/api/pools/${pool.id}/rpg`, bob.token, new PoolKeyring(key, 1))
    await expect(old.read()).rejects.toThrow()
    const viewerWrite = await fetch(`${url}/api/pools/${pool.id}/rpg`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${viewer.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(ciphertext),
    })
    expect(viewerWrite.status).toBe(403)
    await new PoolApi({ relay: url, token: bob.token }).leave(pool.id)
    await expect(b.read()).rejects.toThrow()
    agents.forEach(agent => {
      agent.stop()
    })
    relay.stop()
    relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir }))
    url = `http://127.0.0.1:${relay.server.port}`
    expect((await new RPGClient(`${url}/api/rpg`, alice.token, alice.key).read()).state).toEqual(once)
    expect((await new RPGPoolClient(`${url}/api/pools/${pool.id}/rpg`, alice.token, keys).read()).ledger).toEqual(rotated)
  } finally {
    agents.forEach(agent => {
      agent.stop()
    })
    relay.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('XP version 2: the backfill once, a restart, an older app and an older relay never pay twice nor lose a reward', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tonton-rpg-v2-'))
  const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(dir, 'relay') }))
  const url = `http://127.0.0.1:${relay.server.port}`
  // The machine's relay, older at first: no RPG route at all. Then updated, at the same address.
  let older = true
  const front = Bun.serve({
    port: 0,
    fetch: async request => {
      if (older) return new Response('Not found', { status: 404 })
      const { pathname, search } = new URL(request.url)
      const body = request.method === 'GET' ? undefined : await request.text()
      return fetch(url + pathname + search, { method: request.method, headers: request.headers, body })
    },
  })
  const agents: AgentRPG[] = []
  try {
    const request = async (path: string, body: unknown, token = '') =>
      (
        await fetch(url + path, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()
    const account = await request('/api/accounts', {})
    const key = newAccountKey()
    const { secret } = await request('/api/account/token', {}, account.token)
    const machine = await request('/api/machines/join', { account: account.accountId, secret, name: await seal(key, { name: 'v2' }) })
    const config = {
      server: front.url.origin,
      key,
      account: account.accountId,
      machineId: machine.machineId,
      token: machine.token,
      machine: 'v2',
    }
    const home = join(dir, 'agent')
    const start = () => {
      const agent = new AgentRPG(config, home)
      agents.push(agent)
      return agent
    }
    const hero = new RPGClient(`${url}/api/rpg`, account.token, key)

    // The transcript the backfill finds, and nothing from OpenCode.
    const project = join(dir, 'claude', 'projects', '-work-hero')
    mkdirSync(project, { recursive: true })
    const session = '7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6'
    writeFileSync(join(project, `${session}.jsonl`), CLAUDE_SESSION.map(line => JSON.stringify(line)).join('\n'))
    const sources = { claude: join(dir, 'claude', 'projects'), opencode: join(dir, 'none.db') }

    // An older relay: the backfill's rewards wait on disk, sealed.
    const offline = start()
    expect(await offline.backfill(sources)).toBe(true)
    await offline.settled()
    offline.stop()
    const folder = join(home, 'rpg', readdirSync(join(home, 'rpg')).find(name => !name.startsWith('.')) ?? '')
    const pending = readdirSync(folder).filter(name => /^[a-f0-9]{64}$/.test(name))
    expect(pending.length).toBeGreaterThan(0)

    // The updated relay: they drain, oldest first. The pool post's session keeps its checklist out.
    older = false
    const online = start()
    await online.settled()
    const once = (await hero.read()).state
    expect(once.xp).toBe(8 + 20 + 15 + 2)
    expect(readdirSync(folder).filter(name => /^[a-f0-9]{64}$/.test(name))).toEqual([])
    expect(await online.backfill(sources)).toBe(false)

    // The session read again after a restart, live: nothing new.
    const restarted = start()
    restarted.work(session, claude(CLAUDE_SESSION), true)
    await restarted.settled()
    expect((await hero.read()).state.xp).toBe(once.xp)

    // An app older than rules version 2 drops the gains when it rewrites the hero: the agent's own record still knows.
    await hero.change(state => ({ ...state, gains: undefined, boosters: [...state.boosters, 'older-app'] }))
    const again = start()
    again.work(session, claude(CLAUDE_SESSION), true)
    await again.settled()
    const after = (await hero.read()).state
    expect(after.xp).toBe(once.xp)
    expect(after.gains).toBeUndefined()
  } finally {
    for (const agent of agents) agent.stop()
    front.stop(true)
    relay.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
