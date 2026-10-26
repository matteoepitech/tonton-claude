// Types slash commands in the terminal a session runs in. A channel can only add messages to the conversation, and
// Claude Code reads `/compact` there as text, but a session running in tmux can be typed into like a keyboard would.

import { join } from 'node:path'
import type { ModelAlias, SessionCommand } from '../../../shared/protocol'
import { claimOnce } from '../once'

/** The tmux server and pane of a Claude Code process, from the environment its hooks inherit. */
export interface TerminalPane {
  socket: string
  pane: string
}

export const COMMANDS: readonly SessionCommand['name'][] = ['compact', 'clear', 'model', 'interrupt']
const MODELS: readonly ModelAlias[] = ['opus', 'sonnet', 'haiku']
/** Older commands are refused so the relay cannot replay one later, as with update orders. */
const COMMAND_TTL_MS = 10 * 60_000
const COMMAND_ID = /^[a-z0-9-]{8,64}$/
const TMUX_TIMEOUT_MS = 5000

export function terminalOf(env: Record<string, string | undefined> = process.env): TerminalPane | null {
  const socket = env.TMUX?.split(',')[0]
  const pane = env.TMUX_PANE
  return socket && pane && /^%\d+$/.test(pane) ? { socket, pane } : null
}

export type CommandResult = { typed: true } | { typed: false; why: string | null }

/**
 * Checks a command from the app and types it in the session's terminal. `why` is null for a command already run, which
 * a replay brings back and which deserves no answer.
 */
export function runCommand(
  command: SessionCommand,
  sessionId: string,
  terminal: TerminalPane | null,
  { run, now = Date.now(), tmux = runTmux }: { run: string; now?: number; tmux?: Tmux },
): CommandResult {
  const refuse = (why: string): CommandResult => ({ typed: false, why })
  const invalid = whyInvalid(command, sessionId, now)
  if (invalid) return refuse(invalid)
  if (!terminal) return refuse('This session does not run in tmux, so commands from the notch cannot be typed in it.')
  const claimed = claimCommand(command, run, now)
  if (claimed !== true) return claimed
  // Escape stops Claude where it is, like in the terminal: it is meant for when Claude works.
  if (command.name === 'interrupt') {
    const pressed = tmux(terminal, ['send-keys', '-t', terminal.pane, 'Escape'])
    return pressed.ok ? { typed: true } : refuse(`tmux could not press Escape in the terminal: ${pressed.output}`)
  }
  const text = commandText(command)
  if (!text) return refuse('The command is not for this session.')
  const screen = tmux(terminal, ['capture-pane', '-p', '-t', terminal.pane])
  if (!screen.ok) return refuse(`tmux could not read the terminal: ${screen.output}`)
  const busy = whyBusy(screen.output)
  if (busy) return refuse(busy)
  // Literally, then Enter: the text comes from the lists above, never from the relay.
  const typed = tmux(terminal, ['send-keys', '-t', terminal.pane, '-l', text])
  if (!typed.ok) return refuse(`tmux could not type in the terminal: ${typed.output}`)
  tmux(terminal, ['send-keys', '-t', terminal.pane, 'Enter'])
  return { typed: true }
}

/** Why a command from the app must not run in this session, or null. Also used for OpenCode sessions. */
export function whyInvalid(command: SessionCommand, sessionId: string, now = Date.now()): string | null {
  const known = command.name === 'interrupt' ? command.model === undefined : commandText(command) !== null
  if (!known || command.sessionId !== sessionId || !COMMAND_ID.test(command.id)) return 'The command is not for this session.'
  if (!(Math.abs(now - Date.parse(command.issuedAt)) <= COMMAND_TTL_MS)) return 'The command expired. Check the clock of this machine.'
  return null
}

/** Each command runs once, whichever of the machine's connections gets it first. A replay gets no answer. */
export function claimCommand(command: SessionCommand, run: string, now = Date.now()): true | { typed: false; why: string | null } {
  const claimed = claimOnce(join(run, 'commands'), command.id, 2 * COMMAND_TTL_MS, now)
  if (claimed === 'taken') return { typed: false, why: null }
  if (claimed instanceof Error) return { typed: false, why: `Could not record the command on this machine: ${claimed.message}` }
  return true
}

/** What to type for a known command, or null. A model is one of the aliases, and only `/model` takes one. */
export function commandText({ name, model }: SessionCommand): string | null {
  if (!COMMANDS.includes(name) || name === 'interrupt') return null
  if (name !== 'model') return model === undefined ? `/${name}` : null
  return model !== undefined && MODELS.includes(model) ? `/model ${model}` : null
}

/** Enter must only submit the command: not while Claude works, nor on a question with its own choices. */
export function whyBusy(screen: string): string | null {
  if (/esc to interrupt/i.test(screen)) return 'Claude is working. Try again once it is done.'
  // Its choices have a ❯ before the selected one; a `>` can be the prompt with a draft that starts like a list.
  if (/^[\s│|]*❯\s*\d+\.\s/m.test(screen)) return 'Claude Code is asking something in the terminal. Answer it first.'
  return null
}

type Tmux = (terminal: TerminalPane, args: string[]) => { ok: boolean; output: string }

function runTmux(terminal: TerminalPane, args: string[]) {
  try {
    const result = Bun.spawnSync(['tmux', '-S', terminal.socket, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: TMUX_TIMEOUT_MS })
    return { ok: result.exitCode === 0, output: `${result.stdout.toString()}${result.stderr.toString()}`.trim() }
  } catch (error) {
    return { ok: false, output: String(error) }
  }
}
