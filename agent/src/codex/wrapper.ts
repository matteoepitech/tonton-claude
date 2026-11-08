// `tonton codex`: Codex's TUI on an app-server of its own, so the notch can drive the session as the terminal does.
// It starts `codex app-server` on a unix socket in run/codex, then the TUI attached to it (`codex --remote`), and
// follows the server's threads: which session a start from the notch became, and where Tonton reaches it. Without a
// socket (Windows, a path too long, a Codex without app-server) it runs plain `codex`, which the notch only shows.

import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths, VERSION } from '../config'
import { log } from '../log'
import { CodexAppServer } from './app-server'

/** What a unix socket path may hold, terminator included, on macOS (Linux allows 108). */
const SOCKET_PATH_MAX = 104
const SERVER_READY_MS = 10_000

/** The servers `tonton codex` runs, their sockets and what they say about their threads. */
export const codexRun = (run = paths.run) => join(run, 'codex')

export interface CodexThread {
  id: string
  cwd?: string
  /** Its rollout, under `$CODEX_HOME/sessions`. */
  path?: string
}

/** One per server, named after its process: the parent of the hooks and of Tonton's MCP server in its sessions. */
export interface CodexServerRecord {
  socket: string
  serverPid: number
  wrapperPid: number
  startedAt: string
  threads: CodexThread[]
}

export const serverRecordPath = (serverPid: number, run = paths.run) => join(codexRun(run), `${serverPid}.json`)

/** The server whose process is `serverPid`, while its wrapper runs. */
export function readServerRecord(serverPid: number, run = paths.run): CodexServerRecord | null {
  try {
    const record = JSON.parse(readFileSync(serverRecordPath(serverPid, run), 'utf8')) as Partial<CodexServerRecord>
    if (typeof record.socket !== 'string' || typeof record.serverPid !== 'number' || typeof record.wrapperPid !== 'number') return null
    if (!isRunning(record.wrapperPid)) return null
    return {
      socket: record.socket,
      serverPid: record.serverPid,
      wrapperPid: record.wrapperPid,
      startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
      threads: Array.isArray(record.threads) ? record.threads.filter(isThread) : [],
    }
  } catch {
    return null
  }
}

/** Every server a wrapper still runs. */
export function serverRecords(run = paths.run): CodexServerRecord[] {
  try {
    return readdirSync(codexRun(run))
      .filter(file => /^\d+\.json$/.test(file))
      .map(file => readServerRecord(Number.parseInt(file, 10), run))
      .filter((record): record is CodexServerRecord => record !== null)
  } catch {
    return []
  }
}

const isThread = (value: unknown): value is CodexThread =>
  !!value && typeof value === 'object' && typeof (value as CodexThread).id === 'string'

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Alive, but another user's: not one of ours.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The thread of a `thread/started` notification, as far as it can be read. */
export function startedThread(params: unknown): CodexThread | null {
  const thread = (params as { thread?: unknown } | null)?.thread as Record<string, unknown> | undefined
  if (!thread || typeof thread.id !== 'string') return null
  return {
    id: thread.id,
    ...(typeof thread.cwd === 'string' ? { cwd: thread.cwd } : {}),
    ...(typeof thread.path === 'string' ? { path: thread.path } : {}),
  }
}

export interface CodexWrapperOptions {
  run?: string
  /** The codex command: `codex` on the PATH, unless a test says otherwise. */
  codex?: string[]
}

/** Runs Codex's TUI for the user, through an app-server Tonton can reach. The TUI's exit code. */
export async function runCodex(args: string[], options: CodexWrapperOptions = {}): Promise<number> {
  const codex = options.codex ?? ['codex']
  const run = options.run ?? paths.run
  // Each child gets `env`: Bun would hand it the environment this process started with.
  const plain = async (why: string) => {
    log('codex: runs without an app-server for Tonton', { why })
    return await Bun.spawn([...codex, ...args], { stdio: ['inherit', 'inherit', 'inherit'], env: { ...process.env } }).exited
  }
  if (process.platform === 'win32') return plain('Windows')
  const dir = codexRun(run)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const socket = join(dir, `${process.pid}.sock`)
  if (Buffer.byteLength(socket) >= SOCKET_PATH_MAX) return plain('the socket path is too long')
  rmSync(socket, { force: true })
  const server = Bun.spawn([...codex, 'app-server', '--listen', `unix://${socket}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env },
  })
  const record: CodexServerRecord = {
    socket,
    serverPid: server.pid,
    wrapperPid: process.pid,
    startedAt: new Date().toISOString(),
    threads: [],
  }
  const recordPath = serverRecordPath(server.pid, run)
  const save = () => writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 })
  let watcher: CodexAppServer | null = null
  const cleanUp = () => {
    watcher?.close()
    server.kill()
    rmSync(recordPath, { force: true })
    rmSync(socket, { force: true })
  }
  for (const signal of ['SIGHUP', 'SIGTERM'] as const)
    process.on(signal, () => {
      cleanUp()
      process.exit(129)
    })
  const deadline = Date.now() + SERVER_READY_MS
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      watcher = await CodexAppServer.connect(socket, VERSION, {
        notification: (method, params) => {
          const thread = method === 'thread/started' ? startedThread(params) : null
          if (!thread || record.threads.some(t => t.id === thread.id)) return
          record.threads.push(thread)
          save()
        },
      })
      break
    } catch {
      await Bun.sleep(100)
    }
  }
  if (!watcher) {
    cleanUp()
    return plain('its app-server did not start')
  }
  save()
  try {
    return await Bun.spawn([...codex, '--remote', `unix://${socket}`, ...args], {
      stdio: ['inherit', 'inherit', 'inherit'],
      env: { ...process.env },
    }).exited
  } finally {
    cleanUp()
  }
}
