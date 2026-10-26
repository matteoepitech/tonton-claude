// The sealed copies of shared sessions, in memory: what a teammate who opens a read-only share is shown. The agent seals
// them with the share's own key, so the relay reads them no more than the rest, and sends them again whenever it
// reconnects: nothing here needs to survive a restart.
import type { Sealed, SealedEntry } from '../../shared/protocol'
import { MAX_ENTRIES_PER_SESSION, MAX_SHARE_BYTES } from './limits'

interface Stream {
  info: Sealed | null
  entries: SealedEntry[]
  ids: Set<string>
  bytes: number
}

export class ShareStreams {
  private readonly streams = new Map<string, Stream>()

  get(shareId: string): { info: Sealed | null; entries: SealedEntry[] } {
    const stream = this.streams.get(shareId)
    return { info: stream?.info ?? null, entries: stream?.entries ?? [] }
  }

  setInfo(shareId: string, info: Sealed) {
    this.stream(shareId).info = info
  }

  /** Appends entries and returns the ones that were new. `reset` replaces the whole copy. Oldest go first. */
  addEntries(shareId: string, entries: SealedEntry[], reset: boolean): SealedEntry[] {
    const stream = this.stream(shareId)
    if (reset) {
      stream.entries = []
      stream.ids.clear()
      stream.bytes = 0
    }
    const fresh = entries.filter(entry => !stream.ids.has(entry.id))
    for (const entry of fresh) {
      stream.entries.push(entry)
      stream.ids.add(entry.id)
      stream.bytes += entry.blob.length
    }
    while (stream.entries.length > MAX_ENTRIES_PER_SESSION || (stream.bytes > MAX_SHARE_BYTES && stream.entries.length > 1)) {
      const dropped = stream.entries.shift()
      if (!dropped) break
      stream.ids.delete(dropped.id)
      stream.bytes -= dropped.blob.length
    }
    return fresh
  }

  drop(shareId: string) {
    this.streams.delete(shareId)
  }

  private stream(shareId: string): Stream {
    let stream = this.streams.get(shareId)
    if (!stream) {
      stream = { info: null, entries: [], ids: new Set(), bytes: 0 }
      this.streams.set(shareId, stream)
    }
    return stream
  }
}
