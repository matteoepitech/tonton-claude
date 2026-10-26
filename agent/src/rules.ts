// Auto-approve rules: the app seals them per machine, the agent keeps them in rules.json, and the PermissionRequest hook
// approves a matching tool call before the user is asked.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { open } from '../../shared/crypto'
import type { PermissionRule, RuleSet } from '../../shared/protocol'
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

function isRule(rule: unknown): rule is PermissionRule {
  const candidate = rule as Partial<PermissionRule> | null
  return (
    typeof candidate?.tool === 'string' &&
    candidate.tool.length > 0 &&
    candidate.tool.length <= 128 &&
    (candidate.pattern === undefined || (typeof candidate.pattern === 'string' && candidate.pattern.length <= 1000))
  )
}
