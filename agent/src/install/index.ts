import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type AgentConfig, defaultMachineName, loadConfig, paths, saveConfig, VERSION } from '../config'
import { seal } from '../crypto'
import { type ClaudeSettings, withoutTontonHooks, withTontonHooks } from './claude-settings'
import { removeLauncher, withLauncher } from './shell-profile'
import { installBinary, registerMcpServer, shellProfiles, unregisterMcpServer } from './system'

/** `TONTON_ENROLL` is `<code>.<key>`: the code is a single-use credential for the relay, the key never leaves the machine. */
const ENROLLMENT = /^([A-Z0-9]{12})\.([A-Za-z0-9_-]{43})$/

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

export async function install(args: string[]) {
  const previous = loadConfig()
  const server = (option(args, 'server') ?? previous?.server)?.replace(/\/+$/, '')
  const machine = option(args, 'name') ?? previous?.machine ?? defaultMachineName()
  const enrollment = (option(args, 'enroll') ?? process.env.TONTON_ENROLL ?? '').trim()
  if (!server) fatal('Usage: TONTON_ENROLL=<code.key> tonton install --server https://relay.example.com [--name "PC-Windows"]')

  console.log(`\nTonton Claude ${VERSION}, installing on "${machine}"\n`)
  const config = enrollment ? await enroll(server, machine, enrollment) : reuse(previous, server, machine)
  saveConfig(config)
  done('config saved to ~/.tonton/config.json (readable by you only)')

  const binary = installBinary()
  done(`binary installed: ${binary}`)
  installHooks(binary)
  if (registerMcpServer(binary)) done('MCP server "tonton" registered for Claude Code')
  else warn(`could not run "claude mcp add". Run it by hand: claude mcp add --scope user tonton -- "${binary}" channel`)
  installLaunchers()

  console.log(`
All set. Open a new terminal and run \x1b[1mclaude\x1b[0m as usual: the session shows up in your Mac's notch.
On first launch, Claude Code asks you to confirm the development channel: pick "I am using this for local development".
`)
}

async function enroll(server: string, machine: string, enrollment: string): Promise<AgentConfig> {
  const match = ENROLLMENT.exec(enrollment)
  if (!match) fatal('TONTON_ENROLL is malformed. Copy the install command again from the app.')
  const [, code, key] = match
  const response = await fetch(`${server}/api/machines/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: await seal(key, { name: machine, platform: process.platform }) }),
  }).catch(() => null)
  if (!response) fatal(`relay not reachable (${server})`)
  const body = (await response.json().catch(() => ({}))) as { machineId?: string; token?: string; error?: string }
  if (!response.ok || !body.machineId || !body.token) fatal(body.error ?? `enrollment failed (HTTP ${response.status})`)
  done(`machine enrolled on ${new URL(server).host}`)
  return { server, machineId: body.machineId, token: body.token, key, machine }
}

function reuse(previous: AgentConfig | null, server: string, machine: string): AgentConfig {
  if (!previous || previous.server !== server) {
    fatal('Missing TONTON_ENROLL. Copy the install command from Tonton Claude > Machines > Add machine.')
  }
  done('reusing the existing enrollment')
  return { ...previous, machine }
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

function installLaunchers() {
  const profiles = shellProfiles()
  if (!profiles.length) warn('no shell profile found: start claude with --dangerously-load-development-channels server:tonton')
  for (const { file, shell } of profiles) {
    mkdirSync(dirname(file), { recursive: true })
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    writeFileSync(file, withLauncher(current, shell))
    done(`claude launcher added to ${file}`)
  }
}

export async function uninstall() {
  console.log('\nUninstalling Tonton Claude\n')
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
  for (const name of ['config.json', 'run', 'inbox']) rmSync(join(paths.home, name), { recursive: true, force: true })
  done(`files removed. The binary stays in ${paths.bin}: delete the folder by hand if you want.`)
}

export async function status() {
  const config = loadConfig()
  if (!config) {
    console.log('Tonton Claude is not set up. Copy the install command from the app (Machines > Add machine).')
    return
  }
  console.log(`Tonton Claude ${VERSION}\n  machine: ${config.machine} (${config.machineId})\n  relay:   ${config.server}`)
  const response = await fetch(`${config.server}/api/agent/ping`, { headers: { authorization: `Bearer ${config.token}` } }).catch(
    () => null,
  )
  if (response?.ok) done('relay reachable, machine token accepted')
  else warn(response ? `relay answered ${response.status} (machine revoked?)` : 'relay not reachable')
  const launchers = shellProfiles().filter(({ file }) => existsSync(file) && readFileSync(file, 'utf8').includes('# >>> tonton >>>'))
  if (launchers.length) done(`claude launcher in ${launchers.map(p => p.file).join(', ')}`)
  else warn('no claude launcher found in your shell profiles: run the install again')
  console.log(`  channel: ${process.env.TONTON_CHANNEL === '1' ? 'active in this shell' : 'start claude from a new terminal to enable it'}`)
}
