// The account this computer remembers: its recovery key, encrypted by the system's keyring (Electron's safeStorage: DPAPI
// on Windows, the Secret Service or KWallet on Linux) in one file of the app's data folder. Without a keyring nothing is
// written, and the account lasts until the island quits.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { encodeRecoveryKey, parseRecoveryKey, type RecoveredAccount } from '../../../shared/recovery-key'

/** safeStorage, or a stand-in for tests. */
export interface Keyring {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

/** On Windows, an antivirus or the search indexer reading the file makes moving it fail for a moment. */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
const MOVE_ATTEMPTS = 5
const MOVE_RETRY_MS = 50

export class AccountStore {
  constructor(
    private readonly file: string,
    private readonly keyring: Keyring,
    /** renameSync, or a stand-in for tests. */
    private readonly rename: (from: string, to: string) => void = renameSync,
  ) {}

  private get next(): string {
    return `${this.file}.next`
  }

  get canRemember(): boolean {
    return this.keyring.available()
  }

  /** Null when nothing was saved, or when it no longer opens (another user, a reset keyring): it is then removed. */
  load(): RecoveredAccount | null {
    if (!existsSync(this.file) || !this.keyring.available()) return null
    try {
      const account = parseRecoveryKey(this.keyring.decrypt(readFileSync(this.file)))
      if (account) return account
    } catch {}
    this.forget()
    return null
  }

  /** False when the account could not be kept: the file saved before, if any, is left as it was. */
  save(account: RecoveredAccount): boolean {
    if (!this.keyring.available()) return false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      // Written aside, then moved over: a crash halfway leaves the previous file, not a truncated one that signs out.
      writeFileSync(this.next, this.keyring.encrypt(encodeRecoveryKey(account)), { mode: 0o600 })
      this.move()
      return true
    } catch {
      try {
        rmSync(this.next, { force: true })
      } catch {}
      return false
    }
  }

  /**
   * After signing in: kept when asked to. Not remembering it also forgets the account kept before. Failing to keep it
   * does not: the account saved before, if any, still opens at the next start.
   */
  keep(account: RecoveredAccount, remember: boolean): boolean {
    if (remember) return this.save(account)
    this.forget()
    return false
  }

  forget() {
    rmSync(this.file, { force: true })
    rmSync(this.next, { force: true })
  }

  /** A few tries, a fifth of a second at most: this blocks the main process, which runs the island's window. */
  private move() {
    for (let attempt = 1; ; attempt++) {
      try {
        this.rename(this.next, this.file)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= MOVE_ATTEMPTS || !code || !BUSY.has(code)) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, MOVE_RETRY_MS)
      }
    }
  }
}
