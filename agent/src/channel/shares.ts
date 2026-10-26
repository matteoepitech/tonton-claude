// The read-only shares of one session: each gets a copy of the conversation sealed with its own key, which the app gave
// in a `ShareOrder` sealed with the account key. A teammate holding a share key reads that copy and nothing else. Used by
// the channel of a Claude Code session and by the OpenCode bridge alike.
import { open, seal } from '../../../shared/crypto'
import type { AgentMessage, Entry, SealedEntry, SharedInfo, ShareOrder } from '../../../shared/protocol'
import { log } from '../log'

type Post = (build: () => Promise<AgentMessage | null>) => void

interface Share {
  key: string
  expiresAt: number
}

export class SessionShares {
  private readonly shares = new Map<string, Share>()
  private info: SharedInfo | null = null

  constructor(
    private readonly sessionId: () => string,
    private readonly accountKey: string,
    private readonly post: Post,
    /** What a new share starts with: the conversation so far. */
    private readonly backlog: () => Entry[],
  ) {}

  /** An order from the app, through the relay: only one for this session, sealed with the account key, counts. */
  receive(shareId: string, order: string) {
    this.post(async () => {
      let opened: ShareOrder
      try {
        opened = await open<ShareOrder>(this.accountKey, order)
      } catch {
        log('dropped a share order that does not decrypt with the account key')
        return null
      }
      const expiresAt = Date.parse(opened.expiresAt)
      const valid =
        opened.shareId === shareId && opened.sessionId === this.sessionId() && typeof opened.key === 'string' && expiresAt > Date.now()
      if (!valid) {
        log('dropped a share order for another share or session')
        return null
      }
      this.shares.set(shareId, { key: opened.key, expiresAt })
      return null
    })
    // Its copy starts over: the relay may have lost it. The backlog is read once the share is known, so nothing falls
    // between the two.
    this.post(() => this.sealInfo(shareId))
    this.post(() => this.sealEntries(shareId, this.backlog(), true))
  }

  remove(shareId: string) {
    this.shares.delete(shareId)
  }

  /** New entries of the conversation, or all of them with `reset`. */
  entries(entries: Entry[], reset = false) {
    if (!this.shares.size || (!entries.length && !reset)) return
    for (const shareId of this.shares.keys()) this.post(() => this.sealEntries(shareId, entries, reset))
  }

  /** The project and the title a teammate sees. Sent when they change. */
  setInfo(info: SharedInfo) {
    if (this.info && JSON.stringify(this.info) === JSON.stringify(info)) return
    this.info = info
    for (const shareId of this.shares.keys()) this.post(() => this.sealInfo(shareId))
  }

  private live(shareId: string): Share | null {
    const share = this.shares.get(shareId)
    if (share && share.expiresAt <= Date.now()) this.shares.delete(shareId)
    return share && share.expiresAt > Date.now() ? share : null
  }

  private async sealInfo(shareId: string): Promise<AgentMessage | null> {
    const share = this.live(shareId)
    if (!share || !this.info) return null
    return { t: 'share_info', sessionId: this.sessionId(), shareId, info: await seal(share.key, this.info) }
  }

  private async sealEntries(shareId: string, entries: Entry[], reset: boolean): Promise<AgentMessage | null> {
    const share = this.live(shareId)
    if (!share) return null
    const sealed: SealedEntry[] = await Promise.all(
      entries.map(async entry => ({ id: entry.id, ts: entry.ts, blob: await seal(share.key, entry) })),
    )
    return { t: 'share_entries', sessionId: this.sessionId(), shareId, entries: sealed, reset }
  }
}
