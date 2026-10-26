import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PLUGIN_FILE, pluginSource } from '../opencode/plugin'

/** OpenCode's global configuration folder: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`, on every platform. */
export function openCodeConfigDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')
}

/** OpenCode is set up on this machine: its configuration folder exists, or `opencode` is on the PATH. */
export function hasOpenCode(dir = openCodeConfigDir()): boolean {
  return existsSync(dir) || Bun.which('opencode') !== null
}

/** Writes Tonton's plugin to OpenCode's plugins folder, which OpenCode 1 and 2 both load. Returns its path. */
export function installOpenCodePlugin(binary: string, dir = openCodeConfigDir()): string {
  const plugins = join(dir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  const file = join(plugins, PLUGIN_FILE)
  writeFileSync(file, pluginSource([binary, 'opencode']))
  return file
}

export function removeOpenCodePlugin(dir = openCodeConfigDir()) {
  rmSync(join(dir, 'plugins', PLUGIN_FILE), { force: true })
}
