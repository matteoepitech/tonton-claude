// Starts claude from the notch. An interactive Claude Code needs a terminal, so it runs in a detached tmux session; the
// questions it asks on the way (loading the channel, trusting the folder) go to the notch, and only the user's answer
// moves it on.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { StartAnswer, StartOrder, StartState } from '../../shared/protocol'
import type { RelayConnection } from './channel/relay-connection'
import { type AgentConfig, paths } from './config'
import { open, seal } from './crypto'
import { log } from './log'

/** Older orders are refused so the relay cannot replay one later. */
const ORDER_TTL_MS = 10 * 60_000
const POLL_MS = 500
/** Without news after this, the start ends: running if claude still does, failed otherwise. */
const START_TIMEOUT_MS = 90_000
/** How long a question waits for the user. */
const ANSWER_TIMEOUT_MS = 10 * 60_000

/** What Claude Code asks while starting, as it reads on screen, and what the notch shows the user. */
export const QUESTIONS = [
  { marker: 'Loading development channels', text: 'Claude Code asks to load the Tonton Claude channel, for local development.' },
  { marker: 'Quick safety check', text: 'Claude Code asks whether you trust the files in this folder.' },
]

const answers = new Map<string, (confirm: boolean) => void>()

/** Where hooks link sessions, and the shell claude starts from. Tests point them elsewhere. */
export interface LaunchOptions {
  run?: string
  shell?: string
}

/** A start order from the relay. */
export function receiveStartOrder(config: AgentConfig, launchId: string, sealed: string, relay: RelayConnection) {
  log('start order from the app', { launchId })
  void handleStartOrder(config, launchId, sealed, relay)
}

/** Runs a start order from the app, reporting each step. Only one connection of the machine gets it. */
export async function handleStartOrder(
  config: AgentConfig,
  launchId: string,
  sealed: string,
  relay: Pick<RelayConnection, 'post'>,
  options: LaunchOptions = {},
) {
  const report = (state: StartState, text?: string, sessionId?: string) =>
    relay.post(async () => ({
      t: 'session_start',
      launchId,
      state,
      detail: text ? await seal(config.key, { text }) : null,
      ...(sessionId ? { sessionId } : {}),
    }))
  const order = await readOrder<StartOrder>(config.key, sealed)
  if (!order || typeof order.cwd !== 'string') return report('failed', 'The order is not sealed with the account key, or it expired.')
  if (!isAbsolute(order.cwd) || !isDirectory(order.cwd)) return report('failed', `${order.cwd} is not a folder on this machine.`)
  if (process.platform === 'win32') return report('failed', 'Starting sessions from the notch needs tmux, which Windows does not have.')
  if (!tmux(['-V']).ok) return report('failed', 'Install tmux on this machine to start sessions from the notch.')
  await runLaunch(launchId, order.cwd, report, options)
}

/** The user's answer to the question a start is waiting on. */
export async function handleStartAnswer(config: AgentConfig, launchId: string, sealed: string) {
  const answer = await readOrder<StartAnswer>(config.key, sealed)
  const resolve = answers.get(launchId)
  if (answer && resolve) resolve(answer.confirm === true)
}

async function runLaunch(
  launchId: string,
  cwd: string,
  report: (state: StartState, text?: string, sessionId?: string) => void,
  { run = paths.run, shell = process.env.SHELL || '/bin/sh' }: LaunchOptions,
) {
  const name = `tonton-${launchId}`
  const startedAt = Date.now()
  // A login and interactive shell sets the user's PATH and the claude launcher, so the session gets the channel.
  const created = tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', shell, '-lic', 'claude'])
  if (!created.ok) return report('failed', `tmux could not start: ${created.output}`)
  report('starting')
  const answered = new Set<string>()
  let screen = ''
  let deadline = startedAt + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_MS)
    const capture = tmux(['capture-pane', '-p', '-t', name])
    if (!capture.ok) return report('failed', `claude stopped before it was ready.\n\n${lastLines(screen)}`)
    screen = capture.output
    // A question already answered can stay on screen a moment: only a new one waits for the user.
    const question = QUESTIONS.find(q => screen.includes(q.marker) && !answered.has(q.marker))
    if (!question) {
      const sessionId = newSession(cwd, startedAt, run)
      if (sessionId) return report('started', `Running in tmux session ${name}.`, sessionId)
      continue
    }
    report('asking', `${question.text}\n\n${lastLines(screen)}`)
    const confirm = await waitForAnswer(launchId)
    if (!confirm) {
      tmux(['kill-session', '-t', name])
      return report('failed', 'Cancelled.')
    }
    answered.add(question.marker)
    // Both questions have their yes selected first.
    tmux(['send-keys', '-t', name, 'Enter'])
    deadline = Date.now() + START_TIMEOUT_MS
  }
  if (tmux(['has-session', '-t', name]).ok) return report('started', `Running in tmux session ${name}.`)
  report('failed', `claude stopped before it was ready.\n\n${lastLines(screen)}`)
}

function waitForAnswer(launchId: string): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(false), ANSWER_TIMEOUT_MS)
    const finish = (confirm: boolean) => {
      clearTimeout(timer)
      answers.delete(launchId)
      resolve(confirm)
    }
    answers.set(launchId, finish)
  })
}

/** The session a hook linked since the start, in that folder. */
export function newSession(cwd: string, since: number, run = paths.run): string | null {
  const folder = cwd.replace(/[\\/]+$/, '')
  try {
    for (const file of readdirSync(run)) {
      if (!/^\d+\.json$/.test(file) || statSync(join(run, file)).mtimeMs < since) continue
      const link = JSON.parse(readFileSync(join(run, file), 'utf8')) as { sessionId?: unknown; cwd?: unknown }
      if (typeof link.sessionId === 'string' && typeof link.cwd === 'string' && link.cwd.replace(/[\\/]+$/, '') === folder)
        return link.sessionId
    }
  } catch {
    // No run folder yet: no session either.
  }
  return null
}

async function readOrder<T extends { issuedAt: string }>(key: string, sealed: string, now = Date.now()): Promise<T | null> {
  const order = await open<T>(key, sealed).catch(() => null)
  if (!order || typeof order.issuedAt !== 'string') return null
  return Math.abs(now - Date.parse(order.issuedAt)) <= ORDER_TTL_MS ? order : null
}

function tmux(args: string[]): { ok: boolean; output: string } {
  try {
    const result = Bun.spawnSync(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe' })
    return { ok: result.exitCode === 0, output: `${result.stdout.toString()}${result.stderr.toString()}`.trim() }
  } catch (error) {
    return { ok: false, output: String(error) }
  }
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
