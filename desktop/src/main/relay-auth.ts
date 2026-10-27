// The page's socket to the relay gets the account's bearer token here, in the main process, as the Authorization header
// of its handshake: the token never enters the page, and any relay takes it, older ones too (browsers can only send it as
// a subprotocol, which needs a relay from 0.8.0). Sockets to anywhere else are refused.

import type { Session } from 'electron'
import { appSocketUrl, type RecoveredAccount } from '../../../shared/recovery-key'

export type SocketDecision = { cancel: true } | { cancel: false; requestHeaders: Record<string, string> }

export function socketHeaders(url: string, account: RecoveredAccount | null, headers: Record<string, string>): SocketDecision {
  if (!account || !sameUrl(url, appSocketUrl(account.relay))) return { cancel: true }
  return { cancel: false, requestHeaders: { ...headers, Authorization: `Bearer ${account.token}` } }
}

export function authorizeRelaySocket(session: Session, account: () => RecoveredAccount | null) {
  session.webRequest.onBeforeSendHeaders({ urls: ['ws://*/*', 'wss://*/*'] }, (details, callback) => {
    callback(socketHeaders(details.url, account(), details.requestHeaders))
  })
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href
  } catch {
    return false
  }
}
