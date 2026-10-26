// A read-only share of one session, as a teammate pastes it in the web app: `tontonshare1.` followed by base64url JSON of
// the relay, the share's token and the share's own key (app/Sources/TontonCore/Share.swift). It opens that session's
// conversation and nothing else: no account key, no other session, no way to write.

import { normalizeRelay } from './account-token'
import { base64UrlToUtf8 } from './base64'
import type { SocketLike } from './client'

export interface ShareLink {
  relay: string
  /** `ts_…`, opens the share's socket only. */
  token: string
  /** Base64url AES-256 key of the share. */
  key: string
}

const PREFIX = 'tontonshare1.'
const KEY = /^[A-Za-z0-9_-]{43}$/
const TOKEN = /^ts_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/

export function parseShareLink(text: string): ShareLink | null {
  const trimmed = text.trim().replace(/^#/, '')
  if (!trimmed.startsWith(PREFIX)) return null
  try {
    const link = JSON.parse(base64UrlToUtf8(trimmed.slice(PREFIX.length))) as Partial<Record<keyof ShareLink, unknown>>
    const relay = normalizeRelay(String(link.relay ?? ''))
    const { token, key } = link
    if (!relay || typeof token !== 'string' || !TOKEN.test(token) || typeof key !== 'string' || !KEY.test(key)) return null
    return { relay, token, key }
  } catch {
    return null
  }
}

/** A browser's socket to the share, with the token as a subprotocol, as for the app's (shared/recovery-key.ts). */
export function shareSocket(link: ShareLink, open: (url: string, protocols: string[]) => SocketLike): SocketLike {
  const url = `${link.relay.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws/share`
  return open(url, ['tonton', `bearer.${link.token}`])
}
