// Starts claude from the notch. An interactive Claude Code needs a terminal, so it runs in a detached tmux session; the
// questions it asks on the way (loading the channel, trusting the folder) go to the notch, and only the user's answer
// moves it on.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { StartAnswer, StartDetail, StartOrder, StartState } from '../../shared/protocol'
import type { RelayConnection } from './channel/relay-connection'
import { type AgentConfig, paths } from './config'
import { open, seal } from './crypto'
import { log } from './log'

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
}

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
  const order = await readOrder<StartOrder>(config.key, sealed)
  if (!order || order.launchId !== launchId || order.machineId !== config.machineId || typeof order.cwd !== 'string')
    return fail('The order is not sealed with the account key for this machine, or it expired.')
  const run = options.run ?? paths.run
  if (!claim(launchId, run)) return
  const cwd = fromHome(order.cwd, options.home)
  if (!isAbsolute(cwd) || !isDirectory(cwd)) return fail(`${order.cwd} is not a folder on this machine.`)
  if (process.platform === 'win32') return fail('Starting sessions from the notch needs tmux, which Windows does not have.')
  if (!tmux(['-V']).ok) return fail('Install tmux on this machine to start sessions from the notch.')
  if (running >= MAX_RUNNING) return fail('Too many sessions are starting on this machine. Try again in a minute.')
  running++
  try {
    await runLaunch(launchId, cwd, report, { ...options, run })
  } finally {
    running--
  }
}

type Report = (state: StartState, fields?: Pick<StartDetail, 'text' | 'question' | 'sessionId'>) => void

/** Marks the start as run, in a file every process of the machine sees. False if one already did. */
export function claim(launchId: string, run: string, now = Date.now()): boolean {
  const folder = join(run, 'launches')
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    for (const file of readdirSync(folder))
      if (now - statSync(join(folder, file)).mtimeMs > 2 * ORDER_TTL_MS) rmSync(join(folder, file), { force: true })
    writeFileSync(join(folder, launchId), '', { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** The user's answer to the question a start is waiting on. */
export async function handleStartAnswer(config: AgentConfig, launchId: string, sealed: string) {
  const answer = await readOrder<StartAnswer>(config.key, sealed)
  const waiting = answers.get(launchId)
  if (!answer || !waiting || answer.launchId !== launchId || answer.machineId !== config.machineId) return
  if (answer.question === waiting.question) waiting.resolve(answer.confirm === true)
}

async function runLaunch(launchId: string, cwd: string, report: Report, options: LaunchOptions & { run: string }) {
  const name = `tonton-${launchId}`
  // `=name` matches that session only, not one whose name starts the same.
  const session = `=${name}`
  const pane = `=${name}:`
  const startedAt = Date.now()
  const shell = options.shell ?? (process.env.SHELL || '/bin/sh')
  // A login and interactive shell sets the user's PATH and the claude launcher, so the session gets the channel. tmux
  // reads `#` in the folder as a format.
  const created = tmux(['new-session', '-d', '-s', name, '-c', cwd.replaceAll('#', '##'), '-x', '200', '-y', '50', shell, '-lic', 'claude'])
  if (!created.ok) return report('failed', { text: `tmux could not start: ${created.output}` })
  const panePid = Number(tmux(['display-message', '-p', '-t', pane, '#{pane_pid}']).output)
  report('starting')
  const answered = new Set<string>()
  let screen = ''
  let deadline = startedAt + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_MS)
    const capture = tmux(['capture-pane', '-p', '-t', pane])
    if (!capture.ok) return report('failed', { text: `claude stopped before it was ready.\n\n${lastLines(screen)}` })
    screen = capture.output
    // A question already answered can stay on screen a moment: only a new one waits for the user.
    const question = QUESTIONS.find(q => screen.includes(q.marker) && !answered.has(q.marker))
    if (!question) {
      const sessionId = newSession(cwd, startedAt, options.run, pid => descendsFrom(pid, panePid))
      if (sessionId) return report('started', { text: `Running in tmux session ${name}.`, sessionId })
      continue
    }
    const id = crypto.randomUUID()
    report('asking', { text: `${question.text}\n\n${lastLines(screen)}`, question: id })
    const confirm = await waitForAnswer(launchId, id)
    if (!confirm) {
      tmux(['kill-session', '-t', session])
      return report('failed', { text: 'Cancelled.' })
    }
    // The answer can come minutes later: Enter only goes to the question the user saw.
    if (!tmux(['capture-pane', '-p', '-t', pane]).output.includes(question.marker)) continue
    answered.add(question.marker)
    // Both questions have their yes selected first.
    tmux(['send-keys', '-t', pane, 'Enter'])
    deadline = Date.now() + START_TIMEOUT_MS
  }
  const left = tmux(['has-session', '-t', session]).ok
    ? `claude did not show up in the notch. It still runs: tmux attach -t ${name} on this machine to see it.`
    : 'claude stopped before it was ready.'
  report('failed', { text: `${left}\n\n${lastLines(screen)}` })
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

function exec(command: string[]): { ok: boolean; output: string } {
  try {
    const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', timeout: COMMAND_TIMEOUT_MS })
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
