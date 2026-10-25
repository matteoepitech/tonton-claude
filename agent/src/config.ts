import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

export const VERSION = '0.3.0'

const HOME = process.env.TONTON_HOME || join(homedir(), '.tonton')

export const paths = {
  home: HOME,
  bin: join(HOME, 'bin'),
  /** One file per running claude process, written by hooks and read by its channel. */
  run: join(HOME, 'run'),
  /** Images sent from the notch, handed to Claude as file paths. */
  inbox: join(HOME, 'inbox'),
  log: join(HOME, 'tonton.log'),
  config: join(HOME, 'config.json'),
  claudeSettings: join(homedir(), '.claude', 'settings.json'),
}

export interface AgentConfig {
  server: string
  machineId: string
  /** Machine token issued by the relay at enrollment. */
  token: string
  /** Account end-to-end key (base64url). Never sent to the relay. */
  key: string
  machine: string
}

export function loadConfig(): AgentConfig | null {
  try {
    const config = JSON.parse(readFileSync(paths.config, 'utf8')) as Partial<AgentConfig>
    if (!config.server || !config.token || !config.key || !config.machineId) return null
    return {
      server: config.server.replace(/\/+$/, ''),
      machineId: config.machineId,
      token: config.token,
      key: config.key,
      machine: config.machine || defaultMachineName(),
    }
  } catch {
    return null
  }
}

export function saveConfig(config: AgentConfig) {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  writeFileSync(paths.config, JSON.stringify(config, null, 2), { mode: 0o600 })
}

export function defaultMachineName(): string {
  return (process.env.COMPUTERNAME || hostname()).replace(/\.local$/, '')
}
