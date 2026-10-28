// What the background service reports about its machine: CPU, memory and battery, read with what each OS ships.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { cpus, freemem, homedir, networkInterfaces, totalmem } from 'node:os'
import { join } from 'node:path'
import type { ClaudePlan, MachineHealth } from '../../../shared/protocol'
import { hasOpenCode } from '../install/opencode'

type Battery = MachineHealth['battery']

/** Busy and total CPU time of all cores, to diff between two reports. */
export interface CpuTimes {
  busy: number
  total: number
}

export function cpuTimes(): CpuTimes {
  let busy = 0
  let total = 0
  for (const { times } of cpus()) {
    const all = times.user + times.nice + times.sys + times.idle + times.irq
    busy += all - times.idle
    total += all
  }
  return { busy, total }
}

/** Share of the CPU in use between two samples, from 0 to 1. */
export function cpuLoad(before: CpuTimes, after: CpuTimes): number {
  const total = after.total - before.total
  return total > 0 ? Math.min(1, Math.max(0, (after.busy - before.busy) / total)) : 0
}

/** macOS: `pmset -g batt`, e.g. "Now drawing from 'AC Power' … InternalBattery-0 … 87%; charging; …". */
export function parsePmset(output: string): Battery {
  const percent = /(\d{1,3})%/.exec(output)
  if (!percent || !/InternalBattery/.test(output)) return null
  return { percent: Number(percent[1]), charging: /'AC Power'/.test(output) }
}

/** Linux: the capacity and status files of a battery in /sys/class/power_supply. */
export function parseSysBattery(capacity: string, status: string): Battery {
  const percent = Number.parseInt(capacity, 10)
  if (!Number.isFinite(percent)) return null
  return { percent, charging: /^(Charging|Full|Not charging)/.test(status.trim()) }
}

/** Windows: `Win32_Battery` as JSON. BatteryStatus 2 means on AC power. */
export function parseWin32Battery(json: string): Battery {
  try {
    const battery = JSON.parse(json) as { EstimatedChargeRemaining?: number; BatteryStatus?: number } | null
    if (typeof battery?.EstimatedChargeRemaining !== 'number') return null
    return { percent: battery.EstimatedChargeRemaining, charging: battery.BatteryStatus === 2 }
  } catch {
    return null
  }
}

function run(command: string[]): string {
  try {
    // The service has no console on Windows: without windowsHide, each report would open a PowerShell window.
    const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'ignore', timeout: 5000, windowsHide: true })
    return result.success ? result.stdout.toString() : ''
  } catch {
    return ''
  }
}

function battery(): Battery {
  if (process.platform === 'darwin') return parsePmset(run(['pmset', '-g', 'batt']))
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json'
    return parseWin32Battery(run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script]))
  }
  try {
    const base = '/sys/class/power_supply'
    const name = readdirSync(base).find(entry => entry.startsWith('BAT'))
    if (!name) return null
    return parseSysBattery(readFileSync(`${base}/${name}/capacity`, 'utf8'), readFileSync(`${base}/${name}/status`, 'utf8'))
  } catch {
    return null
  }
}

/** The broadcast address of an IPv4 subnet, e.g. 192.168.1.255 for 192.168.1.20/255.255.255.0. */
export function broadcastAddress(address: string, netmask: string): string | null {
  const ip = address.split('.').map(Number)
  const mask = netmask.split('.').map(Number)
  if (ip.length !== 4 || mask.length !== 4 || [...ip, ...mask].some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return ip.map((part, index) => (part | (~mask[index] & 255)) & 255).join('.')
}

type Interfaces = ReturnType<typeof networkInterfaces>

/** The network cards a Wake-on-LAN packet can reach, once each: physical IPv4 interfaces with a real MAC address. */
export function wakeTargets(interfaces: Interfaces = networkInterfaces()): NonNullable<MachineHealth['wake']> {
  const targets = new Map<string, string>()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || /^(00:){5}00$/.test(entry.mac)) continue
      const broadcast = broadcastAddress(entry.address, entry.netmask)
      if (broadcast && !targets.has(entry.mac)) targets.set(entry.mac, broadcast)
    }
  }
  return [...targets].map(([mac, broadcast]) => ({ mac, broadcast }))
}

/**
 * The coding agents the notch can start here. The service may run with a short PATH (a LaunchAgent, a systemd unit), so
 * their configuration folders count too.
 */
export function installedTools(
  has: { claude: () => boolean; opencode: () => boolean } = {
    claude: () => existsSync(join(homedir(), '.claude')) || Bun.which('claude') !== null,
    opencode: () => hasOpenCode(),
  },
): NonNullable<MachineHealth['tools']> {
  return (['claude', 'opencode'] as const).filter(tool => has[tool]())
}

/** Where Claude Code keeps its state, the signed-in account among it. */
const claudeStateFile = () =>
  process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json')

/**
 * The plan Claude Code is signed in with, from what it keeps of the account: `organizationType` and, for Max, its rate
 * limit tier (`default_claude_max_20x`). An API key without an account is `api`. Undefined when it is not signed in or
 * says something this agent does not know: the pool then takes the machine as it would a Pro one.
 */
export function claudePlanOf(state: unknown): ClaudePlan | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const { oauthAccount, primaryApiKey } = state as { oauthAccount?: unknown; primaryApiKey?: unknown }
  const account = typeof oauthAccount === 'object' && oauthAccount !== null ? (oauthAccount as Record<string, unknown>) : null
  const type = typeof account?.organizationType === 'string' ? account.organizationType : ''
  const tier = typeof account?.organizationRateLimitTier === 'string' ? account.organizationRateLimitTier : ''
  if (type === 'claude_max') return /20x/.test(tier) ? 'max_20x' : 'max_5x'
  if (type === 'claude_pro') return 'pro'
  if (type === 'claude_team') return 'team'
  if (type === 'claude_enterprise') return 'enterprise'
  if (!account && typeof primaryApiKey === 'string' && primaryApiKey) return 'api'
  return undefined
}

/** The file is large (every project's history): read again only when it changed. */
let planRead: { file: string; mtime: number; plan: ClaudePlan | undefined } | null = null

export function claudePlan(file = claudeStateFile()): ClaudePlan | undefined {
  try {
    const mtime = statSync(file).mtimeMs
    if (planRead?.file === file && planRead.mtime === mtime) return planRead.plan
    const plan = claudePlanOf(JSON.parse(readFileSync(file, 'utf8')))
    planRead = { file, mtime, plan }
    return plan
  } catch {
    return undefined
  }
}

/** One report; `since` is the CPU sample taken at the previous one. */
export function readHealth(since: CpuTimes): { health: MachineHealth; sample: CpuTimes } {
  const sample = cpuTimes()
  const total = totalmem()
  return {
    health: {
      cpu: cpuLoad(since, sample),
      memoryUsed: total - freemem(),
      memoryTotal: total,
      battery: battery(),
      wake: wakeTargets(),
      tools: installedTools(),
      plan: claudePlan(),
      at: new Date().toISOString(),
    },
    sample,
  }
}
