// The status line of sessions started with the launcher (passed with --settings). Claude Code shares plan usage with
// status lines only, so this one records it for the session's channel, then shows the user's own status line, if any.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from './log'
import { statusLineLimit, writeUsage } from './usage'

/** Claude Code cancels a status line when the next update comes; this only bounds a command that hangs. */
const USER_COMMAND_TIMEOUT_MS = 10_000

interface StatusLineInput {
  session_id?: unknown
  cwd?: unknown
  workspace?: { project_dir?: unknown }
  model?: { display_name?: unknown }
  context_window?: { used_percentage?: unknown }
}

/** Never fails: a status line that errors goes blank, and Claude Code must not notice anything else. */
export async function runStatusLine() {
  const raw = await Bun.stdin.text()
  let input: StatusLineInput = {}
  try {
    input = JSON.parse(raw) ?? {}
  } catch {
    log('status line: unreadable input')
  }
  try {
    const fiveHourLimit = statusLineLimit(input)
    if (typeof input.session_id === 'string' && fiveHourLimit) writeUsage(input.session_id, { fiveHourLimit })
  } catch (error) {
    log('status line: could not record usage', String(error))
  }
  const projectDir = text(input.workspace?.project_dir) ?? text(input.cwd)
  const command = userStatusLine(projectDir, process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
  process.stdout.write(command ? await runUserCommand(command, raw) : defaultLine(input))
}

/**
 * The status line the user set up, in the order Claude Code reads settings below the command line: the project's local
 * settings, the project's settings, then the user's.
 */
export function userStatusLine(projectDir: string | undefined, configDir: string): string | null {
  const files = [
    ...(projectDir ? [join(projectDir, '.claude', 'settings.local.json'), join(projectDir, '.claude', 'settings.json')] : []),
    join(configDir, 'settings.json'),
  ]
  for (const file of files) {
    const statusLine = readSettings(file)?.statusLine as { type?: unknown; command?: unknown } | undefined
    if (statusLine?.type !== 'command' || typeof statusLine.command !== 'string' || !statusLine.command.trim()) continue
    if (!isTontonStatusLine(statusLine.command)) return statusLine.command
  }
  return null
}

export const isTontonStatusLine = (command: string) => /tonton(\.exe)?['"]?\s+statusline\b/.test(command)

/** Without a status line of their own, users get a short one rather than an empty row. */
export function defaultLine(input: StatusLineInput): string {
  const context = input.context_window?.used_percentage
  const limit = statusLineLimit(input)
  const parts = [
    text(input.model?.display_name),
    typeof context === 'number' ? `${Math.round(context)}% context` : undefined,
    limit ? `5h ${Math.round(limit.usedPercent)}%` : undefined,
  ]
  return parts.filter(Boolean).join(' · ')
}

/** Runs the command through a shell like Claude Code does, with the same input. Its output only counts if it succeeds. */
async function runUserCommand(command: string, input: string): Promise<string> {
  try {
    const child = Bun.spawn([...shell(), command], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'ignore' })
    const timer = setTimeout(() => child.kill(), USER_COMMAND_TIMEOUT_MS)
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    clearTimeout(timer)
    return code === 0 ? output : ''
  } catch (error) {
    log('status line: the user command failed to start', String(error))
    return ''
  }
}

/** On Windows, Claude Code uses Git Bash when it is installed and PowerShell otherwise. */
function shell(): string[] {
  if (process.platform !== 'win32') return ['/bin/sh', '-c']
  const gitBash = process.env.CLAUDE_CODE_GIT_BASH_PATH || join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
  return existsSync(gitBash) ? [gitBash, '-c'] : ['powershell', '-NoProfile', '-Command']
}

function readSettings(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
