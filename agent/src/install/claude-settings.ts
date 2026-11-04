// Adds and removes the Tonton Claude hooks in ~/.claude/settings.json without touching anything else, and builds the
// settings the launcher adds on top.

import { gitBash } from '../statusline'

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
  // Approves the calls the app's auto-approve rules allow.
  'PermissionRequest',
] as const

interface HookCommand {
  type: string
  command?: string
  args?: string[]
  timeout?: number
}

interface HookGroup {
  matcher?: string
  hooks: HookCommand[]
}

export interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>
  [key: string]: unknown
}

const isTontonHook = (hook: HookCommand) => typeof hook.command === 'string' && /[\\/]\.tonton[\\/]/.test(hook.command)

export function withoutTontonHooks(settings: ClaudeSettings): ClaudeSettings {
  const hooks: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept = groups.map(group => ({ ...group, hooks: group.hooks.filter(hook => !isTontonHook(hook)) })).filter(g => g.hooks.length)
    if (kept.length) hooks[event] = kept
  }
  const { hooks: _previous, ...rest } = settings
  return Object.keys(hooks).length ? { ...rest, hooks } : rest
}

/** Idempotent: previous Tonton Claude hooks are replaced, other hooks are kept. */
export function withTontonHooks(settings: ClaudeSettings, binary: string): ClaudeSettings {
  const clean = withoutTontonHooks(settings)
  const hooks: Record<string, HookGroup[]> = { ...clean.hooks }
  for (const event of HOOK_EVENTS) {
    // SessionEnd hooks share a short budget in Claude Code.
    const hook: HookCommand = { type: 'command', command: binary, args: ['hook'], timeout: event === 'SessionEnd' ? 2 : 5 }
    hooks[event] = [...(hooks[event] ?? []), { hooks: [hook] }]
  }
  return { ...clean, hooks }
}

/** How Claude Code runs the status line on Windows: with Git Bash or PowerShell, in an environment that can move `~`. */
export interface WindowsShell {
  env: Record<string, string | undefined>
  gitBash: boolean
}

const currentShell = (): WindowsShell => ({ env: process.env, gitBash: gitBash() !== null })

/**
 * What the launcher passes with --settings: a status line that reads plan usage, the only place Claude Code shares it.
 * Command line settings come before the project's and the user's, so the user's status line still runs from there.
 */
export function launcherSettings(binary: string, home: string, windows: boolean, shell: () => WindowsShell = currentShell): ClaudeSettings {
  return { statusLine: { type: 'command', command: `${statusLineBinary(binary, home, windows, shell)} statusline` } }
}

/** A path Git Bash and PowerShell both run as it is, with forward slashes. */
const BARE = /^[\p{L}\p{N}._\-/:+~]+$/u

/**
 * Claude Code runs status lines through a shell: sh, or on Windows Git Bash or PowerShell, which only agree on unquoted
 * paths with forward slashes. When the path needs quotes (a user name with a space), `~` keeps it out, if `~` is the
 * user's folder in both; otherwise the path is quoted for the shell Claude Code will use.
 */
function statusLineBinary(binary: string, home: string, windows: boolean, shell: () => WindowsShell): string {
  if (!windows) return `'${binary.replace(/'/g, `'\\''`)}'`
  const path = binary.replace(/\\/g, '/')
  if (BARE.test(path)) return path
  const { env, gitBash } = shell()
  const homePath = home.replace(/\\/g, '/').replace(/\/+$/, '')
  const rest = path.slice(homePath.length)
  if (path.toLowerCase().startsWith(`${homePath.toLowerCase()}/`) && BARE.test(rest) && tildeIsHome(home, env)) return `~${rest}`
  if (gitBash) return `"${path.replace(/[$`"\\]/g, '\\$&')}"`
  // A quoted path followed by an argument is a parse error in PowerShell without the call operator.
  return `& '${binary.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`
}

/**
 * Git Bash takes `~` from HOME, or else from HOMEDRIVE and HOMEPATH, like Windows PowerShell: either can point away from
 * the user's folder (a network drive on some domains, a HOME set for other tools).
 */
function tildeIsHome(home: string, env: Record<string, string | undefined>): boolean {
  const same = (path: string | undefined) => !path || folder(path) === folder(home)
  return same(env.HOME) && same(env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined)
}

/** C:\Users\Jean, c:/users/jean/ and Git Bash's /c/Users/Jean are the same folder. */
const folder = (path: string) =>
  path
    .replace(/\\/g, '/')
    .replace(/^\/([a-z])(?=\/|$)/i, '$1:')
    .replace(/\/+$/, '')
    .toLowerCase()
