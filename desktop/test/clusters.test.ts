// The island's clusters: the page reaches the cluster routes only through the main process, which adds the token, and
// only to list its clusters, read their members and join one. Against a real relay, an island account joins another
// account's cluster that way.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../relay/src/config'
import { startRelay } from '../../relay/src/main'
import { ClusterApi } from '../../shared/cluster-api'
import { clusterInviteLink } from '../../shared/cluster-link'
import { ClusterWatch } from '../../shared/cluster-watch'
import { importAccountKey } from '../../shared/crypto'
import { clusterCall, createAccount, isClusterCall } from '../src/main/relay-api'
import { bridgeFetch } from '../src/renderer/clusters'

const dir = mkdtempSync(join(tmpdir(), 'tonton-island-clusters-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir }))
const base = `http://127.0.0.1:${relay.server.port}`

afterAll(() => {
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('only listing, members and joining go out with the token', () => {
  expect(isClusterCall({ method: 'GET', path: '/api/clusters' })).toBe(true)
  expect(isClusterCall({ method: 'GET', path: '/api/clusters/abcdefABCDEF/members' })).toBe(true)
  expect(isClusterCall({ method: 'POST', path: '/api/clusters/join', body: { invite: 'tc_x' } })).toBe(true)
  for (const refused of [
    { method: 'POST', path: '/api/clusters', body: {} },
    { method: 'DELETE', path: '/api/clusters/abcdefABCDEF' },
    { method: 'POST', path: '/api/clusters/abcdefABCDEF/members/acc/kick', body: {} },
    { method: 'GET', path: '/api/clusters/abcdefABCDEF/invites' },
    { method: 'GET', path: '/api/clusters/../account/token' },
    { method: 'GET', path: '/api/clusters', body: {} },
    { method: 'POST', path: '/api/clusters/join', body: 'text' },
    { method: 'POST', path: '/api/clusters/join', body: { blob: 'x'.repeat(70_000) } },
    { method: 'GET', path: '/api/pools' },
    null,
    'GET /api/clusters',
  ])
    expect(isClusterCall(refused)).toBe(false)
})

test('an island account joins a cluster through the main process, and reads it', async () => {
  const island = await createAccount(base, fetch)
  // Another account makes a cluster and an invite, as the website does.
  const owner = await createAccount(base, fetch)
  const ownerApi = new ClusterApi({ relay: base, token: owner.token })
  const { cluster, key } = await ownerApi.create(owner.key, owner.accountId, { name: 'Jam' }, { name: 'Owner' })
  const invite = await ownerApi.createInvite(cluster.id, { uses: 1, hours: 1 })
  const link = clusterInviteLink({ relay: base, cluster: cluster.id, token: invite.token, key, version: 1 })

  // The page has no token: its calls go to the main process, which adds it.
  const calls: unknown[] = []
  const bridge = {
    clusters: async (call: unknown) => {
      calls.push(call)
      return clusterCall(island, call, fetch)
    },
  }
  const watch = new ClusterWatch({
    api: new ClusterApi({ relay: base, token: '', fetch: bridgeFetch(bridge, base) }),
    accountKey: await importAccountKey(island.key),
    account: island.accountId,
    relay: base,
    link: { subscribeCluster: () => {}, unsubscribeCluster: () => {}, sendCluster: () => false },
    onChange: () => {},
  })
  expect(await watch.join(link, { name: 'Island' })).toBe(cluster.id)
  expect(watch.clusters.map(c => c.info?.name)).toEqual(['Jam'])
  expect(calls.map(call => (call as { path: string }).path)).toEqual(['/api/clusters/join', '/api/clusters'])

  // What the island may not do is refused before it leaves the page, and again in the main process.
  expect(await watch.remove(cluster.id)).toBeNull()
  expect(watch.problem).toContain('website')
  expect((await clusterCall(island, { method: 'DELETE', path: `/api/clusters/${cluster.id}` }, fetch)).status).toBe(400)
  expect((await ownerApi.members(cluster.id)).length).toBe(2)
})
