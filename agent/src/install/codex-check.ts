// How Codex sees Tonton's integration: whether the hooks and the MCP server are there, and whether the user trusted the
// hooks in Codex's /hooks, without which Codex does not run them. Codex keeps the hash of each hook it was told to trust
// in config.toml, under the hook's file and place. The hash is Codex's own (command_hook_hash in
// codex-rs/hooks/src/engine/discovery.rs, as of 0.142.2): a Codex that hashed another way would show trusted hooks as
// changed, and the check says that it can only tell as far as it knows the hash.

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  CODEX_HOOK_EVENTS,
  type CodexFiles,
  type CodexHookEvent,
  type CodexHooksFile,
  codexFiles,
  codexHookGroup,
  codexHookPlace,
  codexRunCommand,
  hasTontonCodexHooks,
  MCP_SERVER,
  passesAgentEnvironment,
  readCodexConfig,
  readCodexHooks,
  runsAgentChannel,
} from './codex'
import { parseToml, tomlValueAt } from './toml-table'

/** Codex's name for an event in its keys and hashes: `pre_tool_use` for PreToolUse. */
export const codexEventKey = (event: string) => event.replace(/[A-Z]/g, (char, index: number) => `${index ? '_' : ''}${char.toLowerCase()}`)

/** Events Codex reads no matcher for: it leaves theirs out, of the hash too. */
const NO_MATCHER = new Set<string>(['UserPromptSubmit', 'Stop'])

/** What Codex hashes for a command hook: the event, the matcher and the hook, its defaults filled in, keys sorted. */
export function codexHookHash(event: string, matcher: string | undefined, command: string, timeout?: number): string {
  const identity = {
    event_name: codexEventKey(event),
    hooks: [{ async: false, command, timeout: Math.max(1, timeout ?? 600), type: 'command' }],
    ...(matcher !== undefined && !NO_MATCHER.has(event) ? { matcher } : {}),
  }
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortedKeys(identity)))
    .digest('hex')}`
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, sortedKeys((value as Record<string, unknown>)[key])]),
  )
}

export interface CodexHookState {
  enabled?: boolean
  trustedHash?: string
}

/**
 * What Codex recorded in config.toml (`[hooks.state."<file>:<event>:<group>:<hook>"]`) for the hooks of one file, by
 * `<event>:<group>:<hook>`. Codex writes the file's path as it resolved it: CODEX_HOME without its links.
 */
export function codexHookStates(config: Record<string, unknown>, file: string): Map<string, CodexHookState> {
  const states = new Map<string, CodexHookState>()
  const recorded = tomlValueAt(config, ['hooks', 'state'])
  if (typeof recorded !== 'object' || recorded === null) return states
  const real = resolved(file)
  for (const [key, value] of Object.entries(recorded)) {
    const parts = /^(.*):([a-z_]+:\d+:\d+)$/.exec(key.trim())
    if (!parts?.[1] || !parts[2] || typeof value !== 'object' || value === null) continue
    if (parts[1] !== file && resolved(parts[1]) !== real) continue
    const { enabled, trusted_hash } = value as { enabled?: unknown; trusted_hash?: unknown }
    states.set(parts[2], {
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
      ...(typeof trusted_hash === 'string' ? { trustedHash: trusted_hash } : {}),
    })
  }
  return states
}

/** A file's path with no link in its folder's, as Rust's canonicalize gives it: Windows adds `\\?\`, and ignores case. */
function resolved(file: string): string {
  let real = file
  try {
    real = join(realpathSync.native(dirname(file)), basename(file))
  } catch {}
  return process.platform === 'win32' ? real.replace(/^\\\\\?\\/, '').toLowerCase() : real
}

export interface CodexCheck {
  ok: boolean
  detail: string
  /** Whether installing again would fix it. */
  repair: boolean
}

/** Tonton's integration in a Codex folder, for the diagnosis and `tonton status`. */
export function checkCodex(binary: string, dir: string, platform: NodeJS.Platform = process.platform): CodexCheck {
  const files = codexFiles(dir)
  const read = readFiles(files)
  if (typeof read === 'string') return { ok: false, detail: read, repair: false }
  const problems = installProblems(read.hooks, read.config, binary, platform)
  if (problems.length) return { ok: false, detail: `In ${dir}: ${problems.join('; ')}.`, repair: true }
  const problem = settingProblem(read.config, files) ?? trustProblem(read.hooks, read.config, files, binary, platform)
  if (problem) return { ok: false, detail: problem, repair: false }
  return { ok: true, detail: `Hooks trusted, and the tonton MCP server set up, in ${dir}.`, repair: false }
}

/** Both files as Codex reads them, or why one can't be read: nothing repairs a file the user may be editing. */
function readFiles(files: CodexFiles): { hooks: CodexHooksFile; config: Record<string, unknown> } | string {
  const hooks = readCodexHooks(files.hooks)
  if (!hooks) return `${files.hooks} is not a hooks file Codex can read. Fix it by hand, then repair Codex.`
  let text: string | null
  try {
    text = readCodexConfig(files.config)
  } catch {
    return `Could not read ${files.config}.`
  }
  const config = text === null ? {} : parseToml(text)
  if (!config) return `${files.config} is not valid TOML. Fix it by hand, then repair Codex.`
  return { hooks: hooks.hooks, config }
}

/** What an install would add or update. */
function installProblems(hooks: CodexHooksFile, config: Record<string, unknown>, binary: string, platform: NodeJS.Platform): string[] {
  const problems: string[] = []
  const missing = CODEX_HOOK_EVENTS.filter(event => !codexHookPlace(hooks, event, binary, platform))
  if (missing.length) {
    const which = missing.length === CODEX_HOOK_EVENTS.length ? "Tonton's hooks" : `the hooks for ${missing.join(', ')}`
    problems.push(`${which} ${hasTontonCodexHooks(hooks, binary, platform) ? 'are out of date' : 'are missing'}`)
  }
  const server = tomlValueAt(config, MCP_SERVER)
  if (server === undefined) problems.push('the tonton MCP server is missing')
  else if (!runsAgentChannel(server, binary))
    problems.push(`the tonton MCP server runs ${String((server as { command?: unknown } | null)?.command)}, not this agent`)
  else if (!passesAgentEnvironment(server)) problems.push('the tonton MCP server is out of date')
  return problems
}

/** What the user turned off in config.toml, which stays off. */
function settingProblem(config: Record<string, unknown>, files: CodexFiles): string | null {
  if ((tomlValueAt(config, MCP_SERVER) as { enabled?: unknown } | undefined)?.enabled === false)
    return `The tonton MCP server is turned off in ${files.config} (enabled = false).`
  // `hooks`, on unless turned off; `codex_hooks` is its older name, which `hooks` overrides when both are set.
  const features = tomlValueAt(config, ['features']) as Record<string, unknown> | undefined
  const set = ['hooks', 'codex_hooks'].find(name => typeof features?.[name] === 'boolean')
  return set && features?.[set] === false ? `Hooks are turned off in Codex: features.${set} is false in ${files.config}.` : null
}

/** Hooks the user did not trust in Codex's /hooks, or turned off there: only they can change that. */
function trustProblem(
  hooks: CodexHooksFile,
  config: Record<string, unknown>,
  files: CodexFiles,
  binary: string,
  platform: NodeJS.Platform,
): string | null {
  const states = codexHookStates(config, files.hooks)
  const off: CodexHookEvent[] = []
  const untrusted: CodexHookEvent[] = []
  const changed: CodexHookEvent[] = []
  for (const event of CODEX_HOOK_EVENTS) {
    const place = codexHookPlace(hooks, event, binary, platform)
    const state = place ? states.get(`${codexEventKey(event)}:${place.group}:${place.handler}`) : undefined
    const { matcher, hooks: handlers } = codexHookGroup(event, binary, platform)
    const hook = handlers[0]
    if (state?.enabled === false) off.push(event)
    else if (!state?.trustedHash) untrusted.push(event)
    else if (state.trustedHash !== codexHookHash(event, matcher, (hook && codexRunCommand(hook, platform)) ?? '', hook?.timeout))
      changed.push(event)
  }
  if (off.length) return `Turned off in Codex's /hooks: ${off.join(', ')}.`
  if (untrusted.length === CODEX_HOOK_EVENTS.length)
    return "Installed, but Codex runs a hook only once you trust it: open /hooks in Codex and trust Tonton's hooks."
  if (untrusted.length) return `Not trusted yet: ${untrusted.join(', ')}. Open /hooks in Codex and trust them.`
  if (changed.length)
    return `Trusted before they changed, as far as this agent reads Codex's hashes: ${changed.join(', ')}. Open /hooks in Codex and trust them again.`
  return null
}
