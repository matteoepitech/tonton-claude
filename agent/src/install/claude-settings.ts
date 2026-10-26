// Adds and removes the Tonton Claude hooks in ~/.claude/settings.json without touching anything else, and builds the
// settings the launcher adds on top.

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'] as const

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

/**
 * What the launcher passes with --settings: a status line that reads plan usage, the only place Claude Code shares it.
 * Command line settings come before the project's and the user's, so the user's status line still runs from there.
 */
export function launcherSettings(binary: string, home: string, windows: boolean): ClaudeSettings {
  return { statusLine: { type: 'command', command: `${statusLineBinary(binary, home, windows)} statusline` } }
}

/**
 * Claude Code runs status lines through a shell: sh, or on Windows Git Bash or PowerShell, which only agree on unquoted
 * paths with forward slashes. `~` keeps the user name, which can hold spaces, out of it.
 */
function statusLineBinary(binary: string, home: string, windows: boolean): string {
  if (!windows) return `'${binary.replace(/'/g, `'\\''`)}'`
  const path = binary.replace(/\\/g, '/')
  const homePath = home.replace(/\\/g, '/').replace(/\/+$/, '')
  if (path.toLowerCase().startsWith(`${homePath.toLowerCase()}/`)) return `~${path.slice(homePath.length)}`
  return path.includes(' ') ? `"${path}"` : path
}
