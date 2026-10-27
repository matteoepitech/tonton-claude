// The relay's HTTP calls the island makes, from the main process: creating an account, checking a recovery key, and the
// join secret of the account token. Like RelayAPI.swift. The end-to-end key is made here and never sent.

import { encodeAccountToken } from '../../../shared/account-token'
import { newAccountKey } from '../../../shared/crypto'
import type { RecoveredAccount } from '../../../shared/recovery-key'
import { RELEASES_URL } from '../../../shared/version'

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
