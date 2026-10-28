// Reproducible isolated demo: two accounts, two coding tools, loot, upgrades, durable standings and team rewards.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRPG } from '../agent/src/rpg'
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
      const entries: Entry[] = [
        {
          id: 'tool',
          ts: '2026-10-28T10:01:00Z',
          kind: 'tool',
          name: 'TodoWrite',
          summary: '',
          toolUseId: 'call',
          todos: [{ content: 'Private fixture task', status: 'completed' }],
        },
        { id: 'result', ts: '2026-10-28T10:01:01Z', kind: 'tool_result', toolUseId: 'call', isError: false, text: 'done' },
      ]
      agent.observe(index === 0 ? 'claude' : 'opencode', entries, false)
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
