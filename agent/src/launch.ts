// Starts claude or opencode from the notch. An interactive Claude Code needs a terminal, so it runs in a detached tmux
// session; the questions it asks on the way (loading the channel, trusting the folder) go to the notch, and only the
// user's answer moves it on. OpenCode asks nothing: its session is made in its background service when it has one.
// Pool machines start their sessions the same way (agent/src/service/pool-worker.ts), in the folder their owner chose.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { open, seal } from '../../shared/crypto'
import { isModelId } from '../../shared/pool-model'
import type { StartAnswer, StartDetail, StartOrder, StartState } from '../../shared/protocol'
import type { RelayConnection } from './channel/relay-connection'
import { type AgentConfig, paths } from './config'
import { log } from './log'
import { claimOnce } from './once'
import { usageFile } from './usage'

/** Older orders are refused so the relay cannot replay one later. */
const ORDER_TTL_MS = 10 * 60_000
const POLL_MS = 500
/** Without a session after this, the start ends: failed, and left running in tmux if claude still runs. */
const START_TIMEOUT_MS = 90_000
/** How long a question waits for the user. */
const ANSWER_TIMEOUT_MS = 10 * 60_000
/** A hung tmux or ps must not freeze the agent. */
const COMMAND_TIMEOUT_MS = 5000
/** Starts running at once in this process. */
const MAX_RUNNING = 4
/** As the relay checks it. Names the tmux session, so nothing tmux would read as a format. */
const LAUNCH_ID = /^[a-z0-9]{8,32}$/

/** What Claude Code asks while starting, as it reads on screen, and what the notch shows the user. */
export const QUESTIONS = [
  { marker: 'Loading development channels', text: 'Claude Code asks to load the Tonton Claude channel, for local development.' },
  { marker: 'Quick safety check', text: 'Claude Code asks whether you trust the files in this folder.' },
]

/** The question each start waits on. */
const answers = new Map<string, { question: string; resolve: (confirm: boolean) => void }>()
let running = 0

/** Where hooks link sessions, the shell claude starts from and the folder `~` stands for. Tests point them elsewhere. */
export interface LaunchOptions {
  run?: string
  shell?: string
  home?: string
  /** How the installed OpenCode is found and reached. */
  openCode?: OpenCodeAccess
}

/** OpenCode 2's background service, which its terminals and Tonton's plugin connect to. */
export interface OpenCodeService {
  url: string
  password: string
}

export interface OpenCodeAccess {
  /** The major version of `opencode` on the PATH of a login shell, or null without one. */
  version(shell: string): number | null
  /** The running service, started first when needed. Null with OpenCode 1, or when it cannot start. */
  service(shell: string): OpenCodeService | null
}

/** How long `opencode` must stay up before its start counts. */
const OPENCODE_SETTLE_MS = 1500
/** As OpenCode names them: the id goes into the command tmux runs. */
const OPENCODE_SESSION = /^ses_[A-Za-z0-9]{8,64}$/

/** A start order from the relay. */
export function receiveStartOrder(config: AgentConfig, launchId: string, sealed: string, relay: RelayConnection) {
  log('start order from the app', { launchId })
  void handleStartOrder(config, launchId, sealed, relay)
}

/**
 * Runs a start order from the app, reporting each step. The relay gives it to one connection of the machine, but could
 * give it to all, or again later: a start runs once on the machine it names, whichever process gets it first.
 */
export async function handleStartOrder(
  config: AgentConfig,
  launchId: string,
  sealed: string,
  relay: Pick<RelayConnection, 'post'>,
  options: LaunchOptions = {},
) {
  if (!LAUNCH_ID.test(launchId)) return
  const report: Report = (state, fields = {}) =>
    relay.post(async () => {
      const detail: StartDetail = { launchId, machineId: config.machineId, state, ...fields }
      return { t: 'session_start', launchId, state, detail: await seal(config.key, detail) }
    })
  const fail = (text: string) => report('failed', { text })
  // Claimed before anything is reported, so a replayed or junk order for a start already running says nothing about it.
  const run = options.run ?? paths.run
  const claimed = claim(launchId, run)
  if (claimed === 'taken') return
  if (claimed instanceof Error) return fail(`Could not record the start on this machine: ${claimed.message}`)
  const order = await readOrder<StartOrder>(config.key, sealed)
  if (!order || order.launchId !== launchId || order.machineId !== config.machineId || typeof order.cwd !== 'string')
    return fail('The order is not sealed with the account key for this machine, or it expired.')
  const cwd = fromHome(order.cwd, options.home)
  if (!isAbsolute(cwd) || !isDirectory(cwd)) return fail(`${order.cwd} is not a folder on this machine.`)
  if (process.platform === 'win32') return fail('Starting sessions from the notch needs tmux, which Windows does not have.')
  if (!tmux(['-V']).ok) return fail('Install tmux on this machine to start sessions from the notch.')
  if (running >= MAX_RUNNING) return fail('Too many sessions are starting on this machine. Try again in a minute.')
  running++
  try {
    if (order.tool === 'opencode') await runOpenCodeLaunch(launchId, cwd, report, options)
    else {
      // Each question goes to the notch, and waits for the user's answer to it.
      const confirm = (text: string, question: string) => {
        report('asking', { text, question })
        return waitForAnswer(launchId, question)
      }
      await runLaunch(launchId, cwd, report, confirm, { ...options, run })
    }
  } finally {
    running--
  }
}

/** How a pool task's session starts: with the model its machine chose for it (shared/pool-model.ts). */
export interface PoolLaunchOptions extends LaunchOptions {
  /** A Claude Code alias or id, an OpenCode `provider/model` or family. Checked with isModelId: it reaches a command line. */
  model?: string
}

/** A session started for a pool machine's task: its id, and the tmux session that runs it. */
export interface PoolLaunch {
  sessionId: string
  tmux: string
}

/** As the relay checks task ids: tmux reads nothing in them as a format. */
const POOL_TASK_ID = /^[A-Za-z0-9_-]{8,40}$/

/** The tmux session of a pool task's session. */
export const poolTmuxName = (taskId: string) => `tonton-pool-${taskId}`

/**
 * Starts a session for a task a pool machine took, in the task's worktree: Claude Code in a detached tmux, or OpenCode
 * through its service and a terminal on it. Claude Code's questions are answered yes without asking: the machine owner
 * put the machine in the pool with this folder. The session id, or why it did not start.
 */
export async function launchForPool(
  taskId: string,
  cwd: string,
  tool: 'claude' | 'opencode',
  options: PoolLaunchOptions = {},
): Promise<PoolLaunch | string> {
  if (!POOL_TASK_ID.test(taskId)) return 'The task has no id this machine can use.'
  if (options.model !== undefined && !isModelId(options.model)) return 'The model chosen for the task is not one this machine can pass on.'
  if (process.platform === 'win32') return 'Pool sessions run in tmux, which Windows does not have.'
  if (!tmux(['-V']).ok) return 'Install tmux on this machine to run pool sessions.'
  if (running >= MAX_RUNNING) return 'Too many sessions are starting on this machine.'
  const name = poolTmuxName(taskId)
  // A session left over from an earlier start of the task: this one replaces it.
  tmux(['kill-session', '-t', `=${name}`])
  let failure = 'The session did not start.'
  const report: Report = (state, fields = {}) => {
    if (state === 'failed') failure = fields.text ?? failure
    // OpenCode 1 makes its session with the first message: nobody could hand it the task.
    if (state === 'started' && !fields.sessionId) failure = 'Pool sessions need OpenCode 2 or later, whose service makes the session.'
    log('pool session start', { task: taskId, state })
  }
  running++
  try {
    const sessionId =
      tool === 'opencode'
        ? await runOpenCodeLaunch(`pool-${taskId}`, cwd, report, options, name, options.model)
        : await runLaunch(
            `pool-${taskId}`,
            cwd,
            report,
            async () => true,
            { ...options, run: options.run ?? paths.run },
            name,
            options.model,
          )
    if (sessionId) return { sessionId, tmux: name }
    tmux(['kill-session', '-t', `=${name}`])
    return failure
  } finally {
    running--
  }
}

/** Whether the pool task's session still runs in its tmux. */
export const poolSessionRuns = (tmuxName: string): boolean => tmux(['has-session', '-t', `=${tmuxName}`]).ok

/** Ends the pool task's session: its tmux goes, Claude Code with it. An OpenCode session stays in its service, idle. */
export function endPoolSession(tmuxName: string) {
  tmux(['kill-session', '-t', `=${tmuxName}`])
}

type Report = (state: StartState, fields?: Pick<StartDetail, 'text' | 'question' | 'sessionId'>) => void
/** A question Claude Code asks while starting, with a new id: true to say yes. */
type Confirm = (text: string, question: string) => Promise<boolean>

/** Marks the start as run on this machine: `taken` if one of its processes already did. */
export const claim = (launchId: string, run: string, now = Date.now()) => claimOnce(join(run, 'launches'), launchId, 2 * ORDER_TTL_MS, now)

/** The user's answer to the question a start is waiting on. */
export async function handleStartAnswer(config: AgentConfig, launchId: string, sealed: string) {
  const answer = await readOrder<StartAnswer>(config.key, sealed)
  const waiting = answers.get(launchId)
  if (!answer || !waiting || answer.launchId !== launchId || answer.machineId !== config.machineId) return
  if (answer.question === waiting.question) waiting.resolve(answer.confirm === true)
}

/** The session id once claude runs and a hook linked it, or null when the start failed (and said why). */
async function runLaunch(
  launchId: string,
  cwd: string,
  report: Report,
  confirmed: Confirm,
  options: LaunchOptions & { run: string },
  name = `tonton-${launchId}`,
  model?: string,
): Promise<string | null> {
  // `=name` matches that session only, not one whose name starts the same.
  const session = `=${name}`
  const pane = `=${name}:`
  const startedAt = Date.now()
  const shell = options.shell ?? (process.env.SHELL || '/bin/sh')
  // A login and interactive shell sets the user's PATH and the claude launcher, so the session gets the channel. tmux
  // reads `#` in the folder as a format. A pool task's model is set before its first prompt, as `/model` would.
  const command = model ? `claude --model ${model}` : 'claude'
  const created = tmux(['new-session', '-d', '-s', name, '-c', cwd.replaceAll('#', '##'), '-x', '200', '-y', '50', shell, '-lic', command])
  if (!created.ok) return failed(report, `tmux could not start: ${created.output}`)
  const belongs = paneProcess(tmux(['display-message', '-p', '-t', pane, '#{pane_pid}']).output)
  report('starting')
  const answered = new Set<string>()
  let screen = ''
  let deadline = startedAt + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_MS)
    const capture = tmux(['capture-pane', '-p', '-t', pane])
    if (!capture.ok) return failed(report, `claude stopped before it was ready.\n\n${lastLines(screen)}`)
    screen = capture.output
    // A question already answered can stay on screen a moment: only a new one waits for the user.
    const question = QUESTIONS.find(q => screen.includes(q.marker) && !answered.has(q.marker))
    if (!question) {
      const sessionId = newSession(cwd, startedAt, options.run, belongs)
      if (sessionId) {
        report('started', { text: `Running in tmux session ${name}.`, sessionId })
        return sessionId
      }
      continue
    }
    const shown = lastLines(screen)
    const confirm = await confirmed(`${question.text}\n\n${shown}`, crypto.randomUUID())
    if (!confirm) {
      tmux(['kill-session', '-t', session])
      return failed(report, 'Cancelled.')
    }
    // The answer can come minutes later: Enter only goes to the screen the user saw. If it changed, they are asked again.
    if (lastLines(tmux(['capture-pane', '-p', '-t', pane]).output) !== shown) continue
    answered.add(question.marker)
    // Both questions have their yes selected first.
    tmux(['send-keys', '-t', pane, 'Enter'])
    deadline = Date.now() + START_TIMEOUT_MS
  }
  const left = tmux(['has-session', '-t', session]).ok
    ? `claude did not show up in the notch. It still runs: tmux attach -t ${name} on this machine to see it.`
    : 'claude stopped before it was ready.'
  return failed(report, `${left}\n\n${lastLines(screen)}`)
}

const failed = (report: Report, text: string): null => {
  report('failed', { text })
  return null
}

/**
 * OpenCode 2 keeps its sessions in a background service: the session is made there in the folder, so the notch has it at
 * once, then a terminal opens on it. OpenCode 1 makes its session with the first message, which is when the notch gets it.
 */
async function runOpenCodeLaunch(
  launchId: string,
  cwd: string,
  report: Report,
  options: LaunchOptions,
  name = `tonton-${launchId}`,
  model?: string,
): Promise<string | null> {
  const access = options.openCode ?? installedOpenCode
  const shell = options.shell ?? (process.env.SHELL || '/bin/sh')
  const version = access.version(shell)
  if (version === null) return failed(report, 'opencode was not found on this machine. Install it, then try again.')
  report('starting')
  const service = version >= 2 ? access.service(shell) : null
  const sessionId = service ? await createOpenCodeSession(service, cwd) : null
  if (version >= 2 && !sessionId) return failed(report, "OpenCode's background service did not make the session.")
  const command = sessionId ? `opencode --session ${sessionId}` : 'opencode'
  const created = tmux(['new-session', '-d', '-s', name, '-c', cwd.replaceAll('#', '##'), '-x', '200', '-y', '50', shell, '-lic', command])
  if (!created.ok) return failed(report, `tmux could not start: ${created.output}`)
  await Bun.sleep(OPENCODE_SETTLE_MS)
  if (!tmux(['has-session', '-t', `=${name}`]).ok) return failed(report, 'opencode stopped before it was ready.')
  if (sessionId) {
    // OpenCode says nothing about a session until it is written to: the bridge learns it from this file.
    // The bridge switches it to the model, as the notch's `/model` does, before the task's first message.
    announceOpenCodeSession(options.run ?? paths.run, sessionId, cwd, model)
    report('started', { text: `Running in tmux session ${name}.`, sessionId })
    return sessionId
  }
  report('started', { text: `Running in tmux session ${name}. The session shows up in the notch with its first message.` })
  return null
}

/** Where the launcher leaves the OpenCode sessions it made, for the bridge of the OpenCode service to follow. */
export const openCodeStarts = (run: string) => join(run, 'opencode')

/** Where the bridge says which model it switched a launched session to, or why it could not. */
export const openCodeModelFile = (run: string, sessionId: string) => join(openCodeStarts(run), `${sessionId}.model`)

/** What a pool session reported running on: from Claude Code's status line, or from the OpenCode bridge. */
export interface EffectiveModel {
  model?: string
  problem?: string
}

/** The model the session runs on as far as it said, or null while it said nothing. */
export function effectiveModel(tool: 'claude' | 'opencode', sessionId: string, run = paths.run): EffectiveModel | null {
  try {
    if (tool === 'claude') {
      const model = (JSON.parse(readFileSync(usageFile(sessionId), 'utf8')) as { model?: unknown }).model
      return typeof model === 'string' ? { model } : null
    }
    const said = JSON.parse(readFileSync(openCodeModelFile(run, sessionId), 'utf8')) as { model?: unknown; problem?: unknown }
    if (typeof said.model === 'string') return { model: said.model }
    return typeof said.problem === 'string' ? { problem: said.problem } : null
  } catch {
    return null
  }
}

function announceOpenCodeSession(run: string, sessionId: string, cwd: string, model?: string) {
  try {
    mkdirSync(openCodeStarts(run), { recursive: true, mode: 0o700 })
    const start = { sessionId, cwd, ...(model ? { model } : {}) }
    writeFileSync(join(openCodeStarts(run), `${sessionId}.json`), JSON.stringify(start), { mode: 0o600 })
  } catch (error) {
    log('opencode: could not hand the session to the bridge', String(error))
  }
}

async function createOpenCodeSession(service: OpenCodeService, cwd: string): Promise<string | null> {
  try {
    const response = await fetch(`${service.url.replace(/\/+$/, '')}/api/session`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`opencode:${service.password}`)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ location: { directory: cwd } }),
      signal: AbortSignal.timeout(10_000),
    })
    const id = ((await response.json()) as { data?: { id?: unknown } })?.data?.id
    return typeof id === 'string' && OPENCODE_SESSION.test(id) ? id : null
  } catch (error) {
    log('opencode: no session from the service', String(error))
    return null
  }
}

/** Where OpenCode 2 writes where its service listens, and its password: `$XDG_STATE_HOME/opencode`, else `~/.local/state`. */
export function readOpenCodeService(env: Record<string, string | undefined> = process.env, home = homedir()): OpenCodeService | null {
  try {
    const file = join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'opencode', 'service.json')
    const service = JSON.parse(readFileSync(file, 'utf8')) as { url?: unknown; password?: unknown }
    return typeof service.url === 'string' && typeof service.password === 'string' ? { url: service.url, password: service.password } : null
  } catch {
    return null
  }
}

/** `opencode v2.0.32`, or `2.0.32`. */
export const openCodeMajor = (output: string): number | null => {
  const match = /(\d+)\.\d+\.\d+/.exec(output)
  return match ? Number(match[1]) : null
}

const installedOpenCode: OpenCodeAccess = {
  version: shell => {
    const result = exec([shell, '-lic', 'opencode --version'])
    return result.ok ? openCodeMajor(result.output) : null
  },
  service: shell => {
    // `opencode service start` does nothing when the service runs, and leaves it running for the terminals.
    exec([shell, '-lic', 'opencode service start'], 20_000)
    return readOpenCodeService()
  },
}

function waitForAnswer(launchId: string, question: string): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(false), ANSWER_TIMEOUT_MS)
    const finish = (confirm: boolean) => {
      clearTimeout(timer)
      answers.delete(launchId)
      resolve(confirm)
    }
    answers.set(launchId, { question, resolve: finish })
  })
}

/**
 * The session a hook linked since the start, in that folder, from a claude that `belongs` to the start. Hooks name the
 * link after the claude process, so another claude already running in the folder doesn't count.
 */
export function newSession(cwd: string, since: number, run = paths.run, belongs: (pid: number) => boolean = () => true): string | null {
  const folder = cwd.replace(/[\\/]+$/, '')
  try {
    for (const file of readdirSync(run)) {
      if (!/^\d+\.json$/.test(file) || statSync(join(run, file)).mtimeMs < since || !belongs(Number.parseInt(file, 10))) continue
      const link = JSON.parse(readFileSync(join(run, file), 'utf8')) as { sessionId?: unknown; cwd?: unknown }
      if (typeof link.sessionId === 'string' && typeof link.cwd === 'string' && link.cwd.replace(/[\\/]+$/, '') === folder)
        return link.sessionId
    }
  } catch {
    // No run folder yet: no session either.
  }
  return null
}

/**
 * Which session links come from a claude in the pane, the shell's own process or one under it. Without `ps`, or without
 * the pane's process, any link in the folder does: what is at stake is only which session the notch selects.
 */
function paneProcess(output: string): (pid: number) => boolean {
  const panePid = Number(output)
  if (!Number.isInteger(panePid) || panePid <= 1 || !exec(['ps', '-o', 'ppid=', '-p', String(process.pid)]).ok) return () => true
  const known = new Map<number, boolean>()
  return pid => {
    const cached = known.get(pid) ?? descendsFrom(pid, panePid)
    known.set(pid, cached)
    return cached
  }
}

/** Whether `pid` is `ancestor` or runs under it: claude under the shell of the tmux pane. */
export function descendsFrom(pid: number, ancestor: number): boolean {
  let current = pid
  for (let depth = 0; depth < 8 && current > 1; depth++) {
    if (current === ancestor) return true
    const parent = exec(['ps', '-o', 'ppid=', '-p', String(current)])
    current = parent.ok ? Number(parent.output) : 0
  }
  return false
}

async function readOrder<T extends { issuedAt: string }>(key: string, sealed: string, now = Date.now()): Promise<T | null> {
  const order = await open<T>(key, sealed).catch(() => null)
  if (!order || typeof order.issuedAt !== 'string') return null
  return Math.abs(now - Date.parse(order.issuedAt)) <= ORDER_TTL_MS ? order : null
}

const tmux = (args: string[]) => exec(['tmux', ...args])

function exec(command: string[], timeout = COMMAND_TIMEOUT_MS): { ok: boolean; output: string } {
  try {
    // Bun hands a child the environment the process started with: changes made since, like the tests' private tmux,
    // only count when passed.
    const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', timeout, env: { ...process.env } })
    return { ok: result.exitCode === 0, output: `${result.stdout.toString()}${result.stderr.toString()}`.trim() }
  } catch (error) {
    return { ok: false, output: String(error) }
  }
}

/** `~/code/api` as typed in the notch, from the home folder of this machine. */
export function fromHome(folder: string, home = homedir()): string {
  return folder === '~' || folder.startsWith('~/') ? join(home, folder.slice(1)) : folder
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const lastLines = (screen: string, count = 14) =>
  screen
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .slice(-count)
    .join('\n')
