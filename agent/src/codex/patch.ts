// The files a Codex patch changes, with their replacements, so the notch's changed files show them as Claude Code's
// Edit and Write calls. Two sources: the `apply_patch` call itself (Codex's own patch format, paths relative to the
// session's folder), and the `patch_apply_end` event Codex writes once it applied one (absolute paths, unified diffs),
// which also covers a patch run through the shell. Neither is a public format: what isn't recognized is skipped.

import { isAbsolute, join } from 'node:path'
import type { FileEdit } from '../../../shared/protocol'
import { fileEdits } from '../transcript/parser'

/** Files per patch: a patch that touches more is a refactor, and the first ones say what it is. */
const MAX_FILES = 50

export interface PatchFile {
  /** Write for a new file, Edit for a change or a deletion. */
  tool: 'Write' | 'Edit'
  /** Where the file ends up: absolute when the folder is known. */
  path: string
  edits: FileEdit[]
}

interface Hunk {
  old: string[]
  new: string[]
}

/**
 * The files of a patch in Codex's format (codex-rs/core/src/tools/handlers/apply_patch.lark):
 * `*** Begin Patch`, then `*** Add File: <path>` with `+` lines, `*** Delete File: <path>`, or `*** Update File: <path>`
 * with an optional `*** Move to: <path>` and hunks of ` `, `-` and `+` lines after `@@`, then `*** End Patch`.
 */
export function patchFiles(patch: string, cwd?: string): PatchFile[] {
  const files: PatchFile[] = []
  let current: { tool: PatchFile['tool']; path: string; hunks: Hunk[]; added: string[] } | null = null
  const close = () => {
    if (!current) return
    const edits =
      current.tool === 'Write'
        ? []
        : replacements(current.hunks.filter(hunk => hunk.old.length || hunk.new.length).map(hunk => [hunk.old, hunk.new]))
    files.push({ tool: current.tool, path: absolute(current.path, cwd), edits })
    current = null
  }
  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line)
    if (header) {
      close()
      if (files.length >= MAX_FILES) break
      current = { tool: header[1] === 'Add' ? 'Write' : 'Edit', path: header[2].trim(), hunks: [], added: [] }
      continue
    }
    if (!current) continue
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    if (move) current.path = move[1].trim()
    else if (line.startsWith('*** ')) close()
    else if (line.startsWith('@@') || !current.hunks.length) {
      current.hunks.push({ old: [], new: [] })
      if (!line.startsWith('@@')) hunkLine(current.hunks[current.hunks.length - 1], line)
    } else hunkLine(current.hunks[current.hunks.length - 1], line)
  }
  close()
  return files
}

/** A file change of a `patch_apply_end` event: `{ type: add, content }`, `{ type: delete, content }`, or `{ type: update, unified_diff, move_path }`. */
export function appliedFile(path: string, change: unknown): PatchFile | null {
  if (!change || typeof change !== 'object' || !path) return null
  const fields = change as { type?: unknown; content?: unknown; unified_diff?: unknown; move_path?: unknown }
  if (fields.type === 'add') return { tool: 'Write', path, edits: [] }
  if (fields.type === 'delete') {
    const content = typeof fields.content === 'string' ? fields.content : ''
    return { tool: 'Edit', path, edits: content ? replacements([[content.split('\n'), []]]) : [] }
  }
  if (fields.type !== 'update') return null
  const moved = typeof fields.move_path === 'string' && fields.move_path ? fields.move_path : path
  const hunks: Hunk[] = []
  for (const line of (typeof fields.unified_diff === 'string' ? fields.unified_diff : '').replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue
    if (line.startsWith('@@')) hunks.push({ old: [], new: [] })
    else if (hunks.length) hunkLine(hunks[hunks.length - 1], line)
  }
  return { tool: 'Edit', path: moved, edits: replacements(hunks.map(hunk => [hunk.old, hunk.new])) }
}

function hunkLine(hunk: Hunk, line: string) {
  if (line.startsWith('-')) hunk.old.push(line.slice(1))
  else if (line.startsWith('+')) hunk.new.push(line.slice(1))
  else if (line.startsWith(' ')) {
    hunk.old.push(line.slice(1))
    hunk.new.push(line.slice(1))
  }
}

/** Cut as an Edit's are (agent/src/transcript/parser.ts). */
function replacements(hunks: [string[], string[]][]): FileEdit[] {
  return fileEdits('MultiEdit', { edits: hunks.map(([old, next]) => ({ old_string: old.join('\n'), new_string: next.join('\n') })) })
}

function absolute(path: string, cwd?: string): string {
  return isAbsolute(path) || !cwd ? path : join(cwd, path)
}
