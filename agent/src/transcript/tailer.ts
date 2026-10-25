import { closeSync, openSync, readSync, statSync } from 'node:fs'

const POLL_MS = 400
/** A long session can weigh hundreds of MB: only its end is read on start. */
const INITIAL_READ_BYTES = 8 * 1024 * 1024

export interface TailerEvents {
  /** Complete lines appended since the last call. `initial` is true for the first read. */
  lines(lines: string[], initial: boolean): void
  /** The file was truncated or replaced; history starts over. */
  reset(): void
}

/** Follows a growing file by polling, which behaves the same on every OS, unlike fs.watch. */
export class Tailer {
  private offset = 0
  private pending: Buffer = Buffer.alloc(0)
  private timer: Timer | null = null
  private started = false

  constructor(
    private readonly path: string,
    private readonly events: TailerEvents,
  ) {}

  start() {
    this.read()
    this.timer = setInterval(() => this.read(), POLL_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private read() {
    const initial = !this.started
    this.started = true
    let size: number
    try {
      size = statSync(this.path).size
    } catch {
      if (initial) this.events.lines([], true)
      return
    }

    let skipPartialLine = false
    if (size < this.offset) {
      this.offset = 0
      this.pending = Buffer.alloc(0)
      this.events.reset()
    }
    if (initial && size > INITIAL_READ_BYTES) {
      this.offset = size - INITIAL_READ_BYTES
      skipPartialLine = true
    }
    if (size === this.offset) {
      if (initial) this.events.lines([], true)
      return
    }

    const chunk = this.readFrom(this.offset, size - this.offset)
    this.offset += chunk.length
    let data = Buffer.concat([this.pending, chunk])
    if (skipPartialLine) data = data.subarray(data.indexOf(0x0a) + 1)

    // Decode only up to the last newline so a multi-byte character is never split.
    const end = data.lastIndexOf(0x0a)
    this.pending = Buffer.from(end === -1 ? data : data.subarray(end + 1))
    const lines = end === -1 ? [] : data.subarray(0, end).toString('utf8').split('\n')
    this.events.lines(
      lines.filter(line => line.trim()),
      initial,
    )
  }

  private readFrom(position: number, length: number): Buffer {
    const fd = openSync(this.path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const read = readSync(fd, buffer, 0, length, position)
      return buffer.subarray(0, read)
    } finally {
      closeSync(fd)
    }
  }
}
