import type { ClusterUpdate } from '../../../shared/cluster-protocol'
import { isClusterMessageType, isClusterOrderType, parseClusterToAgent, parseClusterUpdate } from '../../../shared/cluster-wire'
import type { PoolUpdate } from '../../../shared/pool-protocol'
import { isPoolOrderType, parsePoolUpdate } from '../../../shared/pool-wire'
import type { AgentMessage, RelayToAgent, SealedEntry } from '../../../shared/protocol'
import { type AgentConfig, installedVersion } from '../config'
import { log } from '../log'
import { proxyFor, shownProxy } from '../proxy'

const FIRST_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000
/**
 * The backoff starts over once a connection held this long. A socket the relay closes right away, after a message over its
 * limit say, would otherwise be opened again every second, and sent the same message each time.
 */
const STABLE_MS = 30_000
/** Close code the relay uses when the machine was revoked or the account deleted. */
const REVOKED = 4001
/** The relay closes a socket whose message is over 32 MB (MAX_WS_MESSAGE_BYTES in relay/src/limits.ts). */
export const MAX_MESSAGE_BYTES = 24 * 1024 * 1024

/** What a builder hands `post`: one message, several to send in order, or nothing. */
export type Outgoing = AgentMessage | AgentMessage[] | null

export interface RelayConnectionEvents {
  connected(): void
  message(message: RelayToAgent): void
  /** What changed in a pool this session is in (`pool_join` and `pool_left` come through `message`). */
  pool?(update: PoolUpdate): void
  /** What changed in a cluster this session is in (`cluster_join` and `cluster_left` come through `message`). */
  cluster?(update: ClusterUpdate): void
  disconnected?(): void
  revoked?(): void
}

/**
 * WebSocket to the relay with automatic reconnection. Messages are built asynchronously (they are sealed),
 * so `post` queues the builders and sends results in order. A channel speaks for one session; the background service
 * only keeps the machine reachable.
 */
export class RelayConnection {
  private socket: WebSocket | null = null
  private readonly firstBackoff: number
  private readonly stableMs: number
  private backoff: number
  private outbox: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(
    private readonly config: AgentConfig,
    private readonly role: 'channel' | 'service',
    private readonly events: RelayConnectionEvents,
    /** Shorter in tests. */
    timing: { backoffMs?: number; stableMs?: number } = {},
  ) {
    this.firstBackoff = timing.backoffMs ?? FIRST_BACKOFF_MS
    this.stableMs = timing.stableMs ?? STABLE_MS
    this.backoff = this.firstBackoff
  }

  connect() {
    if (this.stopped) return
    const url = `${this.config.server.replace(/^http/, 'ws')}/ws/agent`
    const headers = { authorization: `Bearer ${this.config.token}`, 'x-tonton-agent': installedVersion(), 'x-tonton-role': this.role }
    // fetch() reads HTTPS_PROXY and NO_PROXY by itself, Bun's WebSocket only takes the proxy it is given.
    const proxy = proxyFor(url)
    let socket: WebSocket
    try {
      // Bun accepts headers and a proxy on the WebSocket constructor; the DOM typings do not know about them.
      socket = new WebSocket(url, { headers, proxy: proxy?.url } as unknown as string[])
    } catch (error) {
      log(`${this.role}: could not open the relay connection`, String(error))
      this.retry()
      return
    }
    this.socket = socket
    let openedAt: number | null = null

    socket.onopen = () => {
      openedAt = Date.now()
      log(`${this.role}: relay connected`, proxy ? { proxy: shownProxy(proxy.url) } : undefined)
      this.events.connected()
    }
    socket.onmessage = event => {
      try {
        const message = JSON.parse(String(event.data)) as RelayToAgent | PoolUpdate
        // A cluster's orders and changes, checked like anything else from the relay: a wrong shape is dropped.
        if (isClusterMessageType(message.t)) {
          const order = isClusterOrderType(message.t) ? parseClusterToAgent(message) : null
          if (order) this.events.message(order)
          const update = order ? null : parseClusterUpdate(message)
          if (update) this.events.cluster?.(update)
          return
        }
        const order = isPoolOrderType(message.t)
        if (order || !message.t.startsWith('pool_')) this.events.message(message as RelayToAgent)
        else {
          // A pool's change, checked like anything else from the relay: a wrong shape is dropped.
          const update = parsePoolUpdate(message)
          if (update) this.events.pool?.(update)
        }
      } catch (error) {
        log('unreadable relay message', String(error))
      }
    }
    socket.onclose = event => {
      if (this.socket === socket) this.socket = null
      if (openedAt !== null && Date.now() - openedAt >= this.stableMs) this.backoff = this.firstBackoff
      if (this.stopped) return
      if (event.code === REVOKED) {
        log('machine revoked, not reconnecting')
        this.stopped = true
        this.events.revoked?.()
        return
      }
      this.events.disconnected?.()
      this.retry()
    }
    socket.onerror = () => {}
  }

  private retry() {
    setTimeout(() => this.connect(), this.backoff)
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
  }

  stop() {
    this.stopped = true
    this.socket?.close()
  }

  post(build: () => Promise<Outgoing>) {
    this.outbox = this.outbox
      .then(async () => {
        const built = await build()
        for (const message of Array.isArray(built) ? built : built ? [built] : []) {
          if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
        }
      })
      .catch(error => log('failed to send to the relay', String(error)))
  }

  /** Resolves once everything posted so far was handed to the socket. */
  flushed(): Promise<void> {
    return this.outbox
  }
}

/**
 * Sealed entries in batches that each make a message under `maxBytes`, in order, and always one batch for a reset to go
 * out. An entry too big for a message of its own is left out: sent, it would close the socket.
 */
export function entryBatches(entries: SealedEntry[], maxBytes = MAX_MESSAGE_BYTES): SealedEntry[][] {
  // What the message around the entries takes, its session or share id included.
  const room = maxBytes - 1024
  const batches: SealedEntry[][] = [[]]
  let size = 0
  for (const entry of entries) {
    const bytes = entry.blob.length + Buffer.byteLength(JSON.stringify({ id: entry.id, ts: entry.ts })) + 12
    if (bytes > room) {
      log('left out an entry too big for a relay message', { bytes })
      continue
    }
    if (size + bytes > room && size > 0) {
      batches.push([])
      size = 0
    }
    batches[batches.length - 1].push(entry)
    size += bytes
  }
  return batches
}

/**
 * Sealed entries as `entries` messages under the relay's limit. With `reset`, only the first replaces the session's
 * history and the next ones add to it: the relay ends up with the history one message would have left it.
 */
export function entriesMessages(sessionId: string, entries: SealedEntry[], reset: boolean, maxBytes = MAX_MESSAGE_BYTES): AgentMessage[] {
  return entryBatches(entries, maxBytes).map((batch, index) => ({ t: 'entries', sessionId, entries: batch, reset: reset && index === 0 }))
}
