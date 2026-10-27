// The files Claude changed in a session, from its Write, Edit, MultiEdit and NotebookEdit calls, the most recently changed
// first. OpenCode's edit and write tools arrive under the same names. Mirrors app/Sources/TontonCore/ChangedFiles.swift.

import type { Entry, FileEdit } from './protocol'

export interface ChangedFile {
  /** As the call's summary holds it: absolute on the session's machine. */
  path: string
  name: string
  /** The replacements of the calls that did not fail, oldest first. A Write call has none. */
  edits: FileEdit[]
  /** Calls that changed the file, failed ones left out. */
  changes: number
  /** Claude wrote the whole file at least once. */
  written: boolean
  /** The last call on the file failed. */
  lastFailed: boolean
  lastChange: string
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

export function changedFiles(entries: readonly Entry[]): ChangedFile[] {
  const failed = new Set(entries.flatMap(e => (e.kind === 'tool_result' && e.isError ? [e.toolUseId] : [])))
  const files = new Map<string, ChangedFile & { order: number }>()
  entries.forEach((entry, order) => {
    if (entry.kind !== 'tool' || !FILE_TOOLS.has(entry.name)) return
    const path = pathOf(entry.summary)
    if (!path) return
    const file = files.get(path) ?? {
      path,
      name: nameOf(path),
      edits: [],
      changes: 0,
      written: false,
      lastFailed: false,
      lastChange: entry.ts,
      order,
    }
    const didFail = failed.has(entry.toolUseId)
    file.lastFailed = didFail
    file.lastChange = entry.ts
    file.order = order
    if (!didFail) {
      file.changes++
      file.edits.push(...(entry.edits ?? []))
      if (entry.name === 'Write') file.written = true
    }
    files.set(path, file)
  })
  return [...files.values()].sort((a, b) => b.order - a.order).map(({ order: _, ...file }) => file)
}

/** The path under the session's folder, or the whole path when it lies elsewhere. */
export function shownPath(path: string, cwd: string): string {
  const folder = /[\\/]$/.test(cwd) ? cwd.slice(0, -1) : cwd
  if (!folder || path.length <= folder.length + 1 || !path.startsWith(folder)) return path
  return /[\\/]/.test(path[folder.length]) ? path.slice(folder.length + 1) : path
}

/** A whole path: not cut short by the agent, not OpenCode's multi-file patch. */
function pathOf(summary: string): string | null {
  const text = summary.trim()
  if (!text || text.endsWith('…') || text.includes('\n')) return null
  return text.startsWith('/') || text.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(text) ? text : null
}

const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
