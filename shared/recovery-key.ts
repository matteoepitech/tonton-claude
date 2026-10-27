// The account a browser or another Mac signs in with: the recovery key of Settings › Relay in the Mac app, `tonton1.`
// followed by base64url JSON of the account (app/Sources/TontonCore/Account.swift). Whoever holds it can read and drive
// the sessions, so it only ever stays on the device that pasted it.

import { normalizeRelay } from './account-token'
import { base64UrlToUtf8, utf8ToBase64Url } from './base64'
import type { SocketLike } from './client'

export interface RecoveredAccount {
  relay: string
  accountId: string
  /** `ta_…`, the app's bearer token. */
  token: string
  /** Base64url AES-256 key. */
  key: string
  /** Lets machines join the account (shared/account-token.ts). Only in keys exported once the account token existed. */
  joinSecret?: string
}

const PREFIX = 'tonton1.'
const KEY = /^[A-Za-z0-9_-]{43}$/
const TOKEN = /^[A-Za-z0-9_.-]{8,200}$/

export function parseRecoveryKey(text: string): RecoveredAccount | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(PREFIX)) return null
  try {
    const account = JSON.parse(base64UrlToUtf8(trimmed.slice(PREFIX.length))) as Partial<Record<keyof RecoveredAccount, unknown>>
    const relay = normalizeRelay(String(account.relay ?? ''))
    const { accountId, token, key, joinSecret } = account
    if (!relay || typeof accountId !== 'string' || typeof token !== 'string' || !TOKEN.test(token) || typeof key !== 'string') return null
    if (!KEY.test(key)) return null
    // A join secret of the wrong shape is left out: the account still signs in, only adding machines needs it.
    const recovered = { relay, accountId, token, key }
    return typeof joinSecret === 'string' && KEY.test(joinSecret) ? { ...recovered, joinSecret } : recovered
  } catch {
    return null
  }
}

/** The recovery key of an account, as `Account.recoveryKey` writes it: the Mac app restores what this returns. */
export function encodeRecoveryKey(account: RecoveredAccount): string {
  const { relay, accountId, token, key, joinSecret } = account
  return PREFIX + utf8ToBase64Url(JSON.stringify({ relay, accountId, token, key, ...(joinSecret ? { joinSecret } : {}) }))
}

/** The relay's WebSocket endpoint for apps. */
export const appSocketUrl = (relay: string): string => `${relay.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws/app`

/**
 * A browser's socket to the relay's app endpoint. Browsers cannot set the Authorization header of a WebSocket, so the
 * token goes as a subprotocol next to `tonton`, which the relay answers with (relay/src/http.ts).
 */
export function browserSocket(relay: string, token: string, open: (url: string, protocols: string[]) => SocketLike): SocketLike {
  return open(appSocketUrl(relay), ['tonton', `bearer.${token}`])
}
