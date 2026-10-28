// Auto-approve rules: the app seals them per machine, the agent keeps them in rules.json, and the PermissionRequest hook
// approves a matching tool call before the user is asked.

import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { open } from '../../shared/crypto'
import type { PoolMachineMode } from '../../shared/pool-protocol'
import type { PermissionRule, RuleSet, SessionRules } from '../../shared/protocol'
import { paths } from './config'
import { log } from './log'

/** Which input field a rule's pattern is matched against, per tool. */
const PATTERN_FIELDS: Record<string, string> = {
  Bash: 'command',
  PowerShell: 'command',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  WebFetch: 'url',
  Glob: 'pattern',
  Grep: 'pattern',
}
/** Shell syntax that chains or hides commands: `npm test && rm -rf ~` must never pass for `npm test *`. */
const SHELL_CONTROL = /[;&|`<>\n\r]|\$\(/
const MAX_RULES = 200

/** Rules from the relay: kept, logged, or dropped. */
export async function receiveRules(key: string, sealed: string) {
  const result = await applyRules(key, sealed)
  if (result === 'refused') log('dropped auto-approve rules that do not open with the account key')
  if (result === 'saved') log('auto-approve rules updated', { count: readRules()?.rules.length ?? 0 })
}

/** Keeps the rules if they are sealed with the account key and newer than the ones already here. */
export async function applyRules(key: string, sealed: string, file = paths.rules): Promise<'saved' | 'stale' | 'refused'> {
  const set = await open<RuleSet>(key, sealed).catch(() => null)
  if (!set || !Array.isArray(set.rules) || typeof set.issuedAt !== 'string' || Number.isNaN(Date.parse(set.issuedAt))) return 'refused'
  const current = readRules(file)
  // The relay could hand back an older set to bring a removed rule back.
  if (current && Date.parse(current.issuedAt) >= Date.parse(set.issuedAt)) return 'stale'
  const rules = set.rules.filter(isRule).slice(0, MAX_RULES)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const partial = `${file}.${process.pid}.tmp`
  writeFileSync(partial, JSON.stringify({ rules, issuedAt: set.issuedAt }), { mode: 0o600 })
  renameSync(partial, file)
  return 'saved'
}

export function readRules(file = paths.rules): RuleSet | null {
  try {
    const set = JSON.parse(readFileSync(file, 'utf8')) as RuleSet
    return Array.isArray(set.rules) && typeof set.issuedAt === 'string' ? { rules: set.rules.filter(isRule), issuedAt: set.issuedAt } : null
  } catch {
    return null
  }
}

/** The rule that approves this call, if any. */
export function matchingRule(rules: PermissionRule[], toolName: string, toolInput: unknown): PermissionRule | undefined {
  const fields = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>
  return rules.find(rule => {
    if (rule.tool !== toolName) return false
    const pattern = rule.pattern?.trim()
    if (!pattern) return true
    const field = PATTERN_FIELDS[toolName]
    const value = field ? fields[field] : undefined
    return typeof value === 'string' && matches(pattern, value.trim(), field === 'command')
  })
}

/**
 * `*` stands for anything, everything else must be equal. A command with shell operators is only approved by a pattern
 * that spells it out in full, without `*`.
 */
export function matches(pattern: string, value: string, isCommand: boolean): boolean {
  if (!pattern.includes('*')) return pattern === value
  if (isCommand && SHELL_CONTROL.test(value)) return false
  const expression = pattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*')
  return new RegExp(`^${expression}$`).test(value)
}

// MARK: For the rest of a session

/** Rules from "Allow for this session", if they open with the account key and are for this session and request. */
export async function openSessionRules(key: string, sealed: string, sessionId: string, requestId: string): Promise<PermissionRule[]> {
  const set = await open<SessionRules>(key, sealed).catch(() => null)
  if (!set || set.sessionId !== sessionId || set.requestId !== requestId || !Array.isArray(set.rules)) {
    log('dropped session rules for another session or request')
    return []
  }
  return set.rules.filter(isRule).slice(0, MAX_RULES)
}

/** A Claude Code session's rules live in a file: the PermissionRequest hook that applies them runs in its own process. */
const sessionRulesFile = (sessionId: string, folder: string) => join(folder, `${sessionId.replace(/[^\w-]/g, '_')}.json`)

export function sessionRules(sessionId: string, folder = paths.sessionRules): PermissionRule[] {
  try {
    const rules = JSON.parse(readFileSync(sessionRulesFile(sessionId, folder), 'utf8'))
    return Array.isArray(rules) ? rules.filter(isRule) : []
  } catch {
    return []
  }
}

export function addSessionRules(sessionId: string, rules: PermissionRule[], folder = paths.sessionRules) {
  if (!rules.length) return
  const file = sessionRulesFile(sessionId, folder)
  const all = [...sessionRules(sessionId, folder), ...rules].slice(-MAX_RULES)
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const partial = `${file}.${process.pid}.tmp`
  writeFileSync(partial, JSON.stringify(all), { mode: 0o600 })
  renameSync(partial, file)
}

/** Once the session ends, nothing it allowed carries over. */
export function clearSessionRules(sessionId: string, folder = paths.sessionRules) {
  rmSync(sessionRulesFile(sessionId, folder), { force: true })
  rmSync(poolRulesFile(sessionId, folder), { force: true })
  rmSync(poolModeFile(sessionId, folder), { force: true })
}

// MARK: Accepted from a pool

/**
 * The pool rules the machine owner accepted for this session (agent/src/channel/pool-safety.ts), next to the session's
 * own: replaced as a whole whenever an acceptance changes, gone when the session leaves its pools or ends.
 */
const poolRulesFile = (sessionId: string, folder: string) => join(folder, `${sessionId.replace(/[^\w-]/g, '_')}.pool.json`)

export function poolRules(sessionId: string, folder = paths.sessionRules): PermissionRule[] {
  try {
    const rules = JSON.parse(readFileSync(poolRulesFile(sessionId, folder), 'utf8'))
    return Array.isArray(rules) ? rules.filter(isRule) : []
  } catch {
    return []
  }
}

export function setPoolRules(sessionId: string, rules: PermissionRule[], folder = paths.sessionRules) {
  const file = poolRulesFile(sessionId, folder)
  if (!rules.length) {
    rmSync(file, { force: true })
    return
  }
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const partial = `${file}.${process.pid}.tmp`
  writeFileSync(partial, JSON.stringify(rules.filter(isRule).slice(0, MAX_RULES)), { mode: 0o600 })
  renameSync(partial, file)
}

// MARK: A pool machine's mode

/**
 * What a pool machine's sessions may do without asking (docs/pool-autopilot.md), from the order its service sealed
 * with the account key, and the folder the session works in. Never what the pool or the relay says.
 */
export interface PoolMode {
  mode: PoolMachineMode
  /** The task's worktree, or the repository for the orchestrator: `edits` passes nothing outside it. */
  root: string
}

/** File edits and read-only tools, as Claude Code names them (OpenCode's are mapped to these, opencode/events.ts). */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoRead', 'TodoWrite'])
/** The field of each that names a file or folder. A call without one works in the session's folder. */
const PATH_FIELD: Record<string, string> = {
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  Read: 'file_path',
  NotebookEdit: 'notebook_path',
  NotebookRead: 'notebook_path',
  Glob: 'path',
  Grep: 'path',
  LS: 'path',
}

/**
 * Whether the mode lets this call pass without asking. `full`: everything. `edits`: file edits and read-only tools, in
 * the session's folder only. `ask`, or no mode: nothing, the machine owner is asked as for any session.
 */
export function modeAllows(mode: PoolMode | null, toolName: string, toolInput: unknown): boolean {
  if (mode?.mode === 'full') return true
  if (mode?.mode !== 'edits' || (!EDIT_TOOLS.has(toolName) && !READ_TOOLS.has(toolName))) return false
  const field = PATH_FIELD[toolName]
  const value = field && toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>)[field] : undefined
  if (value === undefined) return true
  if (typeof value !== 'string' || !value.trim()) return false
  // Links followed: a link in the repository that points out of it does not take an edit out with it.
  const root = real(resolve(mode.root))
  const target = real(resolve(root, value.trim()))
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** The path with its links resolved, as far as it exists: a file about to be written does not exist yet. */
function real(path: string): string {
  const missing: string[] = []
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...missing.reverse())
    } catch {
      if (dirname(current) === current) return path
      missing.push(basename(current))
    }
  }
}

const poolModeFile = (sessionId: string, folder: string) => join(folder, `${sessionId.replace(/[^\w-]/g, '_')}.mode.json`)

/** The mode of a pool machine's session, written by its channel, read by the PermissionRequest hook in its own process. */
export function poolMode(sessionId: string, folder = paths.sessionRules): PoolMode | null {
  try {
    const mode = JSON.parse(readFileSync(poolModeFile(sessionId, folder), 'utf8')) as Partial<PoolMode>
    return (mode.mode === 'ask' || mode.mode === 'edits' || mode.mode === 'full') && typeof mode.root === 'string' && isAbsolute(mode.root)
      ? { mode: mode.mode, root: mode.root }
      : null
  } catch {
    return null
  }
}

/** Replaced when the session joins or leaves a pool as a machine's worker; none for the others. */
export function setPoolMode(sessionId: string, mode: PoolMode | null, folder = paths.sessionRules) {
  const file = poolModeFile(sessionId, folder)
  if (!mode || mode.mode === 'ask') {
    rmSync(file, { force: true })
    return
  }
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const partial = `${file}.${process.pid}.tmp`
  writeFileSync(partial, JSON.stringify(mode), { mode: 0o600 })
  renameSync(partial, file)
}

function isRule(rule: unknown): rule is PermissionRule {
  const candidate = rule as Partial<PermissionRule> | null
  return (
    typeof candidate?.tool === 'string' &&
    candidate.tool.length > 0 &&
    candidate.tool.length <= 128 &&
    (candidate.pattern === undefined || (typeof candidate.pattern === 'string' && candidate.pattern.length <= 1000))
  )
}
