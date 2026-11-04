// The relay's HTTP calls the island makes, from the main process: creating an account, checking a recovery key, the
// join secret of the account token, and the few cluster routes the page needs. Like RelayAPI.swift. The end-to-end key is
// made here and never sent.

import { encodeAccountToken } from '../../../shared/account-token'
import { newAccountKey } from '../../../shared/crypto'
import type { RecoveredAccount } from '../../../shared/recovery-key'
import { RELEASES_URL } from '../../../shared/version'
import type { ClusterAnswer, ClusterCall } from '../bridge'

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export class RelayError extends Error {}

export async function createAccount(relay: string, fetcher: Fetch): Promise<RecoveredAccount> {
  const created = await call<{ accountId?: unknown; token?: unknown }>(fetcher, 'POST', relay, '/api/accounts', null)
  if (typeof created.accountId !== 'string' || typeof created.token !== 'string') throw new RelayError('The relay sent an odd answer.')
  const account: RecoveredAccount = { relay, accountId: created.accountId, token: created.token, key: newAccountKey() }
  // Machines join with the account token: ask for it now, like the Mac app's Machines pane does when it opens.
  const secret = await joinSecret(account, fetcher).catch(() => null)
  return secret ? { ...account, joinSecret: secret } : account
}

/** Throws when the account is no longer valid on its relay, or when the relay cannot be reached. */
export async function verifyAccount(account: RecoveredAccount, fetcher: Fetch): Promise<void> {
  await call(fetcher, 'GET', account.relay, '/api/ping', account.token)
}

/** The join secret of the account token. The relay refuses when the account already has one: it is on the Mac that made it. */
export async function joinSecret(account: RecoveredAccount, fetcher: Fetch): Promise<string> {
  const body = await call<{ secret?: unknown }>(fetcher, 'POST', account.relay, '/api/account/token', account.token, { regenerate: false })
  if (typeof body.secret !== 'string') throw new RelayError('The relay sent an odd answer.')
  return body.secret
}

/** The token machines join the account with (Settings › Machines in the Mac app). Null without the join secret. */
export function machineToken(account: RecoveredAccount): string | null {
  if (!account.joinSecret) return null
  return encodeAccountToken({ relay: account.relay, account: account.accountId, secret: account.joinSecret, key: account.key })
}

/** The command that installs the agent on a machine and joins it to the account, as InstallCommand.swift writes it. */
export function installCommand(platform: 'windows' | 'unix', token: string): string {
  const releases = `${RELEASES_URL}/latest/download`
  return platform === 'windows'
    ? `$env:TONTON_TOKEN='${token}'; irm ${releases}/install.ps1 | iex`
    : `curl -fsSL ${releases}/install.sh | TONTON_TOKEN='${token}' sh`
}

const CLUSTER_MEMBERS = /^\/api\/clusters\/[A-Za-z0-9_-]{12}\/members$/
/** The largest join the page may send: an invite token, the key sealed for the account, a profile and a key pair. */
const MAX_CLUSTER_BODY = 64 * 1024

/** The page may list its clusters and their members, and join one with an invite: nothing else goes out with the token. */
export function isClusterCall(value: unknown): value is ClusterCall {
  if (typeof value !== 'object' || value === null) return false
  const { method, path, body } = value as Record<string, unknown>
  if (method === 'GET') return body === undefined && (path === '/api/clusters' || (typeof path === 'string' && CLUSTER_MEMBERS.test(path)))
  return (
    method === 'POST' &&
    path === '/api/clusters/join' &&
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    JSON.stringify(body).length <= MAX_CLUSTER_BODY
  )
}

/** A cluster call of the page, with the account's token. The relay's answer goes back as it is, errors included. */
export async function clusterCall(account: RecoveredAccount, call: unknown, fetcher: Fetch): Promise<ClusterAnswer> {
  if (!isClusterCall(call)) return { status: 400, body: { error: 'The island does not make this call.' } }
  try {
    const response = await fetcher(account.relay + call.path, {
      method: call.method,
      headers: { authorization: `Bearer ${account.token}`, ...(call.body ? { 'content-type': 'application/json' } : {}) },
      body: call.body ? JSON.stringify(call.body) : undefined,
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  } catch {
    return { status: 502, body: { error: `Could not reach ${new URL(account.relay).host}.` } }
  }
}

async function call<T>(fetcher: Fetch, method: string, relay: string, path: string, token: string | null, body?: object): Promise<T> {
  let response: Response
  try {
    response = await fetcher(relay + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new RelayError(`Could not reach ${new URL(relay).host}.`)
  }
  const json = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null
  if (response.ok && json) return json
  if (response.status === 401) throw new RelayError('This account is no longer valid on its relay.')
  throw new RelayError(typeof json?.error === 'string' ? json.error : `The relay answered ${response.status}.`)
}
