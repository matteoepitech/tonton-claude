import { type Enrollment, normalizeServer, parseEnrollment } from '../../shared/enrollment'
import { type AgentConfig, defaultMachineName, loadConfig, saveConfig, VERSION } from './config'
import { seal } from './crypto'

const host = (server: string) => new URL(server).host

/** Registers the machine on a relay with a connection code from the app. */
export async function claim(server: string, machine: string, enrollment: Enrollment): Promise<AgentConfig> {
  const response = await fetch(`${server}/api/machines/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: enrollment.code, name: await seal(enrollment.key, { name: machine, platform: process.platform }) }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)
  if (!response) throw new Error(`${host(server)} is not reachable.`)
  const body = (await response.json().catch(() => ({}))) as { machineId?: string; token?: string; error?: string }
  if (!response.ok || !body.machineId || !body.token) throw new Error(body.error ?? `Enrollment failed (HTTP ${response.status}).`)
  return { server, machineId: body.machineId, token: body.token, key: enrollment.key, machine, version: VERSION }
}

/**
 * `tonton relay <address | connection code>`, also run by the tray icon. An address moves this machine to another
 * address of the same relay; a connection code from the app joins a relay and account. The background service follows
 * within seconds, running sessions on their next start.
 */
export async function switchRelay(input: string): Promise<string> {
  const current = loadConfig()
  const enrollment = parseEnrollment(input)
  if (enrollment) {
    const server = enrollment.server ?? current?.server
    if (!server) throw new Error('This code has no relay address: copy the command again from Tonton Claude › Machines › Add machine.')
    const machine = current?.machine ?? defaultMachineName()
    saveConfig({ ...current, ...(await claim(server, machine, enrollment)), version: current?.version ?? VERSION })
    return `Connected to ${host(server)} as "${machine}".`
  }

  const server = normalizeServer(input)
  if (!server) throw new Error('Enter a relay address (https://…) or the connection code from Tonton Claude › Machines › Add machine.')
  if (!current) throw new Error('This machine is not set up yet: use the connection code from Tonton Claude › Machines › Add machine.')
  if (server === current.server) return `Already using ${host(server)}.`
  const response = await fetch(`${server}/api/agent/ping`, {
    headers: { authorization: `Bearer ${current.token}` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!response) throw new Error(`${host(server)} is not reachable.`)
  if (response.status === 401) {
    throw new Error(
      `${host(server)} does not know this machine. To join it, use a connection code from Tonton Claude › Machines › Add machine.`,
    )
  }
  if (!response.ok) throw new Error(`${host(server)} answered HTTP ${response.status}.`)
  saveConfig({ ...current, server })
  return `Now using ${host(server)}.`
}
