// "Allow for this session" on a permission card: which calls it lets through until the session ends, made from the call
// the user just allowed. A command allows its first words and what follows them, a web page its site, other tools any of
// their calls. Mirrors app/Sources/TontonCore/SessionRule.swift; both check shared/test/session-rules.json.

import type { PermissionRule } from './protocol'
import type { Machine } from './session'

/** Agents from this version keep what "Allow for this session" allows; older ones only allow the one call. */
export const SESSION_RULES_SINCE = '0.8.0'

/** Development builds report 0.0.0 and run the current code. As `MachineInfo.keepsSessionRules` in the app. */
export function keepsSessionRules(machine: Pick<Machine, 'agentVersion'> | undefined): boolean {
  const version = machine?.agentVersion
  if (!version) return false
  if (version === '0.0.0') return true
  const [have, need] = [version, SESSION_RULES_SINCE].map(v => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if ((have[i] ?? 0) !== (need[i] ?? 0)) return (have[i] ?? 0) > (need[i] ?? 0)
  return true
}

/** As the agent matches rules (agent/src/rules.ts): shell syntax that chains or hides commands. */
const SHELL_CONTROL = /[;&|`<>\n\r]|\$\(/
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell'])
/** A second word that is a subcommand (`npm test`, `git status`), not an argument (`ls -la`, `cat ./x`). */
const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9_:-]*$/

/** What a card shows and the agent receives. Null when no rule is safe to offer: then the card has no such button. */
export interface SessionRule {
  /** `npm test`, `github.com`, `Edit`. */
  label: string
  rules: PermissionRule[]
}

export function sessionRuleFor(toolName: string, inputPreview: string): SessionRule | null {
  if (!toolName) return null
  let input: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(inputPreview)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed
  } catch {
    // A preview cut short: only tools without a pattern can be allowed.
  }
  if (COMMAND_TOOLS.has(toolName)) {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (!command) return null
    // A chained command is only ever allowed exactly as it is.
    if (SHELL_CONTROL.test(command)) return { label: command, rules: [{ tool: toolName, pattern: command }] }
    const words = command.split(/\s+/)
    const prefix = words.length > 1 && SUBCOMMAND.test(words[1]) ? `${words[0]} ${words[1]}` : words[0]
    return {
      label: prefix,
      rules: [
        { tool: toolName, pattern: prefix },
        { tool: toolName, pattern: `${prefix} *` },
      ],
    }
  }
  if (toolName === 'WebFetch') {
    let origin: string | null = null
    try {
      origin = typeof input.url === 'string' ? new URL(input.url).origin : null
    } catch {}
    if (!origin || origin === 'null') return null
    return {
      label: new URL(origin).host,
      rules: [
        { tool: toolName, pattern: origin },
        { tool: toolName, pattern: `${origin}/*` },
      ],
    }
  }
  return { label: toolName, rules: [{ tool: toolName }] }
}
