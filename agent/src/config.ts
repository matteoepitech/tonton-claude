import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { VERSION } from '../../shared/version'

export { VERSION }

const HOME = process.env.TONTON_HOME || join(homedir(), '.tonton')

export const paths = {
  home: HOME,
  bin: join(HOME, 'bin'),
  /** One file per running claude process, written by hooks and read by its channel. */
  run: join(HOME, 'run'),
  /** Passed to claude by the launcher with --settings. */
  launcherSettings: join(HOME, 'claude-settings.json'),
  /** Images sent from the notch, handed to Claude as file paths. */
  inbox: join(HOME, 'inbox'),
  log: join(HOME, 'tonton.log'),
  config: join(HOME, 'config.json'),
  /** Written by the background service, read by its tray icon. */
  status: join(HOME, 'status.json'),
  servicePid: join(HOME, 'service.pid'),
  claudeSettings: join(homedir(), '.claude', 'settings.json'),
}

export interface AgentConfig {
  server: string
  /** Account the machine joined, from its token. */
  account?: string
  machineId: string
  /** Machine token issued by the relay at enrollment. */
  token: string
  /** Account end-to-end key (base64url). Never sent to the relay. */
  key: string
  machine: string
  /** Version of the binary installed in ~/.tonton/bin, written by `tonton install`. */
  version?: string
  /** False once the user hid the tray icon. */
  tray?: boolean
}

export function loadConfig(): AgentConfig | null {
  try {
    const config = JSON.parse(readFileSync(paths.config, 'utf8')) as Partial<AgentConfig>
    if (!config.server || !config.token || !config.key || !config.machineId) return null
    return {
      server: config.server.replace(/\/+$/, ''),
      account: config.account,
      machineId: config.machineId,
      token: config.token,
      key: config.key,
      machine: config.machine || defaultMachineName(),
      version: config.version,
      tray: config.tray,
    }
  } catch {
    return null
  }
}

export function saveConfig(config: AgentConfig) {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  writeFileSync(paths.config, JSON.stringify(config, null, 2), { mode: 0o600 })
}

/** Read again on each use: an update replaces the binary under channels that keep running the old one. */
export function installedVersion(): string {
  return loadConfig()?.version ?? VERSION
}

export function defaultMachineName(): string {
  return (process.env.COMPUTERNAME || hostname()).replace(/\.local$/, '')
}
