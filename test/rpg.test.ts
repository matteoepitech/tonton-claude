// Real relay, encrypted clients and an agent outbox: retries, account isolation and restart persistence.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRPG } from '../agent/src/rpg'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { newAccountKey, open, seal } from '../shared/crypto'
import type { Entry } from '../shared/protocol'
import { awardRPG, equipRPG, openRPGBooster, rpgReward, upgradeRPG } from '../shared/rpg'
import { RPGClient, RPGUnavailable } from '../shared/rpg-client'

const dir = mkdtempSync(join(tmpdir(), 'tonton-rpg-'))
let relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir }))
let base = `http://127.0.0.1:${relay.server.port}`
const api = (path: string, token?: string, method = 'GET', body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
afterAll(() => {
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('concurrent encrypted rewards survive restart, replay and equipment changes', async () => {
  const account = await (await api('/api/accounts', undefined, 'POST')).json()
  const key = newAccountKey()
  const a = new RPGClient(`${base}/api/rpg`, account.token, key)
  const b = new RPGClient(`${base}/api/rpg`, account.token, key)
  const rewards = await Promise.all(['a', 'b', 'c', 'd'].map(id => rpgReward('poolTask', id, '2026-10-28')))
  await Promise.all(rewards.map((reward, i) => (i % 2 ? a : b).change(s => awardRPG(s, reward))))
  await Promise.all(rewards.map(reward => a.change(s => awardRPG(s, reward))))
  expect((await b.read()).state.xp).toBe(200)
  await a.change(s => equipRPG(s, 'skin', 'skin-common'))
  await Promise.all([a.change(s => openRPGBooster(s, 'level-2', 'hat-rare')), b.change(s => openRPGBooster(s, 'level-2', 'hat-legendary'))])
  const opened = (await a.read()).state
  expect(opened.boosters).toEqual([])
  expect(Object.keys(opened.openings)).toEqual(['level-2'])
  expect(opened.owned).toHaveLength(2)
  await Promise.all([a.change(s => upgradeRPG(s, 'health', 1)), b.change(s => upgradeRPG(s, 'health', 1))])
  expect((await b.read()).state.sparks).toBe(10)
  const before = await a.read()
  expect(before.document.blob).not.toContain('skin-common')
  expect(await open(key, before.document.blob ?? '')).toEqual(before.state)
  expect((await api('/api/rpg', account.token, 'PUT', { rev: 0, blob: await seal(key, {}) })).status).toBe(409)
  expect((await api('/api/rpg', account.token, 'PUT', { rev: -1, blob: 'bad' })).status).toBe(400)
  expect((await api('/api/rpg')).status).toBe(401)
  const stranger = await (await api('/api/accounts', undefined, 'POST')).json()
  expect((await new RPGClient(`${base}/api/rpg`, stranger.token, newAccountKey()).read()).state.xp).toBe(0)
  relay.stop()
  relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir }))
  base = `http://127.0.0.1:${relay.server.port}`
  expect((await new RPGClient(`${base}/api/rpg`, account.token, key).read()).state).toEqual(before.state)
})

test('agent keeps sealed pending awards on failure and replays once after restarting', async () => {
  const account = await (await api('/api/accounts', undefined, 'POST')).json()
  const key = newAccountKey()
  const secret = (await (await api('/api/account/token', account.token, 'POST', {})).json()).secret
  const machine = await (
    await api('/api/machines/join', undefined, 'POST', { account: account.accountId, secret, name: await seal(key, { name: 'test' }) })
  ).json()
  const config = { server: base, account: account.accountId, key, machineId: machine.machineId, token: 'invalid', machine: 'test' }
  const home = join(dir, 'agent')
  let agent = new AgentRPG(config, home)
  const entries: Entry[] = [
    {
      id: 'a',
      ts: '2026-10-28T12:00:00Z',
      kind: 'tool',
      name: 'TodoWrite',
      summary: '',
      toolUseId: 'call',
      todos: [{ content: 'Private task', status: 'completed' }],
    },
    { id: 'b', ts: '2026-10-28T12:01:00Z', kind: 'tool_result', toolUseId: 'call', text: 'ok', isError: false },
  ]
  agent.observe('session', entries, false)
  await agent.settled()
  agent.stop()
  const folder = join(home, 'rpg', readdirSync(join(home, 'rpg'))[0])
  const pending = readdirSync(folder)
  expect(pending).toHaveLength(1)
  expect(readFileSync(join(folder, pending[0]), 'utf8')).not.toContain('Private task')
  agent = new AgentRPG({ ...config, token: machine.token }, home)
  await agent.settled()
  agent.observe('session', entries, false)
  await agent.settled()
  agent.stop()
  expect((await new RPGClient(`${base}/api/rpg`, account.token, key).read()).state.xp).toBe(10)
  expect(readdirSync(folder)).toEqual([])
  await api('/api/account/token', account.token, 'POST', { regenerate: true })
  expect((await api('/api/agent/rpg', machine.token)).status).toBe(401)
  expect((await new RPGClient(`${base}/api/rpg`, account.token, newAccountKey()).read()).state.xp).toBe(0)
})

test('old relay and corrupt or future documents never overwrite the hero', async () => {
  const old = new RPGClient('https://unused', 'token', newAccountKey(), (async () => new Response('', { status: 404 })) as typeof fetch)
  expect(old.read()).rejects.toBeInstanceOf(RPGUnavailable)
  const account = await (await api('/api/accounts', undefined, 'POST')).json()
  const key = newAccountKey()
  await api('/api/rpg', account.token, 'PUT', { rev: 0, blob: await seal(key, { version: 2 }) })
  const client = new RPGClient(`${base}/api/rpg`, account.token, key)
  await expect(client.change(s => s)).rejects.toThrow()
  expect((await (await api('/api/rpg', account.token)).json()).rev).toBe(1)
})
