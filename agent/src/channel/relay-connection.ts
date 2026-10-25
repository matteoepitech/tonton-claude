import type { AgentMessage, RelayToAgent } from '../../../shared/protocol'
import { type AgentConfig, installedVersion } from '../config'
import { log } from '../log'

const MAX_BACKOFF_MS = 30_000
/** Close code the relay uses when the machine was revoked or the account deleted. */
const REVOKED = 4001

export interface RelayConnectionEvents {
  connected(): void
  message(message: RelayToAgent): void
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
    // Bun accepts headers on the WebSocket constructor; the DOM typings do not know about it.
    const socket = new WebSocket(url, { headers } as unknown as string[])
    this.socket = socket

    socket.onopen = () => {
      this.backoff = 1000
      log(`${this.role}: relay connected`)
      this.events.connected()
    }
    socket.onmessage = event => {
      try {
        this.events.message(JSON.parse(String(event.data)) as RelayToAgent)
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
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    }
    socket.onerror = () => {}
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
