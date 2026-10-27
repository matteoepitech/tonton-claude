// What the install step writes for Claude Code on this machine, and where, without printing anything: the installer
// reports on it, and a diagnosis from the app checks it and repairs it (see diagnose.ts). Tests point it at a temporary
// home.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { paths } from '../config'
import { type ClaudeSettings, launcherSettings, withTontonHooks } from './claude-settings'
import { openCodeConfigDir } from './opencode'
import { type Shell, withLauncher } from './shell-profile'
import { binaryPath, IS_WINDOWS, shellProfiles } from './system'

export interface Setup {
  /** The agent that hooks, the MCP server, the launcher and the status line run. */
  binary: string
  /** The user's home folder. */
  home: string
  /** Where the hooks go. */
  claudeSettings: string
  /** Claude Code's own state, which lists the MCP servers added with `claude mcp add --scope user`. */
  claudeState: string
  /** The settings the launcher passes to claude, with the status line. */
  launcherSettings: string
  run: string
  profiles: { file: string; shell: Shell }[]
  openCode: string
}

export function currentSetup(): Setup {
  const home = homedir()
  const configDir = process.env.CLAUDE_CONFIG_DIR
  return {
    binary: binaryPath(),
    home,
    claudeSettings: paths.claudeSettings,
    claudeState: configDir ? join(configDir, '.claude.json') : join(home, '.claude.json'),
    launcherSettings: paths.launcherSettings,
    run: paths.run,
    profiles: shellProfiles(),
    openCode: openCodeConfigDir(),
  }
}

/** `raw` is null when there is no file yet. Null when the file is not valid JSON: nothing must overwrite it then. */
export function readClaudeSettings(file: string): { settings: ClaudeSettings; raw: string | null } | null {
  if (!existsSync(file)) return { settings: {}, raw: null }
  const raw = readFileSync(file, 'utf8')
  try {
    const settings = JSON.parse(raw) as unknown
    return settings && typeof settings === 'object' && !Array.isArray(settings) ? { settings: settings as ClaudeSettings, raw } : null
  } catch {
    return null
  }
}

export function writeClaudeSettings(file: string, settings: ClaudeSettings) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
}

/** Adds the hooks, keeping a copy of the user's settings the first time. False when the settings are not valid JSON. */
export function writeHooks(setup: Setup): boolean {
  const current = readClaudeSettings(setup.claudeSettings)
  if (!current) return false
  const backup = `${setup.claudeSettings}.tonton-backup`
  if (current.raw !== null && !existsSync(backup)) writeFileSync(backup, current.raw)
  writeClaudeSettings(setup.claudeSettings, withTontonHooks(current.settings, setup.binary))
  return true
}

export function writeLauncherSettings(setup: Setup) {
  mkdirSync(dirname(setup.launcherSettings), { recursive: true })
  const settings = launcherSettings(setup.binary, setup.home, IS_WINDOWS)
  writeFileSync(setup.launcherSettings, `${JSON.stringify(settings, null, 2)}\n`)
}

/** Writes the launcher into each shell profile and returns them. */
export function writeLaunchers(setup: Setup): string[] {
  for (const { file, shell } of setup.profiles) {
    mkdirSync(dirname(file), { recursive: true })
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    writeFileSync(file, withLauncher(current, shell, setup.launcherSettings))
  }
  return setup.profiles.map(profile => profile.file)
}
