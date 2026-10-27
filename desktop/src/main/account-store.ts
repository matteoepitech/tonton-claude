// The account this computer remembers: its recovery key, encrypted by the system's keyring (Electron's safeStorage: DPAPI
// on Windows, the Secret Service or KWallet on Linux) in one file of the app's data folder. Without a keyring nothing is
// written, and the account lasts until the island quits.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { encodeRecoveryKey, parseRecoveryKey, type RecoveredAccount } from '../../../shared/recovery-key'

/** safeStorage, or a stand-in for tests. */
export interface Keyring {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

export class AccountStore {
  constructor(
    private readonly file: string,
    private readonly keyring: Keyring,
  ) {}

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

  /** False when the account could not be kept. */
  save(account: RecoveredAccount): boolean {
    if (!this.keyring.available()) return false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, this.keyring.encrypt(encodeRecoveryKey(account)), { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }

  forget() {
    rmSync(this.file, { force: true })
  }
}
