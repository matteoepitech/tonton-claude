// A client of `codex app-server`, the JSON-RPC API Codex's own clients use (its TUI with `--remote`, the IDE
// extensions). Tonton connects next to the TUI on the same server: every connection gets the threads' notifications,
// so Tonton follows a thread, starts and interrupts its turns, and answers its approvals as the TUI could.
// The messages are not a public contract: anything this client does not know is skipped, never thrown.

import { connectUnixWebSocket, type WebSocketLink } from './websocket'

const REQUEST_MS = 30_000

export type RequestId = number | string

export interface AppServerHandlers {
  /** A notification: `thread/started`, `turn/completed`, `item/completed`… */
  notification?(method: string, params: unknown): void
  /**
   * A request from the server, an approval for instance. Answer it with `respond`, or leave it to another client (the
   * TUI): `serverRequest/resolved` then says it was answered.
   */
  request?(id: RequestId, method: string, params: unknown): void
  close?(why: string): void
}

export class AppServerError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
  }
}

export class CodexAppServer {
  private nextId = 1
  private readonly waiting = new Map<RequestId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private link: WebSocketLink | null = null
  closed = false

  private constructor(private readonly handlers: AppServerHandlers) {}

  /** Connects to the server at a unix socket and introduces this client. */
  static async connect(socketPath: string, version: string, handlers: AppServerHandlers = {}): Promise<CodexAppServer> {
    const client = new CodexAppServer(handlers)
    client.link = await connectUnixWebSocket(socketPath, {
      message: text => client.receive(text),
      close: why => client.ended(why),
    })
    await client.request('initialize', { clientInfo: { name: 'tonton', title: 'Tonton Claude', version } })
    client.notify('initialized')
    return client
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = REQUEST_MS): Promise<T> {
    if (this.closed || !this.link) return Promise.reject(new AppServerError('Codex is not connected'))
    const id = this.nextId++
    const link = this.link
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new AppServerError(`Codex did not answer ${method}`))
      }, timeoutMs)
      this.waiting.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      link.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }))
    })
  }

  notify(method: string, params?: unknown) {
    this.link?.send(JSON.stringify({ method, ...(params === undefined ? {} : { params }) }))
  }

  respond(id: RequestId, result: unknown) {
    this.link?.send(JSON.stringify({ id, result }))
  }

  close() {
    this.link?.close()
  }

  private receive(text: string) {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (!message || typeof message !== 'object') return
    const m = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }
    const id = typeof m.id === 'number' || typeof m.id === 'string' ? m.id : undefined
    if (typeof m.method === 'string') {
      if (id === undefined) this.handlers.notification?.(m.method, m.params)
      else this.handlers.request?.(id, m.method, m.params)
      return
    }
    if (id === undefined) return
    const waiter = this.waiting.get(id)
    if (!waiter) return
    this.waiting.delete(id)
    if (m.error && typeof m.error === 'object') {
      const error = m.error as { message?: unknown; code?: unknown }
      waiter.reject(
        new AppServerError(
          typeof error.message === 'string' ? error.message : 'Codex refused the request',
          typeof error.code === 'number' ? error.code : undefined,
        ),
      )
    } else waiter.resolve(m.result)
  }

  private ended(why: string) {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiting.values()) waiter.reject(new AppServerError(`Codex closed the connection: ${why}`))
    this.waiting.clear()
    this.handlers.close?.(why)
  }
}
