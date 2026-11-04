import { closeSync, openSync, readSync, statSync } from 'node:fs'

const POLL_MS = 400
/** A long session can weigh hundreds of MB: only its end is read on start. */
const INITIAL_READ_BYTES = 8 * 1024 * 1024
/** How far back the start goes for a line longer than that end, a tool result of tens of MB. */
const MAX_INITIAL_READ_BYTES = 64 * 1024 * 1024

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
      this.offset = this.initialOffset(size)
      skipPartialLine = this.offset > 0
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

  /**
   * Where the first read of a large file starts. Its end can be inside one long line, which would leave nothing to show
   * but the end of that line: the start goes back, twice as far each time, until a whole line comes before the last one,
   * or the file's start, or `MAX_INITIAL_READ_BYTES`.
   */
  private initialOffset(size: number): number {
    // Newlines between `scanned` and the last byte: the first ends a line cut by the start, the second a whole one.
    let newlines = 0
    let scanned = size - 1
    for (let window = INITIAL_READ_BYTES; window < size; window *= 2) {
      const start = size - window
      const chunk = this.readFrom(start, scanned - start)
      let at = chunk.length
      while (newlines < 2 && at > 0) {
        at = chunk.lastIndexOf(0x0a, at - 1)
        if (at === -1) break
        newlines++
      }
      scanned = start
      if (newlines >= 2 || window >= MAX_INITIAL_READ_BYTES) return start
    }
    return 0
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
