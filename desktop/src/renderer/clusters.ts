// The account's clusters in the island: a ClusterWatch (shared/cluster-watch.ts) whose relay routes go through the main
// process, which holds the token (src/main/relay-api.ts, `clusterCall`), and whose live updates come on the page's own
// socket. The island lists, opens and joins clusters; making them and inviting are on the website.

import { ClusterApi, type ClusterDelivery, type ClusterUpdate, ClusterWatch, type RelayClient, type Session } from '../../../shared'
import { profileOf, rememberDelivery } from '../../../web/site/clusters/model'
import type { ClusterCall, IslandBridge } from '../bridge'

/** At most this many clusters are followed live for the strip: the relay allows ten per account. */
const FOLLOWED = 10

/** The relay routes ClusterApi calls, sent to the main process instead. Anything else is refused here already. */
export function bridgeFetch(bridge: Pick<IslandBridge, 'clusters'>, relay: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.origin !== new URL(relay).origin || (method !== 'GET' && method !== 'POST'))
      return Response.json({ error: 'Make clusters and invite on the website.' }, { status: 400 })
    const call: ClusterCall = { method, path: url.pathname }
    if (typeof init?.body === 'string') call.body = JSON.parse(init.body)
    const answer = await bridge.clusters(call)
    const status = answer.status >= 200 && answer.status <= 599 ? answer.status : 502
    return new Response(JSON.stringify(answer.body ?? null), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

export class IslandClusters {
  readonly watch: ClusterWatch

  constructor(
    bridge: Pick<IslandBridge, 'clusters'>,
    relay: string,
    accountKey: CryptoKey,
    account: string,
    client: RelayClient,
    onChange: () => void,
  ) {
    this.watch = new ClusterWatch({
      api: new ClusterApi({ relay, token: '', fetch: bridgeFetch(bridge, relay) }),
      accountKey,
      account,
      relay,
      link: client,
      onChange,
    })
  }

  handle(update: ClusterUpdate) {
    void this.watch.handle(update)
  }

  /** The list again, and every cluster in it followed live. */
  async refresh() {
    await this.watch.refresh()
    for (const listed of this.watch.clusters.slice(0, FOLLOWED)) this.watch.open(listed.summary.id)
  }

  async join(invite: string, name: string): Promise<string | null> {
    const id = await this.watch.join(invite, name ? { name } : undefined)
    if (id) await this.refresh()
    return id
  }

  putIn(clusterId: string, session: Session, delivery: ClusterDelivery) {
    rememberDelivery(clusterId, session.id, delivery)
    void this.watch.putSession(clusterId, session.id, profileOf(session), { delivery })
  }

  takeOut(clusterId: string, sessionId: string) {
    this.watch.takeSessionOut(clusterId, sessionId)
  }

  stop() {
    for (const listed of this.watch.clusters) this.watch.close(listed.summary.id)
  }
}
