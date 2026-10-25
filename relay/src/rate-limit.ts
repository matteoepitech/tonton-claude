/** Fixed-window counter per key (the client IP). Enough to stop brute force and sign-up floods on one relay. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit. Returns false once the key went over the limit. */
  hit(key: string): boolean {
    const entry = this.entry(key)
    entry.count++
    return entry.count <= this.limit
  }

  isBlocked(key: string): boolean {
    return this.entry(key).count > this.limit
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.hits) if (entry.resetAt < now) this.hits.delete(key)
  }

  private entry(key: string) {
    const now = Date.now()
    let entry = this.hits.get(key)
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + this.windowMs }
      this.hits.set(key, entry)
    }
    return entry
  }
}
