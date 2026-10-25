import { basename } from 'node:path'
import type { AgentMessage, Entry, PermissionDetail, SealedEntry } from '../../../shared/protocol'
import { seal } from '../crypto'
import { parseLine } from '../transcript/parser'
import { Tailer } from '../transcript/tailer'
import type { SessionLink } from './session-link'

const BACKLOG_SIZE = 400
/** On reconnect only the latest entries keep their images, the rest is sent as text. */
const BACKLOG_IMAGES = 40

type Post = (build: () => Promise<AgentMessage | null>) => void

interface PendingPermission extends PermissionDetail {
  ts: string
}

/** State of the session this channel serves, and the messages that keep the relay in sync with it. */
export class Conversation {
  private entries: Entry[] = []
  private title: string | undefined
  private costUSD: number | undefined
  private readonly pending = new Map<string, PendingPermission>()
  private readonly tailer: Tailer | null

  constructor(
    readonly link: SessionLink,
    private readonly machine: string,
    private readonly key: string,
    private readonly canChat: boolean,
    private readonly post: Post,
  ) {
    this.tailer = link.transcriptPath
      ? new Tailer(link.transcriptPath, {
          lines: (lines, initial) => this.onLines(lines, initial),
          reset: () => {
            this.entries = []
          },
        })
      : null
  }

  start() {
    if (this.tailer) this.tailer.start()
    else this.announce()
  }

  stop() {
    this.tailer?.stop()
  }

  /** Everything the relay needs after a (re)connection. */
  announce() {
    const { sessionId } = this.link
    const cwd = this.link.cwd ?? process.cwd()
    const project = basename(cwd.replace(/\\/g, '/').replace(/\/+$/, '')) || cwd
    const backlog = withoutOldImages(this.entries)
    const info = { machine: this.machine, platform: process.platform, cwd, project }
    this.post(async () => ({ t: 'hello', sessionId, info: await seal(this.key, info), channel: this.canChat }))
    this.post(async () => ({ t: 'entries', sessionId, entries: await this.sealEntries(backlog), reset: true }))
    this.postMeta()
    for (const requestId of this.pending.keys()) this.postPermission(requestId)
  }

  addPermission(requestId: string, detail: PermissionDetail) {
    this.pending.set(requestId, { ...detail, ts: new Date().toISOString() })
    this.postPermission(requestId)
  }

  resolvePermission(requestId: string) {
    this.pending.delete(requestId)
  }

  private onLines(lines: string[], initial: boolean) {
    const fresh: Entry[] = []
    let metaChanged = false
    for (const line of lines) {
      const parsed = parseLine(line)
      fresh.push(...parsed.entries)
      if (parsed.title !== undefined && parsed.title !== this.title) {
        this.title = parsed.title
        metaChanged = true
      }
      if (parsed.costUSD !== undefined && parsed.costUSD !== this.costUSD) {
        this.costUSD = parsed.costUSD
        metaChanged = true
      }
    }
    this.entries = [...this.entries, ...fresh].slice(-BACKLOG_SIZE)
    if (initial) return this.announce()

    const { sessionId } = this.link
    if (fresh.length) this.post(async () => ({ t: 'entries', sessionId, entries: await this.sealEntries(fresh), reset: false }))
    if (metaChanged || fresh.some(e => e.kind === 'assistant' || e.kind === 'user')) this.postMeta()

    // Once the tool ran or the turn moved on, a relayed prompt was answered (here or in the terminal).
    if (this.pending.size && fresh.some(e => e.kind === 'tool_result' || e.kind === 'user')) {
      for (const requestId of this.pending.keys()) this.post(async () => ({ t: 'permission_closed', sessionId, requestId }))
      this.pending.clear()
    }
  }

  private postMeta() {
    const last = this.entries.findLast(e => e.kind === 'assistant' || e.kind === 'user')
    const meta = { title: this.title, costUSD: this.costUSD, lastMessage: last && 'text' in last ? last.text.slice(0, 200) : undefined }
    this.post(async () => ({ t: 'meta', sessionId: this.link.sessionId, meta: await seal(this.key, meta) }))
  }

  private postPermission(requestId: string) {
    const permission = this.pending.get(requestId)
    if (!permission) return
    const { ts, ...detail } = permission
    this.post(async () => ({
      t: 'permission',
      sessionId: this.link.sessionId,
      request: { requestId, ts, blob: await seal(this.key, detail) },
    }))
  }

  private sealEntries(entries: Entry[]): Promise<SealedEntry[]> {
    return Promise.all(entries.map(async entry => ({ id: entry.id, ts: entry.ts, blob: await seal(this.key, entry) })))
  }
}

function withoutOldImages(entries: Entry[]): Entry[] {
  const keepFrom = entries.length - BACKLOG_IMAGES
  return entries.map((entry, index) => {
    if (index >= keepFrom || !('images' in entry) || !entry.images?.length) return entry
    const { images, ...rest } = entry
    return { ...rest, text: `${rest.text}\n[${images.length} image${images.length === 1 ? '' : 's'} not loaded]` } as Entry
  })
}
