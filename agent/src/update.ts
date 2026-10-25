import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateOrder } from '../../shared/protocol'
import { isOlder, RELEASES_URL, VERSION_PATTERN } from '../../shared/version'
import type { RelayConnection } from './channel/relay-connection'
import { type AgentConfig, installedVersion, paths } from './config'
import { open, seal } from './crypto'
import { binaryPath, IS_WINDOWS, moveExecutable, replaceExecutable, trayHelperPath } from './install/system'
import { log } from './log'
import { restartService } from './service/control'

/** Older orders are refused so the relay cannot replay one later. Generous for machines whose clock drifts. */
const ORDER_TTL_MS = 10 * 60_000
const DOWNLOAD_TIMEOUT_MS = 180_000

let running = false

/** Name of this machine's build in the releases. */
export function agentBinaryName(platform: string = process.platform, arch: string = process.arch): string {
  return platform === 'win32' ? `tonton-windows-${arch}.exe` : `tonton-${platform}-${arch}`
}

export const TRAY_HELPER_NAME = 'tonton-tray-darwin'

/** Checks that the order comes from the account owner and is recent. */
export async function readOrder(key: string, sealed: string, now = Date.now()): Promise<UpdateOrder> {
  const order = await open<UpdateOrder>(key, sealed).catch(() => null)
  if (!order) throw new Error('the update order is not sealed with the account key')
  if (typeof order.version !== 'string' || !VERSION_PATTERN.test(order.version)) throw new Error('the update order has no valid version')
  const issuedAt = Date.parse(order.issuedAt)
  if (!(Math.abs(now - issuedAt) <= ORDER_TTL_MS)) throw new Error('the update order expired, check the clock of this machine')
  return order
}

/** `SHA256SUMS` lines: `<hex digest>  <file name>`. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim())
    if (match) sums.set(match[2], match[1])
  }
  return sums
}

/** Runs an order from the app and reports back. The service restarts on the new binary once the answer is out. */
export async function handleUpdateOrder(config: AgentConfig, order: string, relay: RelayConnection) {
  const before = installedVersion()
  try {
    const version = await applyUpdate(config, order)
    log('agent updated', { from: before, to: version })
    relay.post(async () => ({ t: 'update_result', ok: true, version, detail: null }))
    await relay.flushed()
    if (version !== before) setTimeout(() => restartService(), 500)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    log('agent update failed', text)
    relay.post(async () => ({ t: 'update_result', ok: false, version: null, detail: await seal(config.key, { text }) }))
  }
}

/**
 * Installs the release named in the order, as the install script does: downloads this machine's build, checks it
 * against the release's SHA256SUMS, swaps it in and runs its install step. Returns the installed version.
 */
export async function applyUpdate(config: AgentConfig, sealedOrder: string): Promise<string> {
  if (running) throw new Error('an update is already running')
  running = true
  try {
    const order = await readOrder(config.key, sealedOrder)
    if (!isOlder(installedVersion(), order.version)) return installedVersion()

    const release = `${RELEASES_URL}/download/v${order.version}`
    const sums = parseChecksums(await (await download(`${release}/SHA256SUMS`)).text())
    const binary = await verified(release, agentBinaryName(), sums)
    const tray = process.platform === 'darwin' ? await verified(release, TRAY_HELPER_NAME, sums) : null

    const staged = join(paths.bin, IS_WINDOWS ? 'tonton-update.exe' : 'tonton-update')
    replaceExecutable(staged, binary)
    const reported = (await run([staged, 'version'])).output.trim()
    if (reported !== order.version) {
      rmSync(staged, { force: true })
      throw new Error(`the downloaded agent is ${reported || 'unreadable'}, expected ${order.version}`)
    }

    moveExecutable(staged, binaryPath())
    if (tray) replaceExecutable(trayHelperPath(), tray)
    const install = await run([binaryPath(), 'install', '--no-restart'])
    if (install.exitCode !== 0) throw new Error(`the install step failed: ${lastLine(install.output)}`)
    return installedVersion()
  } finally {
    running = false
  }
}

async function download(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }).catch(() => null)
  if (!response) throw new Error(`could not reach ${new URL(url).host}`)
  if (!response.ok) throw new Error(`download failed: ${url.split('/').pop()} (HTTP ${response.status})`)
  return response
}

async function verified(release: string, name: string, sums: Map<string, string>): Promise<Uint8Array> {
  const expected = sums.get(name)
  if (!expected) throw new Error(`${name} is not part of this release`)
  const data = await (await download(`${release}/${name}`)).bytes()
  const actual = new Bun.CryptoHasher('sha256').update(data).digest('hex')
  if (actual !== expected) throw new Error(`${name} does not match its checksum`)
  return data
}

async function run(command: string[]): Promise<{ exitCode: number; output: string }> {
  // Without TONTON_ENROLL, install reuses the machine's enrollment.
  const env = { ...process.env, TONTON_ENROLL: '' }
  const child = Bun.spawn(command, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true })
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
