// Orders from the app run once per machine, whichever of its processes gets them (the service or a session's channel)
// and even after a restart: each order id is claimed with a file, kept while the order could still be replayed.

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** `taken` if a process of the machine already claimed the id. Ids must be safe as file names. */
export function claimOnce(folder: string, id: string, keepMs: number, now = Date.now()): 'claimed' | 'taken' | Error {
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
  } catch (error) {
    return asError(error)
  }
  for (const file of readdirSync(folder)) {
    // Another process may clear the same old claims at the same time.
    try {
      if (now - statSync(join(folder, file)).mtimeMs > keepMs) rmSync(join(folder, file), { force: true })
    } catch {}
  }
  try {
    writeFileSync(join(folder, id), '', { flag: 'wx', mode: 0o600 })
    return 'claimed'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'taken' : asError(error)
  }
}

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
