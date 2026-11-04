// The guard of held files (#310): before a session edits a file that another session of its cluster holds, its owner is
// asked. In Claude Code the PreToolUse hook answers "ask"; OpenCode lets no plugin ask, so its plugin stops the edit once
// and the session is told to ask its user. The guard only ever runs on the owner's own machine, from what its agent left
// there: the cluster's claims, already opened, with the holders' names.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { paths } from '../config'
import { normalizePath, projectPath } from './detect'

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
  if (!state?.clusters.length) return null
  const root = state.root ?? cwd
  const edited = editedPaths(tool, input).map(path => projectPath(absolute(path, cwd ?? root), root))
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
 * OpenCode's side: what the plugin answers before an edit, empty to let it run. A held file stops the edit with the
 * reason, and the session is told to ask its user; when it makes the same edit again soon after, its user agreed.
 */
export class OpenCodeGuard {
  private readonly asked = new Map<string, number>()

  constructor(private readonly folder = paths.clusterGuard) {}

  answer(sessionId: string, tool: string, input: unknown, cwd?: string, now = new Date()): string {
    const found = guard(readGuardState(sessionId, this.folder), tool, input, cwd, now)
    if (!found) return ''
    if (found.decision === 'deny') return found.reason
    for (const [key, at] of this.asked) if (now.getTime() - at > ASK_AGAIN_MS) this.asked.delete(key)
    const key = `${sessionId}\n${found.path}`
    if (this.asked.delete(key)) return ''
    this.asked.set(key, now.getTime())
    return `${found.reason}. Ask your user before you edit it. If they agree, make the same edit again.`
  }
}
