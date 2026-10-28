import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { paths } from '../config'
import { binaryPath, IS_WINDOWS, windowlessBinaryPath } from '../install/system'
import { proxyEnvironment } from '../proxy'
import { searchPath } from './search-path'

// Starts the background service at login and restarts it on a new binary: a Run key on Windows, a LaunchAgent on
// macOS, a user systemd unit on Linux.

const LABEL = 'tech.d3l.tonton.agent'
const UNIT = 'tonton-agent.service'
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_VALUE = 'Tonton Claude'

const launchAgentPath = () => join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const systemdUnitPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', UNIT)
const launchdDomain = () => `gui/${process.getuid?.() ?? 0}`

function exec(command: string[]): boolean {
  try {
    return Bun.spawnSync(command, { stdout: 'ignore', stderr: 'ignore', windowsHide: true }).exitCode === 0
  } catch {
    return false
  }
}

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Restarted after a crash, not after Quit in the menu bar (a clean exit). `proxy` and `path` come from the shell that
 * runs the install: launchd and systemd start the service without the shell's variables, and with a PATH that has neither
 * Homebrew nor the user's own folders, where tmux and the coding tools are (search-path.ts).
 */
export function launchAgentPlist(
  binary: string,
  home: string,
  proxy: [string, string][] = proxyEnvironment(),
  path = searchPath(),
): string {
  const variables = [['TONTON_HOME', home], ['PATH', path], ...proxy].map(
    ([name, value]) => `<key>${name}</key><string>${escapeXml(value)}</string>`,
  )
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${escapeXml(binary)}</string><string>service</string></array>
  <key>EnvironmentVariables</key><dict>${variables.join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`
}

export function systemdUnit(binary: string, home: string, proxy: [string, string][] = proxyEnvironment(), path = searchPath()): string {
  // Quoted, with `%` doubled: systemd reads it as a specifier, and proxy passwords are often percent-encoded.
  const variables = [['PATH', path] as [string, string], ...proxy].map(
    ([name, value]) => `Environment="${name}=${value.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"\n`,
  )
  return `[Unit]
Description=Tonton Claude agent
After=network-online.target

[Service]
Environment=TONTON_HOME=${home}
${variables.join('')}ExecStart="${binary}" service
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}

/** Tests run agents in a temporary home: they must not touch the login items of the machine running them. */
export const disabled = () => process.env.TONTON_SERVICE === 'off'

/** Whether the service starts at login: its Run key, LaunchAgent or systemd unit is there. */
export function autostartRegistered(): boolean {
  if (IS_WINDOWS) return exec(['reg', 'query', RUN_KEY, '/v', RUN_VALUE])
  return existsSync(process.platform === 'darwin' ? launchAgentPath() : systemdUnitPath())
}

/** Returns false when this system can't start it at login (Linux without a user systemd). */
export function registerAutostart(): boolean {
  if (disabled()) return false
  if (IS_WINDOWS) return exec(['reg', 'add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${windowlessBinaryPath()}" service`, '/f'])
  const [file, content] =
    process.platform === 'darwin'
      ? [launchAgentPath(), launchAgentPlist(binaryPath(), paths.home)]
      : [systemdUnitPath(), systemdUnit(binaryPath(), paths.home)]
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  if (process.platform === 'darwin') return true
  return exec(['systemctl', '--user', 'daemon-reload']) && exec(['systemctl', '--user', 'enable', UNIT])
}

/**
 * Starts the service on the installed binary, replacing a running one. `reload` also picks up a rewritten LaunchAgent,
 * which unloads the job first: never from inside the service itself.
 */
/**
 * Unloads the LaunchAgent and loads it again, with its new plist. launchd unloads in the background: loading at once
 * fails while the old job is still there, and left the machine with no service after an update. So it waits until
 * the job is gone, then loads, trying again a few times. False when it never loaded.
 */
export function relaunchAgent(
  job: string,
  domain: string,
  plist: string,
  run: (command: string[]) => boolean = exec,
  sleep: (ms: number) => void = Bun.sleepSync,
): boolean {
  run(['launchctl', 'bootout', job])
  for (let waited = 0; waited < 50 && run(['launchctl', 'print', job]); waited++) sleep(100)
  for (let attempt = 0; attempt < 5; attempt++) {
    if (run(['launchctl', 'bootstrap', domain, plist])) return true
    sleep(500)
  }
  return false
}

export function restartService({ reload = false } = {}) {
  if (disabled()) return
  if (process.platform === 'darwin' && existsSync(launchAgentPath())) {
    const job = `${launchdDomain()}/${LABEL}`
    if (reload) relaunchAgent(job, launchdDomain(), launchAgentPath())
    else if (exec(['launchctl', 'print', job])) exec(['launchctl', 'kickstart', '-k', job])
    else exec(['launchctl', 'bootstrap', launchdDomain(), launchAgentPath()])
    return
  }
  if (process.platform === 'linux' && existsSync(systemdUnitPath())) {
    if (reload) exec(['systemctl', '--user', 'daemon-reload'])
    if (exec(['systemctl', '--user', 'restart', UNIT])) return
  }
  // The new instance stops this one (see acquireLock).
  const binary = IS_WINDOWS ? windowlessBinaryPath() : binaryPath()
  spawn(binary, ['service', '--replace'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

export function stopService() {
  if (disabled()) return
  if (IS_WINDOWS) exec(['reg', 'delete', RUN_KEY, '/v', RUN_VALUE, '/f'])
  else if (process.platform === 'darwin') {
    exec(['launchctl', 'bootout', `${launchdDomain()}/${LABEL}`])
    rmSync(launchAgentPath(), { force: true })
  } else if (existsSync(systemdUnitPath())) {
    exec(['systemctl', '--user', 'disable', '--now', UNIT])
    rmSync(systemdUnitPath(), { force: true })
  }
  const pid = runningServicePid()
  if (pid) killQuietly(pid)
}

export function runningServicePid(): number | null {
  try {
    const pid = Number(readFileSync(paths.servicePid, 'utf8'))
    return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null
  } catch {
    return null
  }
}

/** One service per machine. With `replace`, a running one is stopped first (restart on a new binary). */
export function acquireLock(replace: boolean): boolean {
  const running = runningServicePid()
  if (running && running !== process.pid) {
    if (!replace) return false
    killQuietly(running)
    for (let i = 0; i < 50 && isAlive(running); i++) Bun.sleepSync(200)
  }
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  writeFileSync(paths.servicePid, String(process.pid))
  return true
}

export function releaseLock() {
  if (runningServicePid() === process.pid) rmSync(paths.servicePid, { force: true })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function killQuietly(pid: number) {
  try {
    process.kill(pid)
  } catch {
    // Already gone.
  }
}
