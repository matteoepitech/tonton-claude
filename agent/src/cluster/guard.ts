// The guard of held files (#310): before a session edits a file that another session of its cluster holds, its owner is
// asked. In Claude Code the PreToolUse hook answers "ask"; OpenCode lets no plugin ask, and Codex lets a call run when its
// PreToolUse hook answers "ask", so for both the edit is stopped once and the session is told to ask its user. Codex edits
// with `apply_patch` and through its shell: what a shell command writes is read from it (`shellEdits`). The guard only
// ever runs on the owner's own machine, from what its agent left there: the cluster's claims, already opened, with the
// holders' names.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { paths } from '../config'
import { type Command, commandsOf, normalizePath, projectPath } from './detect'

/** A claim as the guard reads it: the cluster's, with the holder's name read from the members' profiles. */
export interface GuardClaim {
  /** Relative to the holder's project, with `/`; globs (`Content/Hero/**`) and folders hold what is under them. */
  paths: string[]
  /** Who holds it, as the owner reads it: `Bob's Claude`. */
  holder: string
  session: string
  reason?: string
  /** ISO times: when it was taken, and when it lapses. */
  at: string
  until?: string
}

export interface GuardCluster {
  id: string
  name?: string
  /** The cluster refuses edits of held files instead of asking. */
  block?: boolean
  claims: GuardClaim[]
}

/** What the agent of a cluster session leaves for its guard, one file per session. */
export interface GuardState {
  sessionId: string
  /** The project folder the claims are relative to. Missing: the session's working folder. */
  root?: string
  clusters: GuardCluster[]
}

export interface GuardDecision {
  decision: 'ask' | 'deny'
  reason: string
  /** The first held path, relative to the project. */
  path: string
}

/** Claude Code's and OpenCode's tools that change files, lower case. */
export const EDIT_TOOLS = ['edit', 'write', 'multiedit', 'notebookedit', 'patch', 'apply_patch']
/** An OpenCode session told to ask its user makes the same edit again within this time once they agreed. */
const ASK_AGAIN_MS = 10 * 60 * 1000
const MAX_CLUSTERS = 10
const MAX_CLAIMS = 2000

const guardFile = (sessionId: string, folder: string) => join(folder, `${sessionId.replace(/[^\w-]/g, '_')}.json`)
/** What a Codex session was told to ask its user about, and when: its hook runs in a process of its own each time. */
const askedFile = (sessionId: string, folder: string) => join(folder, `${sessionId.replace(/[^\w-]/g, '_')}.asked.json`)

/** Written whenever the claims or the names change; read by every PreToolUse hook of the session. */
export function writeGuardState(state: GuardState, folder = paths.clusterGuard) {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const file = guardFile(state.sessionId, folder)
  // A hook reading while it is written gets the old file or the new one, never half of it.
  writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

export function clearGuardState(sessionId: string, folder = paths.clusterGuard) {
  rmSync(guardFile(sessionId, folder), { force: true })
  rmSync(askedFile(sessionId, folder), { force: true })
}

/** Null when the session is in no cluster, or the file is not what the agent writes. */
export function readGuardState(sessionId: string, folder = paths.clusterGuard): GuardState | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(guardFile(sessionId, folder), 'utf8'))
  } catch {
    return null
  }
  const fields = raw as Partial<GuardState> | null
  if (!fields || fields.sessionId !== sessionId || !Array.isArray(fields.clusters)) return null
  const clusters = fields.clusters.slice(0, MAX_CLUSTERS).flatMap((cluster: Partial<GuardCluster> | null) => {
    if (!cluster || typeof cluster.id !== 'string' || !Array.isArray(cluster.claims)) return []
    const claims = cluster.claims.slice(0, MAX_CLAIMS).filter(isClaim)
    return [{ id: cluster.id, name: text(cluster.name), block: cluster.block === true, claims }]
  })
  return { sessionId, root: text(fields.root), clusters }
}

function isClaim(claim: unknown): claim is GuardClaim {
  const fields = claim as Partial<GuardClaim> | null
  return (
    !!fields &&
    Array.isArray(fields.paths) &&
    fields.paths.every(path => typeof path === 'string') &&
    typeof fields.holder === 'string' &&
    typeof fields.session === 'string' &&
    typeof fields.at === 'string' &&
    (fields.until === undefined || typeof fields.until === 'string') &&
    (fields.reason === undefined || typeof fields.reason === 'string')
  )
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/** The files a call to an edit tool changes, as it names them: Claude Code's and OpenCode's fields, and patches. */
export function editedPaths(tool: string, input: unknown): string[] {
  if (!EDIT_TOOLS.includes(tool.toLowerCase())) return []
  const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const named = ['file_path', 'filePath', 'notebook_path', 'path'].map(key => fields[key]).filter(value => typeof value === 'string')
  const patches = [fields.patchText, fields.patch, fields.input].filter(value => typeof value === 'string')
  const patched = patches.flatMap(patch =>
    [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match => match[1]),
  )
  return [...new Set([...named, ...patched].map(path => path.trim()).filter(Boolean))]
}

/** Files a shell command names, at most: a guard that read thousands would slow every command down. */
const MAX_SHELL_PATHS = 100
/** Programs that change each file they name. */
const CHANGES_EACH = new Set(['rm', 'unlink', 'shred', 'touch', 'truncate', 'tee', 'mv', 'del', 'erase', 'move', 'ren', 'rename'])
/** Programs that change the last file they name: the copy. */
const CHANGES_LAST = new Set(['cp', 'install', 'ln', 'copy', 'xcopy', 'robocopy'])
/** PowerShell's commands that write files, lower case, and their aliases. */
const POWERSHELL_WRITES = new Set([
  'set-content',
  'add-content',
  'clear-content',
  'out-file',
  'new-item',
  'remove-item',
  'move-item',
  'copy-item',
  'rename-item',
  'ri',
  'mi',
  'ni',
  'sc',
  'ac',
])
const POWERSHELL_PATHS = new Set(['-path', '-literalpath', '-filepath', '-destination'])
/** Options of these programs that take a value, which is no file. */
const VALUED: Record<string, Set<string>> = {
  sed: new Set(['-e', '-f', '--expression', '--file', '-l', '--line-length']),
  perl: new Set(['-e', '-E', '-M', '-m', '-I', '-x']),
  truncate: new Set(['-s', '--size', '-r', '--reference']),
  install: new Set(['-m', '--mode', '-o', '--owner', '-g', '--group', '-t', '--target-directory']),
}
const CHANGES_DIRECTORY = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl'])
/** Where output goes that is no file. */
const NO_FILE = /^(\/dev\/(null|stdout|stderr|tty)|nul|con|\$null)$/i

/**
 * The files a shell command writes, as far as reading it tells: a patch it applies (`apply_patch <<'EOF'`), what its
 * output goes to (`>`, `>>`), and the files of programs that change them (`sed -i`, `perl -i`, `tee`, `rm`, `mv`, `cp`,
 * `dd of=`, PowerShell's `Set-Content` and the like). Paths after a `cd` are read from its folder. What a script does
 * inside (`python fix.py`) cannot be read: the guard catches the common edits, not every one.
 */
export function shellEdits(command: string): string[] {
  const found = editedPaths('apply_patch', { patch: command })
  let folder = ''
  try {
    for (const each of commandsOf(command)) {
      if (CHANGES_DIRECTORY.has(each.program)) {
        const to = operands(each)[0]
        folder = !to ? '' : isAbsolute(to) || /^[A-Za-z]:[\\/]/.test(to) ? to : folder ? `${folder}/${to}` : to
        continue
      }
      for (const path of [...each.writes.filter(path => !NO_FILE.test(path)), ...writtenBy(each)]) {
        if (found.length >= MAX_SHELL_PATHS) break
        found.push(folder && !isAbsolute(path) && !/^[A-Za-z]:[\\/]/.test(path) ? `${folder}/${path}` : path)
      }
    }
  } catch {
    // A command this reader cannot cut: the patch it holds, if any.
  }
  return [...new Set(found.map(path => path.trim()).filter(path => path && !path.startsWith('$')))]
}

/** What a program changes of the files it names. */
function writtenBy(command: Command): string[] {
  const { program, args } = command
  if (CHANGES_EACH.has(program)) return operands(command)
  if (CHANGES_LAST.has(program)) return operands(command).slice(-1)
  if (program === 'dd') return args.filter(arg => arg.startsWith('of=')).map(arg => arg.slice(3))
  if (program === 'sed' && args.some(arg => /^-[A-Za-z]*i/.test(arg) || arg.startsWith('--in-place'))) return scripted(command)
  if (program === 'perl' && args.some(arg => /^-[A-Za-z]*i/.test(arg))) return scripted(command)
  if (POWERSHELL_WRITES.has(program)) {
    const named = args.flatMap((arg, at) => (POWERSHELL_PATHS.has(arg.toLowerCase()) && args[at + 1] ? [args[at + 1]] : []))
    return named.length ? named : operands(command).slice(0, 1)
  }
  return []
}

/** The files of `sed -i` and `perl -i`: past the script, which `-e` gives, or else the first operand is. */
function scripted(command: Command): string[] {
  const given = command.args.some(arg => /^-[eEf]$/.test(arg) || /^--(expression|file)\b/.test(arg))
  const files = operands(command)
  return given ? files : files.slice(1)
}

/** The arguments that are no option, past the values of the options that take one. */
function operands({ program, args }: Command): string[] {
  const valued = VALUED[program]
  const found: string[] = []
  let after = false
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]
    if (!after && arg === '--') after = true
    else if (!after && valued?.has(arg)) at++
    // cmd's switches (`/y`); a POSIX path starts with `/` too, and stays.
    else if (!after && (arg.startsWith('-') || /^\/[A-Za-z?]$/.test(arg))) continue
    else if (arg) found.push(arg)
  }
  return found
}

/**
 * Whether a claimed path holds a file. Both are compared without case, `/` or `\` alike: Windows and macOS keep
 * `Main.umap` and `main.umap` as one file. A path that is not under its project (absolute, or a depot path) can be
 * anywhere: it holds a file when they end the same, over two folders or more.
 */
export function holds(claimed: string, file: string): boolean {
  const pattern = normalizePath(claimed)
    .toLowerCase()
    .replace(/\.\.\./g, '**')
  const path = normalizePath(file).toLowerCase()
  const files = anchorsOf(path)
  return anchorsOf(pattern).some(anchor => {
    const test = globOf(anchor)
    return files.some(test)
  })
}

/** A path under its project is anchored there; any other one, at each of its folders. */
function anchorsOf(path: string): string[] {
  if (!path.startsWith('/') && !/^[a-z]:\//.test(path)) return [path]
  const segments = path.replace(/^\/+|^[a-z]:\//, '').split('/')
  return segments.slice(0, -1).map((_, at) => segments.slice(at).join('/'))
}

/** `**` any folders, `*` and `?` within one name; without them, the path and anything under it. */
function globOf(pattern: string): (path: string) => boolean {
  if (!/[*?[]/.test(pattern)) return path => path === pattern || path.startsWith(`${pattern}/`)
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      source += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += pattern[i + 2] === '/' ? 2 : 1
    } else if (c === '*') source += '[^/]*'
    else if (c === '?') source += '[^/]'
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const regex = new RegExp(`^${source}(?:/.*)?$`)
  return path => regex.test(path)
}

/**
 * Whether a session may edit what a tool call changes: null when no other session of its clusters holds any of it, or
 * what to answer. Claims of this session, and lapsed ones, hold nothing.
 */
export function guard(state: GuardState | null, tool: string, input: unknown, cwd?: string, now = new Date()): GuardDecision | null {
  return state?.clusters.length ? guardPaths(state, editedPaths(tool, input), cwd, now) : null
}

/** The same, for files already read from the call: a Codex patch's, or what a shell command writes. */
export function guardPaths(state: GuardState | null, paths: string[], cwd?: string, now = new Date()): GuardDecision | null {
  if (!state?.clusters.length) return null
  const root = state.root ?? cwd
  const edited = paths.map(path => projectPath(absolute(path, cwd ?? root), root))
  const held: { path: string; claim: GuardClaim; cluster: GuardCluster }[] = []
  for (const path of edited) {
    for (const cluster of state.clusters) {
      const claim = cluster.claims.find(
        claim =>
          claim.session !== state.sessionId &&
          !(claim.until && Date.parse(claim.until) <= now.getTime()) &&
          claim.paths.some(claimed => holds(claimed, path)),
      )
      if (claim) {
        held.push({ path, claim, cluster })
        break
      }
    }
  }
  const [first] = held
  if (!first) return null
  const { path, claim } = first
  const others = held.length - 1
  const more = others ? `, and ${others} more file${others === 1 ? ' is' : 's are'} held` : ''
  const reason = `${path} is held by ${claim.holder}${since(claim.at, now)}${claim.reason ? ` (${claim.reason})` : ''}${more}`
  const blocking = held.find(entry => entry.cluster.block)?.cluster
  if (!blocking) return { decision: 'ask', reason, path }
  return { decision: 'deny', reason: `${reason}. ${blocking.name ?? 'The cluster'} lets no one edit a file someone else holds.`, path }
}

/** Edit tools name files from the working folder, or from anywhere. */
function absolute(path: string, cwd?: string): string {
  if (!cwd || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return path
  return `${cwd.replace(/[\\/]+$/, '')}/${path}`
}

/** ` since 14:02`, with the day when it was not today, in the machine's time. */
function since(at: string, now: Date): string {
  const time = new Date(at)
  if (Number.isNaN(time.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}`
  if (time.toDateString() === now.toDateString()) return ` since ${clock}`
  return ` since ${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${clock}`
}

/**
 * What a session that cannot ask its user before an edit is told: empty to let it run. A held file stops the edit with
 * the reason, and the session is told to ask its user; when it makes the same edit again soon after, its user agreed.
 * `asked` holds the edits it was told to ask about, by session and file, with when.
 */
export function askOnce(found: GuardDecision | null, sessionId: string, asked: Map<string, number>, now: number): string {
  if (!found) return ''
  if (found.decision === 'deny') return found.reason
  for (const [key, at] of asked) if (now - at > ASK_AGAIN_MS) asked.delete(key)
  const key = `${sessionId}\n${found.path}`
  if (asked.delete(key)) return ''
  asked.set(key, now)
  return `${found.reason}. Ask your user before you edit it. If they agree, make the same edit again.`
}

/** OpenCode's side: what the plugin answers before an edit, from the bridge, which runs as long as OpenCode. */
export class OpenCodeGuard {
  private readonly asked = new Map<string, number>()

  constructor(private readonly folder = paths.clusterGuard) {}

  answer(sessionId: string, tool: string, input: unknown, cwd?: string, now = new Date()): string {
    return askOnce(guard(readGuardState(sessionId, this.folder), tool, input, cwd, now), sessionId, this.asked, now.getTime())
  }
}

/**
 * Codex's side, from its PreToolUse hook: what to stop the call with, empty to let it run. The hook is a process of its
 * own for each call, so what the session was told to ask about is kept next to its guard file.
 */
export function guardCodexEdit(sessionId: string, edited: string[], cwd?: string, now = new Date(), folder = paths.clusterGuard): string {
  const state = readGuardState(sessionId, folder)
  const found = guardPaths(state, edited, cwd, now)
  if (!found) return ''
  const file = askedFile(sessionId, folder)
  const asked = readAsked(file)
  const answer = askOnce(found, sessionId, asked, now.getTime())
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify(Object.fromEntries(asked)), { mode: 0o600 })
  } catch {
    // Not kept: the next try is stopped once more, and the session asks again.
  }
  return answer
}

function readAsked(file: string): Map<string, number> {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    return new Map(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
  } catch {
    return new Map()
  }
}
