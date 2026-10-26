// A teammate's live view of one shared session: a WebSocket to the relay's `/ws/share`, reconnected with backoff, whose
// entries are opened with the share's key. It only reads: nothing it could send would reach the session.

import type { SocketLike } from './client'
import { type AccountKey, open } from './crypto'
import type { Entry, RelayToViewer, SealedEntry, SessionStatus } from './protocol'
import { STATUS_LABELS } from './session'
import { Vault } from './vault'

export interface SharedView {
  connection: 'connecting' | 'connected' | 'offline' | 'ended'
  status: SessionStatus | null
  project: string | null
  title: string | null
  tool: 'opencode' | null
  /** Null until the relay sent the copy. */
  entries: Entry[] | null
}

export const initialView: SharedView = { connection: 'connecting', status: null, project: null, title: null, tool: null, entries: null }

const MAX_BACKOFF_MS = 30_000
/** The relay closes a viewer with this code once the share is revoked or expired. */
const ENDED = 4001

export interface ShareViewerOptions {
  /** The share's own key, base64url or imported. */
  key: AccountKey
  connect: () => SocketLike
  onChange: (view: SharedView) => void
  retryMs?: number
}

export class ShareViewer {
  private current: SharedView = initialView
  private readonly vault: Vault
  private socket: SocketLike | null = null
  private generation = 0
  private backoff: number
  private retry: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()
  /** Ids of the entries shown, so that an entry sent twice shows once. */
  private ids = new Set<string>()

  constructor(private readonly options: ShareViewerOptions) {
    this.vault = new Vault(options.key)
    this.backoff = options.retryMs ?? 1000
  }

  get view(): SharedView {
    return this.current
  }

  start() {
    this.stop()
    this.open()
  }

  stop() {
    this.generation++
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.socket?.close(1000, 'stopped')
    this.socket = null
  }

  private open() {
    const generation = this.generation
    let socket: SocketLike
    try {
      socket = this.options.connect()
    } catch {
      this.scheduleReconnect(generation)
      return
    }
    this.socket = socket
    socket.onmessage = event => {
      if (generation !== this.generation || typeof event.data !== 'string') return
      const raw = event.data
      this.queue = this.queue.then(() => this.receive(raw, generation)).catch(() => {})
    }
    socket.onclose = event => {
      if (generation !== this.generation) return
      this.socket = null
      if (event.code === ENDED || this.current.connection === 'ended') {
        this.generation++
        this.set({ ...this.current, connection: 'ended' })
        return
      }
      this.set({ ...this.current, connection: 'offline' })
      this.scheduleReconnect(generation)
    }
    socket.onerror = () => {}
  }

  private async receive(raw: string, generation: number) {
    let message: RelayToViewer
    try {
      message = JSON.parse(raw) as RelayToViewer
    } catch {
      return
    }
    const next = await this.apply(message)
    if (generation !== this.generation || !next) return
    if (message.t === 'shared') this.backoff = this.options.retryMs ?? 1000
    this.set(next)
  }

  private async apply(message: RelayToViewer): Promise<SharedView | null> {
    const view = this.current
    switch (message?.t) {
      case 'shared': {
        const info = await this.info(message.info)
        this.ids = new Set()
        const entries = await this.fresh(message.entries)
        return { ...view, ...info, connection: 'connected', status: status(message.status) ?? view.status, entries }
      }
      case 'shared_info':
        return { ...view, ...(await this.info(message.info)) }
      case 'shared_entries': {
        if (message.reset) this.ids = new Set()
        const entries = await this.fresh(message.entries)
        return { ...view, entries: message.reset ? entries : [...(view.entries ?? []), ...entries] }
      }
      case 'shared_status':
        return { ...view, status: status(message.status) ?? view.status }
      case 'share_ended':
        return { ...view, connection: 'ended' }
      default:
        return null
    }
  }

  private async info(sealed: string | null): Promise<Pick<SharedView, 'project' | 'title' | 'tool'> | Record<string, never>> {
    if (typeof sealed !== 'string') return {}
    try {
      const info = await open<Record<string, unknown>>(this.options.key, sealed)
      if (typeof info?.project !== 'string') return {}
      return {
        project: info.project,
        title: typeof info.title === 'string' ? info.title : null,
        tool: info.tool === 'opencode' ? 'opencode' : null,
      }
    } catch {
      return {}
    }
  }

  private async fresh(sealed: unknown): Promise<Entry[]> {
    if (!Array.isArray(sealed)) return []
    const unseen = (sealed as SealedEntry[]).filter(entry => typeof entry?.id === 'string' && !this.ids.has(entry.id))
    for (const entry of unseen) this.ids.add(entry.id)
    return this.vault.entries(unseen)
  }

  private scheduleReconnect(generation: number) {
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    this.retry = setTimeout(() => {
      if (generation === this.generation) this.open()
    }, delay)
  }

  private set(view: SharedView) {
    this.current = view
    this.options.onChange(view)
  }
}

const status = (value: unknown): SessionStatus | null =>
  typeof value === 'string' && value in STATUS_LABELS ? (value as SessionStatus) : null
