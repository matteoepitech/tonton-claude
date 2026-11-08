// Tonton in Codex: its hooks in $CODEX_HOME/hooks.json and its MCP server in $CODEX_HOME/config.toml. The hooks go to
// hooks.json rather than to [hooks] in config.toml: a JSON file that Codex only reads, while config.toml is the user's and
// Codex writes to it too. Codex keys the trust of a hook by its place in its file, so an install keeps Tonton's hooks
// where they are and adds new ones after the user's: no one's trust moves to another hook.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROXY_VARIABLES } from '../proxy'
import { parseToml, removeTomlTable, setTomlTable, type TomlEdit, type TomlTable, tomlValueAt } from './toml-table'

/** Codex's folder: `$CODEX_HOME`, else `~/.codex`, on every platform. */
export function codexHome(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return env.CODEX_HOME || join(home, '.codex')
}

/** Codex is set up on this machine: its folder exists, or `codex` is on the PATH. */
export function hasCodex(dir = codexHome(), onPath = () => Bun.which('codex') !== null): boolean {
  return existsSync(dir) || onPath()
}

/** Where the integration lives in a Codex folder. */
export interface CodexFiles {
  hooks: string
  config: string
}

export const codexFiles = (dir: string): CodexFiles => ({ hooks: join(dir, 'hooks.json'), config: join(dir, 'config.toml') })

export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop'] as const
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number]

/**
 * The tools an event's hook runs for, when not all. Before a tool call, only edits, as with Claude Code: a hook before
 * every call would slow every one down. `apply_patch` is Codex's edit tool, which matchers also reach as `Edit` and
 * `Write`. After a call, every tool: Codex has no event for an answered permission request, and the next PostToolUse is
 * what tells the notch the turn goes on. A matcher is part of what the user trusts: changing one makes them trust the
 * hook again.
 */
const MATCHERS: Partial<Record<CodexHookEvent, string>> = { PreToolUse: 'apply_patch' }
/** Seconds. Codex waits for a hook before it goes on, ten minutes unless told otherwise. */
const HOOK_TIMEOUT = 5

/**
 * What Codex runs for each of Tonton's hooks. Codex hands it to the user's shell (`$SHELL -c`), and `exec` makes the
 * shell hand its pid over to the agent, so the hook's parent is codex, as its channel's is (agent/src/codex/hook.ts). On
 * Windows this is the command for `cmd /C`, which Codex only falls back to: cmd has no `exec`, and Codex 0.142.2 escapes
 * quotes in a way cmd does not read, so a path cmd takes as it is goes in without them. See `codexHookCommandWindows`.
 */
export function codexHookCommand(binary: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `${/^[^\s"&|<>^%()!,;=]+$/.test(binary) ? binary : `"${binary}"`} hook codex`
  return `exec '${binary.replace(/'/g, `'\\''`)}' hook codex`
}

/**
 * What Codex runs on Windows (`command_windows`): it hands hooks to PowerShell (`powershell -NoProfile -Command`), which
 * takes a quoted path followed by words as a string and a parse error, so the path goes through the call operator, in
 * single quotes that Codex's escaping leaves alone.
 */
export const codexHookCommandWindows = (binary: string): string => `& '${binary.replace(/'/g, "''")}' hook codex`

/** The command Codex runs and hashes for a hook on this platform: `command_windows` on Windows, when there is one. */
export function codexRunCommand(hook: CodexHookHandler, platform: NodeJS.Platform = process.platform): string | undefined {
  const windows = platform === 'win32' && typeof hook.command_windows === 'string' ? hook.command_windows : undefined
  return windows ?? hook.command
}

export interface CodexHookHandler {
  type: string
  command?: string
  command_windows?: string
  timeout?: number
  [key: string]: unknown
}

export interface CodexHookGroup {
  matcher?: string
  hooks: CodexHookHandler[]
  [key: string]: unknown
}

export interface CodexHooksFile {
  hooks?: Record<string, CodexHookGroup[]>
  [key: string]: unknown
}

/** Tonton's group for one event, as an install writes it. */
export function codexHookGroup(event: CodexHookEvent, binary: string, platform: NodeJS.Platform = process.platform): CodexHookGroup {
  const windows = platform === 'win32' ? { command_windows: codexHookCommandWindows(binary) } : {}
  const hook: CodexHookHandler = { type: 'command', command: codexHookCommand(binary, platform), ...windows, timeout: HOOK_TIMEOUT }
  const matcher = MATCHERS[event]
  return matcher ? { matcher, hooks: [hook] } : { hooks: [hook] }
}

/** A hook of an older install, or of an agent somewhere else: still Tonton's. */
const TONTON_COMMAND = /(?:^|[\s'"\\/])tonton(?:\.exe)?['"]? hook codex$/

const isTontonHook = (hook: CodexHookHandler, command: string) =>
  hook.command === command || (typeof hook.command === 'string' && TONTON_COMMAND.test(hook.command))

/** The group without Tonton's hooks, none when nothing else was in it. */
const withoutTontonIn = (group: CodexHookGroup, command: string): CodexHookGroup[] => {
  const hooks = group.hooks.filter(hook => !isTontonHook(hook, command))
  if (hooks.length === group.hooks.length) return [group]
  return hooks.length ? [{ ...group, hooks }] : []
}

/**
 * Idempotent, and nothing moves: an event that has Tonton's hook keeps it, an older one of Tonton's is replaced where it
 * is, and a missing one goes after the user's. Install takes nothing out, so no hook takes another's place and its trust.
 */
export function withCodexHooks(file: CodexHooksFile, binary: string, platform: NodeJS.Platform = process.platform): CodexHooksFile {
  const command = codexHookCommand(binary, platform)
  const hooks: Record<string, CodexHookGroup[]> = { ...file.hooks }
  for (const event of CODEX_HOOK_EVENTS) {
    if (codexHookPlace(file, event, binary, platform)) continue
    const group = codexHookGroup(event, binary, platform)
    const groups = hooks[event] ?? []
    const older = groups.findIndex(existing => existing.hooks.length > 0 && existing.hooks.every(hook => isTontonHook(hook, command)))
    hooks[event] = older >= 0 ? groups.map((existing, index) => (index === older ? group : existing)) : [...groups, group]
  }
  return { ...file, hooks }
}

/** Whether the file has a hook of Tonton's, of this install or an older one. */
export function hasTontonCodexHooks(file: CodexHooksFile, binary: string, platform: NodeJS.Platform = process.platform): boolean {
  const command = codexHookCommand(binary, platform)
  return Object.values(file.hooks ?? {}).some(groups => groups.some(group => group.hooks.some(hook => isTontonHook(hook, command))))
}

/**
 * The file without Tonton's hooks; the same file when it has none. A hook the user put after one of Tonton's, in the same
 * event, moves up a place: Codex, which keys trust by place, asks them to trust it again.
 */
export function withoutCodexHooks(file: CodexHooksFile, binary: string, platform: NodeJS.Platform = process.platform): CodexHooksFile {
  if (!hasTontonCodexHooks(file, binary, platform)) return file
  const command = codexHookCommand(binary, platform)
  // An event left with no group goes; one the user left empty stays.
  const kept = Object.entries(file.hooks ?? {}).flatMap(([event, groups]) => {
    const others = groups.flatMap(group => withoutTontonIn(group, command))
    return others.length || !groups.length ? [[event, others] as const] : []
  })
  const { hooks: _previous, ...rest } = file
  return kept.length ? { ...rest, hooks: Object.fromEntries(kept) } : rest
}

/** Where an event's hook is in the file, as Codex counts it for its trust: null when the file does not have it as installed. */
export function codexHookPlace(
  file: CodexHooksFile,
  event: CodexHookEvent,
  binary: string,
  platform: NodeJS.Platform = process.platform,
): { group: number; handler: number } | null {
  const wanted = codexHookGroup(event, binary, platform)
  const groups = file.hooks?.[event] ?? []
  for (const [group, existing] of groups.entries()) {
    if (existing.matcher !== wanted.matcher) continue
    const handler = existing.hooks.findIndex(hook => Bun.deepEquals(hook, wanted.hooks[0], true))
    if (handler >= 0) return { group, handler }
  }
  return null
}

/** `raw` is null when there is no file. Null when it is not a file Codex can read: nothing must overwrite it then. */
export function readCodexHooks(file: string): { hooks: CodexHooksFile; raw: string | null } | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { hooks: {}, raw: null }
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return isHooksFile(parsed) ? { hooks: parsed, raw } : null
  } catch {
    return null
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** As Codex reads it: `hooks` and nothing else at the top, a list of groups for each event. */
function isHooksFile(value: unknown): value is CodexHooksFile {
  if (!isObject(value) || Object.keys(value).some(key => key !== 'hooks')) return false
  if (value.hooks === undefined) return true
  if (!isObject(value.hooks)) return false
  return Object.values(value.hooks).every(
    groups => Array.isArray(groups) && groups.every(group => isObject(group) && Array.isArray(group.hooks) && group.hooks.every(isObject)),
  )
}

/** config.toml's text, null when there is none. */
export function readCodexConfig(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export const MCP_SERVER = ['mcp_servers', 'tonton']

/**
 * What the channel needs from Codex's environment, which Codex does not pass on: it starts MCP servers with a few
 * variables only (HOME, PATH, USER…). Tonton's own folder and switches, Codex's folder, and the proxy.
 */
export const CODEX_ENV_VARS = ['TONTON_HOME', 'TONTON_SERVICE', 'CODEX_HOME', ...PROXY_VARIABLES]

/**
 * The server Codex starts for each session, as config.toml holds it, given the one there now: the variables the user
 * passes on too stay, in their order, and Tonton's go after. A list with entries this agent does not write (a table
 * with a `source`) is the user's: it is left as it is.
 */
export function codexMcpServer(binary: string, current?: unknown): TomlTable {
  const server = { command: binary, args: ['channel', 'codex'] }
  const listed = isObject(current) ? current.env_vars : undefined
  if (listed !== undefined && !isNameList(listed)) return server
  const kept = listed ?? []
  return { ...server, env_vars: [...kept, ...CODEX_ENV_VARS.filter(name => !kept.includes(name))] }
}

const isNameList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

/** Whether the server passes the channel what it needs from Codex's environment, or lists variables its own way. */
export function passesAgentEnvironment(server: unknown): boolean {
  const listed = isObject(server) ? server.env_vars : undefined
  return listed !== undefined && (!isNameList(listed) || CODEX_ENV_VARS.every(name => listed.includes(name)))
}

/** The tonton server of a config.toml's text, undefined when there is none or the text is no TOML. */
function currentServer(text: string): unknown {
  const document = parseToml(text)
  return document ? tomlValueAt(document, MCP_SERVER) : undefined
}

/** Whether a server of config.toml runs this agent's channel. Other keys, `enabled` among them, are the user's. */
export function runsAgentChannel(server: unknown, binary: string): boolean {
  if (!isObject(server)) return false
  return server.command === binary && Bun.deepEquals(server.args, codexMcpServer(binary).args)
}

export type CodexEdit = ({ ok: true; changed: boolean } & CodexFiles) | { ok: false; reason: string }

/** Adds Tonton's hooks and MCP server to a Codex folder. Never trusts the hooks: only the user can, in Codex's /hooks. */
export function installCodex(binary: string, dir = codexHome(), platform: NodeJS.Platform = process.platform): CodexEdit {
  return editCodex(
    dir,
    hooks => withCodexHooks(hooks, binary, platform),
    config => setTomlTable(config, MCP_SERVER, codexMcpServer(binary, currentServer(config))),
  )
}

/** Takes Tonton's hooks and MCP server out, and nothing else: what Codex recorded of them stays Codex's. */
export function removeCodex(binary: string, dir = codexHome(), platform: NodeJS.Platform = process.platform): CodexEdit {
  return editCodex(
    dir,
    hooks => withoutCodexHooks(hooks, binary, platform),
    config => removeTomlTable(config, MCP_SERVER),
  )
}

/** Both edits are worked out before either file is written: when one is refused, neither file is written. */
function editCodex(dir: string, editHooks: (file: CodexHooksFile) => CodexHooksFile, editConfig: (text: string) => TomlEdit): CodexEdit {
  const files = codexFiles(dir)
  try {
    const current = readCodexHooks(files.hooks)
    if (!current) return { ok: false, reason: `${files.hooks} is not a hooks file Codex can read` }
    const config = editConfig(readCodexConfig(files.config) ?? '')
    if (!config.ok) return { ok: false, reason: `${files.config} ${config.reason}` }
    const hooks = editHooks(current.hooks)
    const hooksChanged = JSON.stringify(hooks) !== JSON.stringify(current.hooks)
    if (hooksChanged || config.changed) mkdirSync(dir, { recursive: true })
    if (hooksChanged) writeHooksFile(files.hooks, hooks, current.raw)
    if (config.changed) {
      if (config.text) writeFileSync(files.config, config.text)
      else rmSync(files.config, { force: true })
    }
    return { ok: true, changed: hooksChanged || config.changed, ...files }
  } catch (error) {
    return { ok: false, reason: `${dir} could not be updated: ${error instanceof Error ? error.message : error}` }
  }
}

/** Keeps a copy of the user's own file as it was before Tonton's hooks, once; a file left with no hook at all goes. */
function writeHooksFile(file: string, hooks: CodexHooksFile, raw: string | null) {
  const backup = `${file}.tonton-backup`
  if (raw !== null && !existsSync(backup) && !raw.includes(' hook codex')) writeFileSync(backup, raw)
  if (Object.keys(hooks).length) writeFileSync(file, `${JSON.stringify(hooks, null, 2)}\n`)
  else rmSync(file, { force: true })
}
