// An invite to a pool, as a link or a QR code: `tontonpool1.` followed by base64url JSON of the relay, the pool id, the
// invite token and the pool key (docs/pools.md). The relay checks the token; the key lets the new member read the pool.
// Whoever holds an unused invite can join, so it is single use or short-lived, and revocable.
// Mirrors app/Sources/TontonCore/Pool.swift.

import { normalizeRelay } from './account-token'
import { base64UrlToUtf8, utf8ToBase64Url } from './base64'

export interface PoolInvite {
  relay: string
  pool: string
  /** `tp_…`: joins the pool once (or as many times as the invite allows), nothing else. */
  token: string
  /** Base64url AES-256 pool key. */
  key: string
  /** The version of the key, which changes when a member is removed. */
  version: number
}

const PREFIX = 'tontonpool1.'
const KEY = /^[A-Za-z0-9_-]{43}$/
const POOL = /^[A-Za-z0-9_-]{12}$/
const TOKEN = /^tp_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/

export function formatPoolInvite(invite: PoolInvite): string {
  const { relay, pool, token, key, version } = invite
  return PREFIX + utf8ToBase64Url(JSON.stringify({ relay, pool, token, key, v: version }))
}

/** The invite in a pasted text or after the `#` of an address, null for anything else. */
export function parsePoolInvite(text: string): PoolInvite | null {
  const trimmed = text.trim().replace(/^#/, '')
  if (!trimmed.startsWith(PREFIX)) return null
  try {
    const fields = JSON.parse(base64UrlToUtf8(trimmed.slice(PREFIX.length))) as Record<string, unknown>
    const relay = normalizeRelay(String(fields.relay ?? ''))
    const { pool, token, key, v } = fields
    if (!relay || typeof pool !== 'string' || !POOL.test(pool) || typeof token !== 'string' || !TOKEN.test(token)) return null
    if (typeof key !== 'string' || !KEY.test(key) || typeof v !== 'number' || !Number.isInteger(v) || v < 1) return null
    return { relay, pool, token, key, version: v }
  } catch {
    return null
  }
}
