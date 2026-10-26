// A client's live view of an account: one WebSocket to the relay, reconnected with backoff, whose messages are opened with
// the account key and folded into an immutable state. UI-agnostic, so the web, Windows and Linux apps only render it.
// Mirrors RelaySocket.swift and SessionStore.swift.

import type { AppMessage, Entry, ModelAlias, RelayToApp, SessionCommand, StartDetail } from './protocol'
import { type Machine, type Session, sortSessions } from './session'
import type { OutgoingImage, Vault } from './vault'
import { parseRelayMessage } from './wire'

export type ConnectionState = 'connecting' | 'connected' | 'offline' | 'stopped'

export interface ClientState {
  connection: ConnectionState
  /** Live first, then the most recently active. Empty until the first snapshot. */
  sessions: Session[]
  machines: Machine[]
  /** The session whose conversation the relay sends. */
  selectedId: string | null
  /** The conversation of the selected session, null until its history arrives. */
  entries: Entry[] | null
  /** The last error the relay reported, such as a message a session could not take. */
  error: string | null
}

/** What a relay message says once opened. */
export type ClientEvent =
  | { t: 'snapshot'; sessions: Session[]; machines: Machine[] }
  | { t: 'session'; session: Session }
  | { t: 'removed'; sessionId: string }
  | { t: 'machines'; machines: Machine[] }
  | { t: 'history'; sessionId: string; entries: Entry[] }
  | { t: 'entries'; sessionId: string; entries: Entry[] }
  | { t: 'error'; message: string }
  | { t: 'agent_update'; machineId: string; ok: boolean; reason?: 'offline' | 'unsupported'; detail: string | null }
  | { t: 'session_start'; machineId: string; launchId: string; state: string; reason?: 'offline'; detail: StartDetail | null }

export const initialState: ClientState = {
  connection: 'stopped',
  sessions: [],
  machines: [],
  selectedId: null,
  entries: null,
  error: null,
}

/** Opens the sealed fields of a relay message. Machines come first: sessions fall back to their names. */
export async function openMessage(vault: Vault, message: RelayToApp, machines: readonly Machine[]): Promise<ClientEvent> {
  switch (message.t) {
    case 'snapshot': {
      const opened = await vault.machines(message.machines)
      return { t: 'snapshot', machines: opened, sessions: await Promise.all(message.sessions.map(s => vault.session(s, opened))) }
    }
    case 'session':
      return { t: 'session', session: await vault.session(message.session, machines) }
    case 'machines':
      return { t: 'machines', machines: await vault.machines(message.machines) }
    case 'history':
      return { t: 'history', sessionId: message.sessionId, entries: await vault.entries(message.entries) }
    case 'entries':
      return { t: 'entries', sessionId: message.sessionId, entries: await vault.entries(message.entries) }
    case 'agent_update':
      return { ...message, detail: await vault.detailText(message.detail) }
    case 'session_start':
      return { ...message, detail: await vault.startDetail(message.detail) }
    case 'removed':
    case 'error':
      return message
  }
}

/** The next state. Pure: the state passed in is never changed. */
export function reduce(state: ClientState, event: ClientEvent): ClientState {
  switch (event.t) {
    case 'snapshot':
      return { ...state, sessions: sortSessions(event.sessions), machines: event.machines }
    case 'session': {
      const others = state.sessions.filter(s => s.id !== event.session.id)
      return { ...state, sessions: sortSessions([...others, event.session]) }
    }
    case 'removed': {
      const selected = state.selectedId === event.sessionId
      return {
        ...state,
        sessions: state.sessions.filter(s => s.id !== event.sessionId),
        ...(selected ? { selectedId: null, entries: null } : {}),
      }
    }
    case 'machines':
      return { ...state, machines: event.machines }
    case 'history':
      return event.sessionId === state.selectedId ? { ...state, entries: event.entries } : state
    case 'entries':
      // Entries that come before the history are in it.
      if (event.sessionId !== state.selectedId || !state.entries) return state
      return { ...state, entries: [...state.entries, ...event.entries] }
    case 'error':
      return { ...state, error: event.message }
    case 'agent_update':
    case 'session_start':
      return state
  }
}

/** The part of a WebSocket the client uses: the browser's, Bun's or Node's. */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface RelayClientOptions {
  vault: Vault
  /** Opens a socket to the relay's `/ws/app`, authenticated the way the platform allows. */
  connect: () => SocketLike
  onChange: (state: ClientState) => void
  /** Every event once opened, for what the state does not keep (starts, agent updates). */
  onEvent?: (event: ClientEvent) => void
  /** Called when the relay closes the socket for good (code 4001: signed out, revoked or deleted). */
  onSignedOut?: () => void
  /** The first delay before reconnecting, doubled after each failure up to 30 seconds. */
  retryMs?: number
}

const MAX_BACKOFF_MS = 30_000
/** The relay closes sockets with this code when their credential stops being valid. */
const SIGNED_OUT = 4001

export class RelayClient {
  private current: ClientState = initialState
  private socket: SocketLike | null = null
  private generation = 0
  private backoff: number
  private retry: ReturnType<typeof setTimeout> | null = null
  /** Opening is asynchronous: messages go through this chain to be applied in the order they came. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: RelayClientOptions) {
    this.backoff = this.firstDelay
  }

  get state(): ClientState {
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
    this.backoff = this.firstDelay
    if (this.current.connection !== 'stopped') this.set({ ...this.current, connection: 'stopped' })
  }

  /** Asks the relay for the session's conversation, and its new entries from then on. */
  select(sessionId: string | null) {
    if (sessionId === this.current.selectedId) return
    this.set({ ...this.current, selectedId: sessionId, entries: null })
    this.send({ t: 'subscribe', sessionId })
  }

  /** False when the client is not connected: nothing was sent. */
  async sendPrompt(sessionId: string, text: string, images: readonly OutgoingImage[] = []): Promise<boolean> {
    return this.send({ t: 'prompt', sessionId, payload: await this.options.vault.sealPrompt(text, images) })
  }

  /** A slash command its agent types in the session's terminal; `model` switches the model with the `model` command. */
  async sendCommand(sessionId: string, name: SessionCommand['name'], model?: ModelAlias): Promise<boolean> {
    return this.send({ t: 'prompt', sessionId, payload: await this.options.vault.sealCommand(name, sessionId, { model }) })
  }

  answer(sessionId: string, requestId: string, allow: boolean): boolean {
    return this.send({ t: 'verdict', sessionId, requestId, behavior: allow ? 'allow' : 'deny' })
  }

  /** Removes a finished session from the account's list. */
  dismiss(sessionId: string): boolean {
    return this.send({ t: 'dismiss', sessionId })
  }

  clearError() {
    if (this.current.error) this.set({ ...this.current, error: null })
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
    this.set({ ...this.current, connection: 'connecting' })
    socket.onmessage = event => {
      if (generation !== this.generation || typeof event.data !== 'string') return
      const raw = event.data
      // A listener that throws is reported like an event handler's error, without breaking the chain.
      this.queue = this.queue
        .then(() => this.receive(raw, generation))
        .catch(error =>
          queueMicrotask(() => {
            throw error
          }),
        )
    }
    socket.onclose = event => {
      if (generation !== this.generation) return
      this.socket = null
      if (event.code === SIGNED_OUT) {
        this.generation++
        this.set({ ...this.current, connection: 'stopped' })
        this.options.onSignedOut?.()
        return
      }
      this.set({ ...this.current, connection: 'offline' })
      this.scheduleReconnect(generation)
    }
    socket.onerror = () => {}
  }

  private async receive(raw: string, generation: number) {
    const message = parseRelayMessage(raw)
    if (!message) return
    const event = await openMessage(this.options.vault, message, this.current.machines)
    if (generation !== this.generation) return
    if (this.current.connection !== 'connected') {
      // The snapshot comes first on every connection: the relay forgot what this socket watched.
      this.backoff = this.firstDelay
      this.set({ ...this.current, connection: 'connected' })
      if (this.current.selectedId) this.send({ t: 'subscribe', sessionId: this.current.selectedId })
    }
    this.set(reduce(this.current, event))
    this.options.onEvent?.(event)
  }

  private scheduleReconnect(generation: number) {
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    this.retry = setTimeout(() => {
      if (generation === this.generation) this.open()
    }, delay)
  }

  private send(message: AppMessage): boolean {
    if (this.current.connection !== 'connected' || !this.socket) return false
    try {
      this.socket.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  private get firstDelay(): number {
    return this.options.retryMs ?? 1000
  }

  private set(state: ClientState) {
    if (state === this.current) return
    this.current = state
    this.options.onChange(state)
  }
}
