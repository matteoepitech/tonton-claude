import type { AgentMessage, RelayToAgent } from '../../../shared/protocol'
import { type AgentConfig, installedVersion } from '../config'
import { log } from '../log'

const MAX_BACKOFF_MS = 30_000
/** Close code the relay uses when the machine was revoked or the account deleted. */
const REVOKED = 4001

export interface RelayConnectionEvents {
  connected(): void
  message(message: RelayToAgent): void
}

/**
 * WebSocket to the relay with automatic reconnection. Messages are built asynchronously (they are sealed),
 * so `post` queues the builders and sends results in order.
 */
export class RelayConnection {
  private socket: WebSocket | null = null
  private backoff = 1000
  private outbox: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(
    private readonly config: AgentConfig,
    private readonly events: RelayConnectionEvents,
  ) {}

  connect() {
    if (this.stopped) return
    const url = `${this.config.server.replace(/^http/, 'ws')}/ws/agent`
    // Bun accepts headers on the WebSocket constructor; the DOM typings do not know about it.
    const headers = { authorization: `Bearer ${this.config.token}`, 'x-tonton-agent': installedVersion() }
    const socket = new WebSocket(url, { headers } as unknown as string[])
    this.socket = socket

    socket.onopen = () => {
      this.backoff = 1000
      log('relay connected')
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
      if (event.code === REVOKED) {
        log('machine revoked, not reconnecting')
        this.stopped = true
        return
      }
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    }
    socket.onerror = () => {}
  }

  post(build: () => Promise<AgentMessage | null>) {
    this.outbox = this.outbox
      .then(async () => {
        const message = await build()
        if (message && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
      })
      .catch(error => log('failed to send to the relay', String(error)))
  }
}
