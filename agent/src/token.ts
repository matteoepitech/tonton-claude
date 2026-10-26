import { type AccountToken, parseAccountToken } from '../../shared/account-token'
import { seal } from '../../shared/crypto'
import { type AgentConfig, defaultMachineName, loadConfig, saveConfig, VERSION } from './config'

const host = (relay: string) => new URL(relay).host

/** Registers this machine in the account of a token. */
export async function join(token: AccountToken, machine: string): Promise<AgentConfig> {
  const response = await fetch(`${token.relay}/api/machines/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      account: token.account,
      secret: token.secret,
      name: await seal(token.key, { name: machine, platform: process.platform }),
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)
  if (!response) throw new Error(`${host(token.relay)} is not reachable.`)
  const body = (await response.json().catch(() => ({}))) as { machineId?: string; token?: string; error?: string }
  if (!response.ok || !body.machineId || !body.token)
    throw new Error(body.error ?? `${host(token.relay)} refused the token (HTTP ${response.status}).`)
  return {
    server: token.relay,
    account: token.account,
    machineId: body.machineId,
    token: body.token,
    key: token.key,
    machine,
    version: VERSION,
  }
}

/**
 * `tonton token <token>`, also run by the tray icon: connects this machine to the relay and account of the token. The
 * background service follows within seconds, running sessions on their next start.
 */
export async function useToken(text: string): Promise<string> {
  const token = parseAccountToken(text)
  if (!token) throw new Error('This is not a Tonton Claude token. Copy it from Tonton Claude › Machines on your Mac.')
  const current = loadConfig()
  if (current && current.server === token.relay && current.account === token.account && current.key === token.key) {
    const ping = await fetch(`${current.server}/api/agent/ping`, {
      headers: { authorization: `Bearer ${current.token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null)
    if (ping?.ok) return `Already connected to ${host(token.relay)}.`
  }
  const machine = current?.machine ?? defaultMachineName()
  saveConfig({ ...current, ...(await join(token, machine)), version: current?.version ?? VERSION })
  return `Connected to ${host(token.relay)} as "${machine}".`
}
