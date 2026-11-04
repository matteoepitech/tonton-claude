// For the island's smoke run (main.cjs): another account on the relay makes a cluster with one of its sessions in it,
// which posts, and gives the invite the island joins with. Bundled for Electron's Node by CI next to main.cjs:
// bun build test/smoke/cluster.ts --target=node --format=cjs --outfile=<smoke folder>/cluster.cjs
import { ClusterVault, newClusterItemId, sealClusterSessionOrder } from '../../../shared/cluster'
import { ClusterApi } from '../../../shared/cluster-api'
import { clusterInviteLink } from '../../../shared/cluster-link'
import { newAccountKey, seal } from '../../../shared/crypto'

async function post(relay: string, path: string, body: object, token?: string): Promise<Record<string, string>> {
  const response = await fetch(relay + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path}: ${response.status}`)
  return (await response.json()) as Record<string, string>
}

/** Returns the invite link; the owner's session stays connected, in the cluster, for the rest of the run. */
export async function makeCluster(relay: string): Promise<string> {
  const { accountId, token } = await post(relay, '/api/accounts', {})
  const key = newAccountKey()
  const api = new ClusterApi({ relay, token })
  const { cluster, key: clusterKey } = await api.create(key, accountId, { name: 'Smoke jam' }, { name: 'Owner' })
  const invite = await api.createInvite(cluster.id, { uses: 1, hours: 1 })

  const { secret } = await post(relay, '/api/account/token', {}, token)
  const machine = await post(relay, '/api/machines/join', { account: accountId, secret, name: await seal(key, 'Owner PC') })
  const socket = new WebSocket(`${relay.replace(/^http/, 'ws')}/ws/agent`, {
    headers: { authorization: `Bearer ${machine.token}` },
  } as never)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  const session = 'ses_smoke_owner'
  const vault = new ClusterVault(clusterKey)
  socket.send(
    JSON.stringify({
      t: 'hello',
      sessionId: session,
      info: await seal(key, { machine: 'Owner PC', cwd: '/jam', project: 'Jam' }),
      channel: true,
    }),
  )
  const order = await sealClusterSessionOrder(key, { clusterId: cluster.id, sessionId: session, key: clusterKey, version: 1 })
  socket.send(
    JSON.stringify({
      t: 'cluster_join_session',
      sessionId: session,
      clusterId: cluster.id,
      order,
      profile: await vault.seal({
        name: 'level design',
        project: 'Jam',
        machine: 'Owner PC',
        tool: 'claude',
        status: 'blocking out the arena',
      }),
    }),
  )
  socket.send(JSON.stringify({ t: 'cluster_ack', sessionId: session, clusterId: cluster.id }))
  socket.send(
    JSON.stringify({
      t: 'cluster_post',
      sessionId: session,
      clusterId: cluster.id,
      id: newClusterItemId(),
      blob: await vault.seal({ kind: 'message', text: 'Arena blockout pushed to main' }),
    }),
  )
  return clusterInviteLink({ relay, cluster: cluster.id, token: invite.token, key: clusterKey, version: 1 })
}
