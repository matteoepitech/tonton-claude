// An invite to a cluster, as a link or a QR code: `tontoncluster1.` followed by base64url JSON of the relay, the cluster
// id, the invite token and the cluster key (docs/cluster.md). The relay checks the token; the key lets the new member read
// the cluster. Whoever holds an unused invite can join, so it is single use or short-lived, and revocable.
// Mirrors app/Sources/TontonCore/Cluster.swift.

import { normalizeRelay } from './account-token'
import { base64UrlToUtf8, utf8ToBase64Url } from './base64'

export interface ClusterInvite {
  relay: string
  cluster: string
  /** `tc_…`: joins the cluster once (or as many times as the invite allows), nothing else. */
  token: string
  /** Base64url AES-256 cluster key. */
  key: string
  /** The version of the key, which changes when a member is removed. */
  version: number
}

const PREFIX = 'tontoncluster1.'
const KEY = /^[A-Za-z0-9_-]{43}$/
const CLUSTER = /^[A-Za-z0-9_-]{12}$/
const TOKEN = /^tc_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/

export function formatClusterInvite(invite: ClusterInvite): string {
  const { relay, cluster, token, key, version } = invite
  return PREFIX + utf8ToBase64Url(JSON.stringify({ relay, cluster, token, key, v: version }))
}

/** The invite as a link to the relay's website: it stays after the `#`, which browsers never send. */
export const clusterInviteLink = (invite: ClusterInvite): string => `${invite.relay}/#${formatClusterInvite(invite)}`

/** The invite in a pasted text, a link to the website or after the `#` of an address, null for anything else. */
export function parseClusterInvite(text: string): ClusterInvite | null {
  const trimmed = text.trim().slice(text.trim().lastIndexOf('#') + 1)
  if (!trimmed.startsWith(PREFIX)) return null
  try {
    const fields = JSON.parse(base64UrlToUtf8(trimmed.slice(PREFIX.length))) as Record<string, unknown>
    const relay = normalizeRelay(String(fields.relay ?? ''))
    const { cluster, token, key, v } = fields
    if (!relay || typeof cluster !== 'string' || !CLUSTER.test(cluster) || typeof token !== 'string' || !TOKEN.test(token)) return null
    if (typeof key !== 'string' || !KEY.test(key) || typeof v !== 'number' || !Number.isInteger(v) || v < 1) return null
    return { relay, cluster, token, key, version: v }
  } catch {
    return null
  }
}
