// An isolated RPG demo: temporary relay, two fixture workers and recoverable browser accounts. No installer runs.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRPG } from '../agent/src/rpg'
import { loadConfig } from '../relay/src/config'
import { startRelay } from '../relay/src/main'
import { newAccountKey, seal } from '../shared/crypto'
import { PoolApi } from '../shared/pool-api'
import { PoolKeyring } from '../shared/pool-keys'
import type { Entry } from '../shared/protocol'
import { encodeRecoveryKey } from '../shared/recovery-key'
import { awardRPG, rpgReward } from '../shared/rpg'
import { RPGClient } from '../shared/rpg-client'
import { claimRPGTeam, RPGPoolClient, syncRPGPool } from '../shared/rpg-pool'
import { rpgDemoPool } from '../shared/test/rpg-fixture'

const directory = mkdtempSync(join(tmpdir(), 'tonton-rpg-demo-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: join(directory, 'relay') }))
const url = `http://127.0.0.1:${relay.server.port}`
const agents: AgentRPG[] = []
const request = async (path: string, body: unknown, token = '') => {
  const response = await fetch(url + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Demo setup failed (${response.status})`)
  return response.json()
}
const people = await Promise.all(
  ['Alice', 'Bob'].map(async name => ({ ...(await request('/api/accounts', {})), key: newAccountKey(), name })),
)
const alice = people[0],
  bob = people[1]
const api = new PoolApi({ relay: url, token: alice.token })
const { pool, key } = await api.create(
  alice.key,
  alice.accountId,
  { name: 'RPG demo', template: 'hackathon', startedAt: '2026-10-28T10:00:00.000Z' },
  { name: 'Alice' },
)
const invite = await api.createInvite(pool.id, { uses: 1, hours: 1 })
await new PoolApi({ relay: url, token: bob.token }).join(
  bob.key,
  bob.accountId,
  { relay: url, pool: pool.id, key, version: 1, token: invite.token },
  { name: 'Bob' },
)
const state = rpgDemoPool()
state.id = pool.id
state.members = people.map(person => ({
  account: person.accountId,
  role: person === alice ? 'owner' : 'member',
  joinedAt: state.createdAt,
  profile: { name: person.name },
  publicKeys: [],
}))
state.tasks = state.tasks.map((item, index) => ({
  ...item,
  id: `rpg-demo-task-${index}`,
  task: item.task
    ? {
        ...item.task,
        completion: {
          at: `2026-10-28T10:0${index + 1}:00.000Z`,
          assignee: { account: people[index % 2].accountId, session: index % 2 ? 'opencode' : 'claude' },
          reviewer: { account: people[(index + 1) % 2].accountId, session: 'review' },
        },
      }
    : null,
}))
const keys = new PoolKeyring(key, 1)
for (const [index, person] of people.entries()) {
  const { secret } = await request('/api/account/token', {}, person.token)
  const machine = await request('/api/machines/join', {
    account: person.accountId,
    secret,
    name: await seal(person.key, { name: `${person.name}'s fixture` }),
  })
  const agent = new AgentRPG(
    { server: url, account: person.accountId, key: person.key, token: machine.token, machineId: machine.machineId, machine: person.name },
    join(directory, `agent-${index}`),
  )
  agents.push(agent)
  const entries: Entry[] = [
    {
      id: 'tool',
      ts: '2026-10-28T10:00:00Z',
      kind: 'tool',
      name: 'TodoWrite',
      toolUseId: 'call',
      summary: '',
      todos: Array.from({ length: 12 }, (_, i) => ({ content: `Fixture task ${i}`, status: 'completed' })),
    },
    { id: 'result', ts: '2026-10-28T10:00:01Z', kind: 'tool_result', toolUseId: 'call', text: 'done', isError: false },
  ]
  agent.observe(index ? 'opencode' : 'claude', entries, false)
  await agent.settled()
  const client = new RPGClient(`${url}/api/rpg`, person.token, person.key)
  const boss = await rpgReward('boss', 'arena-v1/demo-boss/3', '2026-10-28')
  const hero = await client.change(h => awardRPG(h, boss))
  const ledger = await new RPGPoolClient(`${url}/api/pools/${pool.id}/rpg`, person.token, keys).change(l =>
    syncRPGPool(l, state, person.accountId, hero),
  )
  await client.change(h => claimRPGTeam(h, ledger, person.accountId))
}
const file = join(directory, 'demo.json')
writeFileSync(
  file,
  JSON.stringify(
    {
      url,
      pool: pool.id,
      accounts: people.map(person => ({
        ...person,
        recovery: encodeRecoveryKey({ relay: url, accountId: person.accountId, token: person.token, key: person.key }),
      })),
    },
    null,
    2,
  ),
  { mode: 0o600 },
)
console.log(`RPG demo: ${url}\nTemporary sign-in keys: ${file}\nUse an isolated browser profile. Ctrl-C removes this demo's files.`)
const stop = () => {
  for (const agent of agents) agent.stop()
  relay.stop()
  rmSync(directory, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
