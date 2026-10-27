// The git branch a session works on, read from the repository's files rather than by running git: it is read again
// with every meta update, on Windows, macOS and Linux alike. Anything unexpected gives no branch.

import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const MAX_BRANCH = 200

/** The branch checked out in `cwd` or the repository above it, the short commit when detached, null outside git. */
export function gitBranch(cwd: string): string | null {
  const gitDir = findGitDir(resolve(cwd))
  if (!gitDir) return null
  let head: string
  try {
    head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
  } catch {
    return null
  }
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
  if (ref) return ref[1].slice(0, MAX_BRANCH)
  return /^[0-9a-f]{40,64}$/i.test(head) ? head.slice(0, 7) : null
}

/** `.git` is a folder in a repository, and a file saying where the folder is in a worktree or a submodule. */
function findGitDir(start: string): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git')
    try {
      if (statSync(dotGit).isDirectory()) return dotGit
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
      return pointer ? (isAbsolute(pointer) ? pointer : resolve(dir, pointer)) : null
    } catch {
      // No .git here: look in the folder above.
    }
    if (dirname(dir) === dir) return null
  }
}
