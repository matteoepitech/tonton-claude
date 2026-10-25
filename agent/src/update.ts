import { chmodSync, existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateOrder } from '../../shared/protocol'
import { isOlder, VERSION_PATTERN } from '../../shared/version'
import { type AgentConfig, installedVersion, paths } from './config'
import { open } from './crypto'
import { IS_WINDOWS } from './install/system'

/** Older orders are refused so the relay cannot replay one later. Generous for machines whose clock drifts. */
const ORDER_TTL_MS = 10 * 60_000
const DOWNLOAD_TIMEOUT_MS = 120_000

let running = false

/** Name of this machine's build on the relay, as in the install scripts. */
export function agentBinaryName(platform: string = process.platform, arch: string = process.arch): string {
  return platform === 'win32' ? `tonton-windows-${arch}.exe` : `tonton-${platform}-${arch}`
}

/** Checks that the order comes from the account owner and is recent. */
export async function readOrder(key: string, sealed: string, now = Date.now()): Promise<UpdateOrder> {
  const order = await open<UpdateOrder>(key, sealed).catch(() => null)
  if (!order) throw new Error('the update order is not sealed with the account key')
  if (typeof order.version !== 'string' || !VERSION_PATTERN.test(order.version)) throw new Error('the update order has no valid version')
  const issuedAt = Date.parse(order.issuedAt)
  if (!(Math.abs(now - issuedAt) <= ORDER_TTL_MS)) throw new Error('the update order expired, check the clock of this machine')
  return order
}

/**
 * Replaces the installed agent with the relay's build, then runs its install step like the install script does, so
 * hooks, MCP server and launchers follow the new version. Running sessions keep the old binary until they restart.
 * Returns the installed version.
 */
export async function applyUpdate(config: AgentConfig, sealedOrder: string): Promise<string> {
  if (running) throw new Error('an update is already running')
  running = true
  try {
    const order = await readOrder(config.key, sealedOrder)
    if (!isOlder(installedVersion(), order.version)) return installedVersion()

    const response = await fetch(`${config.server}/dl/${agentBinaryName()}`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`download failed (HTTP ${response.status})`)
    const staged = join(paths.bin, IS_WINDOWS ? 'tonton-update.exe' : 'tonton-update')
    await Bun.write(staged, response)
    chmodSync(staged, 0o755)

    const reported = (await run([staged, 'version'])).output.trim()
    if (reported !== order.version) {
      rmSync(staged, { force: true })
      throw new Error(`the downloaded agent is ${reported || 'unreadable'}, expected ${order.version}`)
    }

    const binary = join(paths.bin, IS_WINDOWS ? 'tonton.exe' : 'tonton')
    // A running exe can't be overwritten on Windows, but it can be renamed. Elsewhere the rename swaps it atomically.
    if (IS_WINDOWS && existsSync(binary)) renameSync(binary, `${binary}.old-${Date.now()}`)
    renameSync(staged, binary)

    const install = await run([binary, 'install', '--server', config.server])
    if (install.exitCode !== 0) throw new Error(`the install step failed: ${lastLine(install.output)}`)
    return installedVersion()
  } finally {
    running = false
  }
}

async function run(command: string[]): Promise<{ exitCode: number; output: string }> {
  // Without TONTON_ENROLL, install reuses the machine's enrollment.
  const env = { ...process.env, TONTON_ENROLL: '' }
  const child = Bun.spawn(command, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { exitCode, output: stderr.trim() || stdout }
}

const lastLine = (text: string) =>
  text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips the installer's terminal colors
    .replace(/\x1b\[[0-9;]*m/g, '')
    .trim()
    .split('\n')
    .pop()
    ?.trim() || 'no output'
