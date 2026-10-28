import type { PoolUpdate } from '../../../shared/pool-protocol'
import { isPoolOrderType, parsePoolUpdate } from '../../../shared/pool-wire'
import type { AgentMessage, RelayToAgent } from '../../../shared/protocol'
import { type AgentConfig, installedVersion } from '../config'
import { log } from '../log'
import { proxyFor, shownProxy } from '../proxy'

const MAX_BACKOFF_MS = 30_000
/** Close code the relay uses when the machine was revoked or the account deleted. */
const REVOKED = 4001

export interface RelayConnectionEvents {
  connected(): void
  message(message: RelayToAgent): void
  /** What changed in a pool this session is in (`pool_join` and `pool_left` come through `message`). */
  pool?(update: PoolUpdate): void
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
  private backoff = 1000
  private outbox: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(
    private readonly config: AgentConfig,
    private readonly role: 'channel' | 'service',
    private readonly events: RelayConnectionEvents,
  ) {}

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

    socket.onopen = () => {
      this.backoff = 1000
      log(`${this.role}: relay connected`, proxy ? { proxy: shownProxy(proxy.url) } : undefined)
      this.events.connected()
    }
    socket.onmessage = event => {
      try {
        const message = JSON.parse(String(event.data)) as RelayToAgent | PoolUpdate
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

  post(build: () => Promise<AgentMessage | null>) {
    this.outbox = this.outbox
      .then(async () => {
        const message = await build()
        if (message && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
      })
      .catch(error => log('failed to send to the relay', String(error)))
  }

  /** Resolves once everything posted so far was handed to the socket. */
  flushed(): Promise<void> {
    return this.outbox
  }
}
