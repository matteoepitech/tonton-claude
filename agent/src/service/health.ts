// What the background service reports about its machine: CPU, memory and battery, read with what each OS ships.
import { readdirSync, readFileSync } from 'node:fs'
import { cpus, freemem, totalmem } from 'node:os'
import type { MachineHealth } from '../../../shared/protocol'

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
    const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'ignore', timeout: 5000 })
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
      at: new Date().toISOString(),
    },
    sample,
  }
}
