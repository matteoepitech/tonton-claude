import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseAccountToken } from '../../../shared/account-token'
import { defaultMachineName, loadConfig, paths, saveConfig, VERSION } from '../config'
import { proxyFor, shownProxy } from '../proxy'
import { registerAutostart, restartService, runningServicePid, stopService } from '../service/control'
import { installTrayFiles } from '../service/tray'
import { useToken } from '../token'
import { type ClaudeSettings, launcherSettings, withoutTontonHooks, withTontonHooks } from './claude-settings'
import { removeLauncher, withLauncher } from './shell-profile'
import { IS_WINDOWS, installBinary, registerMcpServer, shellProfiles, unregisterMcpServer } from './system'

const done = (message: string) => console.log(`  \x1b[32m✓\x1b[0m ${message}`)
const warn = (message: string) => console.log(`  \x1b[33m!\x1b[0m ${message}`)

function fatal(message: string): never {
  console.error(`  \x1b[31m✗\x1b[0m ${message}`)
  process.exit(1)
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

/**
 * Sets the machine up, or updates it when it is already connected. Run by the install scripts with TONTON_TOKEN, and by
 * updates from the app with `--no-restart` (the service restarts itself once it has reported).
 */
export async function install(args: string[]) {
  const previous = loadConfig()
  const machine = option(args, 'name') ?? previous?.machine ?? defaultMachineName()
  const token = (option(args, 'token') ?? process.env.TONTON_TOKEN ?? '').trim()
  const updating = args.includes('--no-restart')

  console.log(`\nTonton Claude ${VERSION}, installing on "${machine}"\n`)
  if (previous && machine !== previous.machine) saveConfig({ ...previous, machine })
  if (token) {
    if (!parseAccountToken(token)) fatal('TONTON_TOKEN is not a Tonton Claude token. Copy the install command again from the app.')
    done(await useToken(token).catch(error => fatal(error.message)))
  } else if (previous) {
    done(`already connected to ${new URL(previous.server).host}, updating`)
  } else {
    fatal('Missing TONTON_TOKEN. Copy the install command from Tonton Claude › Machines.')
  }
  const config = loadConfig() ?? fatal('The configuration could not be saved.')
  // A manual install brings a hidden tray icon back; an update from the app leaves it as the user set it.
  saveConfig({ ...config, version: VERSION, tray: updating ? previous?.tray : undefined })
  done('config saved to ~/.tonton/config.json (readable by you only)')

  const binary = installBinary()
  done(`binary installed: ${binary}`)
  installHooks(binary)
  if (registerMcpServer(binary)) done('MCP server "tonton" registered for Claude Code')
  else warn(`could not run "claude mcp add". Run it by hand: claude mcp add --scope user tonton -- "${binary}" channel`)
  installLaunchers(binary)
  await installTrayFiles()
  if (registerAutostart()) done('background service starts at login')
  else warn('no user systemd here: the background service does not start at login. Sessions still work.')
  if (!updating) {
    restartService({ reload: true })
    done('background service started')
  }

  console.log(`
All set. Open a new terminal and run \x1b[1mclaude\x1b[0m as usual: the session shows up in your Mac's notch.
On first launch, Claude Code asks you to confirm the development channel: pick "I am using this for local development".
`)
}

function readClaudeSettings(): { settings: ClaudeSettings; raw: string | null } | null {
  if (!existsSync(paths.claudeSettings)) return { settings: {}, raw: null }
  const raw = readFileSync(paths.claudeSettings, 'utf8')
  try {
    return { settings: JSON.parse(raw) as ClaudeSettings, raw }
  } catch {
    return null
  }
}

function writeClaudeSettings(settings: ClaudeSettings) {
  mkdirSync(dirname(paths.claudeSettings), { recursive: true })
  writeFileSync(paths.claudeSettings, `${JSON.stringify(settings, null, 2)}\n`)
}

function installHooks(binary: string) {
  const current = readClaudeSettings()
  if (!current) {
    warn(`${paths.claudeSettings} is not valid JSON, hooks not installed. Fix it and run the install again.`)
    return
  }
  const backup = `${paths.claudeSettings}.tonton-backup`
  if (current.raw !== null && !existsSync(backup)) writeFileSync(backup, current.raw)
  writeClaudeSettings(withTontonHooks(current.settings, binary))
  done('hooks added to ~/.claude/settings.json')
}

function installLaunchers(binary: string) {
  writeFileSync(paths.launcherSettings, `${JSON.stringify(launcherSettings(binary, homedir(), IS_WINDOWS), null, 2)}\n`)
  const profiles = shellProfiles()
  if (!profiles.length) warn('no shell profile found: start claude with --dangerously-load-development-channels server:tonton')
  for (const { file, shell } of profiles) {
    mkdirSync(dirname(file), { recursive: true })
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    writeFileSync(file, withLauncher(current, shell, paths.launcherSettings))
    done(`claude launcher added to ${file}`)
  }
}

export async function uninstall() {
  console.log('\nUninstalling Tonton Claude\n')
  stopService()
  done('background service stopped and removed from login items')
  const current = readClaudeSettings()
  if (current?.raw) {
    writeClaudeSettings(withoutTontonHooks(current.settings))
    done('hooks removed from ~/.claude/settings.json')
  }
  unregisterMcpServer()
  done('MCP server removed')
  for (const { file } of shellProfiles()) {
    if (existsSync(file)) writeFileSync(file, removeLauncher(readFileSync(file, 'utf8')))
  }
  done('claude launcher removed from shell profiles')
  for (const name of ['config.json', 'claude-settings.json', 'run', 'inbox', 'status.json', 'service.pid', 'tray.ps1', 'tonton.ico'])
    rmSync(join(paths.home, name), { recursive: true, force: true })
  done(`files removed. The binary stays in ${paths.bin}: delete the folder by hand if you want.`)
}

export async function status() {
  const config = loadConfig()
  if (!config) {
    console.log('Tonton Claude is not set up. Copy the install command from the app (Machines > Add machine).')
    return
  }
  console.log(`Tonton Claude ${VERSION}\n  machine: ${config.machine} (${config.machineId})\n  relay:   ${config.server}`)
  const proxy = proxyFor(config.server)
  if (proxy) console.log(`  proxy:   ${shownProxy(proxy.url)} (from ${proxy.from})`)
  const response = await fetch(`${config.server}/api/agent/ping`, { headers: { authorization: `Bearer ${config.token}` } }).catch(
    () => null,
  )
  if (response?.ok) done('relay reachable, machine token accepted')
  else warn(response ? `relay answered ${response.status} (machine revoked?)` : `relay not reachable${proxy ? ' through the proxy' : ''}`)
  const launchers = shellProfiles().filter(({ file }) => existsSync(file) && readFileSync(file, 'utf8').includes('# >>> tonton >>>'))
  if (launchers.length) done(`claude launcher in ${launchers.map(p => p.file).join(', ')}`)
  else warn('no claude launcher found in your shell profiles: run the install again')
  const service = runningServicePid()
  if (service) done(`background service running (pid ${service})`)
  else warn('background service not running: run the install again')
  console.log(`  channel: ${process.env.TONTON_CHANNEL === '1' ? 'active in this shell' : 'start claude from a new terminal to enable it'}`)
}
