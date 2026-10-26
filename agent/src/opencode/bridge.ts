import { basename } from 'node:path'
import type { Entry, SealedEntry, SessionInfo } from '../../../shared/protocol'
import { RelayConnection } from '../channel/relay-connection'
import { type AgentConfig, loadConfig } from '../config'
import { seal } from '../crypto'
import { postHook } from '../hook'
import { log } from '../log'
import { OpenCodeTracker, type SessionUpdate } from './events'

const BACKLOG_SIZE = 400

/** One OpenCode session as the relay sees it: its own connection, like the channel of a Claude Code session. */
class Link {
  private entries: Entry[] = []
  private readonly relay: RelayConnection

  constructor(
    readonly sessionId: string,
    private readonly config: AgentConfig,
    private readonly tracker: OpenCodeTracker,
  ) {
    this.relay = new RelayConnection(config, 'channel', { connected: () => this.announce(), message: () => {} })
    this.relay.connect()
  }

  add(entries: Entry[]) {
    this.entries = [...this.entries, ...entries].slice(-BACKLOG_SIZE)
    if (entries.length)
      this.relay.post(async () => ({ t: 'entries', sessionId: this.sessionId, entries: await this.seal(entries), reset: false }))
  }

  postMeta() {
    this.relay.post(async () => ({
      t: 'meta',
      sessionId: this.sessionId,
      meta: await seal(this.config.key, this.tracker.meta(this.sessionId)),
    }))
  }

  stop() {
    this.relay.stop()
  }

  flushed(): Promise<void> {
    return this.relay.flushed()
  }

  /** Everything the relay needs after a (re)connection. Sending messages to OpenCode sessions comes later: no channel. */
  private announce() {
    const cwd = this.tracker.cwd(this.sessionId) ?? process.cwd()
    const project = basename(cwd.replace(/\\/g, '/').replace(/\/+$/, '')) || cwd
    const info: SessionInfo = { machine: this.config.machine, platform: process.platform, cwd, project, tool: 'opencode' }
    const { sessionId } = this
    this.relay.post(async () => ({ t: 'hello', sessionId, info: await seal(this.config.key, info), channel: false }))
    this.relay.post(async () => ({ t: 'entries', sessionId, entries: await this.seal(this.entries), reset: true }))
    this.postMeta()
  }

  private seal(entries: Entry[]): Promise<SealedEntry[]> {
    return Promise.all(entries.map(async entry => ({ id: entry.id, ts: entry.ts, blob: await seal(this.config.key, entry) })))
  }
}

/**
 * Started by Tonton's OpenCode plugin, one per OpenCode process: reads its events as JSON lines on stdin and keeps the
 * relay in sync with each of its sessions. Ends with OpenCode, when stdin closes.
 */
export async function runOpenCode() {
  const config = loadConfig()
  if (!config) {
    log('opencode: not enrolled, staying idle')
    for await (const _ of Bun.stdin.stream());
    return
  }
  log('opencode bridge started', { parent: process.ppid, cwd: process.cwd() })
  const tracker = new OpenCodeTracker()
  const links = new Map<string, Link>()
  // Status changes go out in order, each after the previous one.
  let statuses: Promise<void> = Promise.resolve()

  const apply = (update: SessionUpdate) => {
    let link = links.get(update.sessionId)
    if (!link) {
      link = new Link(update.sessionId, config, tracker)
      links.set(update.sessionId, link)
    }
    link.add(update.entries)
    if (update.metaChanged) link.postMeta()
    const { status } = update
    if (status) {
      const event = { hook_event_name: status.hook, session_id: update.sessionId, notification_type: status.notificationType }
      statuses = statuses.then(() => postHook(config, event, status.text)).catch(error => log('opencode: status failed', String(error)))
    }
  }

  for await (const line of lines(Bun.stdin.stream())) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    for (const update of tracker.handle(event)) apply(update)
  }

  // OpenCode exited: its sessions end with it.
  log('opencode bridge: OpenCode exited')
  await statuses
  await Promise.all(
    [...links.values()].map(async link => {
      await postHook(config, { hook_event_name: 'SessionEnd', session_id: link.sessionId }).catch(() => {})
      await link.flushed()
      link.stop()
    }),
  )
  process.exit(0)
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) yield line
      newline = buffer.indexOf('\n')
    }
  }
  if (buffer.trim()) yield buffer.trim()
}
