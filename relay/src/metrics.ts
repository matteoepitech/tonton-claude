// What a self-hoster can watch, in the Prometheus text format. Counts and sizes only, summed over the whole relay:
// nothing sealed, no id, nothing per account.
import type { SessionStatus } from '../../shared/protocol'
import { VERSION } from '../../shared/version'

/** A viewer is a teammate's browser on a read-only share. */
export type Role = 'app' | 'agent' | 'viewer'

/** WebSocket traffic since the relay started. */
export class Traffic {
  readonly messages = { received: { app: 0, agent: 0, viewer: 0 }, sent: { app: 0, agent: 0, viewer: 0 } }
  readonly bytes = { received: { app: 0, agent: 0, viewer: 0 }, sent: { app: 0, agent: 0, viewer: 0 } }

  count(direction: 'received' | 'sent', role: Role, bytes: number) {
    this.messages[direction][role]++
    this.bytes[direction][role] += bytes
  }
}

export const SESSION_STATUSES: readonly SessionStatus[] = [
  'starting',
  'working',
  'waiting',
  'permission',
  'idle',
  'error',
  'ended',
  'offline',
]

export interface RelayCounts {
  accounts: number
  machines: number
  machinesOnline: number
  sockets: Record<Role, number>
  sessions: Record<SessionStatus, number>
  historyEntries: number
  historyBytes: number
  traffic: Traffic
  startedAt: number
}

type Sample = [labels: Record<string, string>, value: number]

/** One metric: its help line, its type and its samples. */
function metric(name: string, type: 'gauge' | 'counter', help: string, samples: Sample[]): string {
  const lines = samples.map(([labels, value]) => {
    const pairs = Object.entries(labels).map(([label, text]) => `${label}="${text.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n')}"`)
    return `${name}${pairs.length ? `{${pairs.join(',')}}` : ''} ${value}`
  })
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines].join('\n')
}

const perRole = (values: Record<Role, number>): Sample[] => [
  [{ role: 'app' }, values.app],
  [{ role: 'agent' }, values.agent],
  [{ role: 'viewer' }, values.viewer],
]

export function renderMetrics(counts: RelayCounts): string {
  const { traffic } = counts
  return `${[
    metric('tonton_relay_info', 'gauge', 'The version of the relay.', [[{ version: VERSION }, 1]]),
    metric('tonton_relay_start_time_seconds', 'gauge', 'When the relay started, in Unix seconds.', [
      [{}, Math.floor(counts.startedAt / 1000)],
    ]),
    metric('tonton_accounts', 'gauge', 'Accounts on the relay.', [[{}, counts.accounts]]),
    metric('tonton_machines', 'gauge', 'Machines that joined an account.', [[{}, counts.machines]]),
    metric('tonton_machines_online', 'gauge', 'Machines with at least one connection.', [[{}, counts.machinesOnline]]),
    metric(
      'tonton_sockets',
      'gauge',
      'Open WebSockets: Mac apps, agent services and sessions, and viewers of read-only shares.',
      perRole(counts.sockets),
    ),
    metric(
      'tonton_sessions',
      'gauge',
      'Sessions the relay holds, by status.',
      SESSION_STATUSES.map(status => [{ status }, counts.sessions[status]]),
    ),
    metric('tonton_history_entries', 'gauge', 'Sealed history entries the relay holds.', [[{}, counts.historyEntries]]),
    metric('tonton_history_bytes', 'gauge', 'Size of the sealed history the relay holds.', [[{}, counts.historyBytes]]),
    metric('tonton_ws_messages_received_total', 'counter', 'WebSocket messages received.', perRole(traffic.messages.received)),
    metric('tonton_ws_messages_sent_total', 'counter', 'WebSocket messages sent.', perRole(traffic.messages.sent)),
    metric('tonton_ws_received_bytes_total', 'counter', 'Bytes of the WebSocket messages received.', perRole(traffic.bytes.received)),
    metric('tonton_ws_sent_bytes_total', 'counter', 'Bytes of the WebSocket messages sent.', perRole(traffic.bytes.sent)),
  ].join('\n')}\n`
}
