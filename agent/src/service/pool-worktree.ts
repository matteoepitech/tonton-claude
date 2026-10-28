// The git a pool machine runs by itself (docs/pool-autopilot.md), and nothing else: it clones the pool's repository in
// `<workdir>/repo` once, fetches, and adds a worktree per task in `<workdir>/tasks/<task>` on the task's branch. Putting
// the machine in the pool with that folder is its owner's consent. Every path stays inside the folder the owner chose,
// every argument is checked before it reaches git, and git never asks for a password: it fails and says why.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { gitEnv, isBranchName } from '../channel/pool-git'
import { fromHome } from '../launch'

/** Cloning a large repository takes a while; fetching and adding a worktree much less. */
const CLONE_TIMEOUT_MS = 10 * 60_000
const GIT_TIMEOUT_MS = 2 * 60_000
/** As the relay checks task ids: safe as a folder name, a branch part and a tmux name. */
export const TASK_ID = /^[A-Za-z0-9_-]{8,40}$/
/** Under `pool/`, and a name git takes that can never pass for an option (channel/pool-git.ts). */
const isTaskBranch = (branch: string) => branch.startsWith('pool/') && isBranchName(branch)

export interface TaskTree {
  /** `<workdir>/tasks/<task>`, where the session runs. */
  cwd: string
  branch: string
}

/**
 * What git may clone: a URL over https, http, ssh or git, `user@host:path`, or a repository on this machine. Nothing
 * that starts like an option, and none of git's other transports (`ext::` runs a command).
 */
export function isRepository(repo: unknown): repo is string {
  if (typeof repo !== 'string' || !repo || repo.length > 2048 || /[\s\0]/.test(repo) || repo.startsWith('-')) return false
  if (/^(https?|ssh|git|file):\/\/[^/]/.test(repo) || /^file:\/\/\//.test(repo)) return true
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^:]/.test(repo)) return true
  return isAbsolute(repo) && !repo.includes('::')
}

/** The task's own branch when it has a good one, as the orchestrator names them, else `pool/<task>-<slug>` from its title. */
export function taskBranch(taskId: string, title: string, branch?: string): string {
  if (branch && isTaskBranch(branch)) return branch
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    // Accents go: é is e and its mark.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug ? `pool/${taskId}-${slug}` : `pool/${taskId}`
}

/** The machine's work folder as its owner wrote it, from the home folder when it starts with `~`. Null when relative. */
export function workFolder(workdir: string, home?: string): string | null {
  const folder = resolve(fromHome(workdir, home))
  return isAbsolute(fromHome(workdir, home)) ? folder : null
}

/**
 * Makes sure `<workdir>/repo` is a clone of the repository, fetches it, and checks out the task's branch in its own
 * worktree: from the branch on the remote when an earlier attempt pushed it, else from the remote's default branch. A
 * worktree already there is kept as it is: the task comes back to the machine after a review, or after its session
 * stopped, and its work stays.
 */
export async function prepareTaskTree(workdir: string, repo: string, taskId: string, branch: string): Promise<TaskTree | string> {
  if (!TASK_ID.test(taskId) || !isTaskBranch(branch)) return 'The task has no id or branch this machine can use.'
  const prepared = await prepareRepository(workdir, repo)
  if (typeof prepared === 'string') return prepared
  const { clone } = prepared
  const root = dirname(clone)
  const cwd = join(root, 'tasks', taskId)
  // Inside the owner's folder, whatever the names hold.
  if (!cwd.startsWith(root + sep)) return 'The task’s folder would be outside the work folder.'
  try {
    mkdirSync(join(root, 'tasks'), { recursive: true, mode: 0o755 })
  } catch (error) {
    return `Could not make ${root}: ${String(error)}`
  }
  if (isDirectory(cwd) && existsSync(join(cwd, '.git'))) return { cwd: realpathSync(cwd), branch }
  const start = remoteHas(clone, branch) ? `origin/${branch}` : 'origin/HEAD'
  const added = await git(['worktree', 'add', cwd, '-B', branch, start], clone)
  if (added !== null) return `git worktree add failed: ${added}`
  // As Claude Code reports its folder, links resolved: the session is found by it (launch.ts, newSession).
  return { cwd: realpathSync(cwd), branch }
}

/**
 * Makes sure `<workdir>/repo` is a clone of the repository, and fetches it: where the orchestrator works, and what the
 * tasks' worktrees come from. The clone's real path, or why not.
 */
export async function prepareRepository(workdir: string, repo: string): Promise<{ clone: string } | string> {
  if (!isRepository(repo)) return 'The pool’s repository is not a URL or a path git can clone.'
  const root = workFolder(workdir)
  if (!root) return `${workdir} is not a full path on this machine.`
  const clone = join(root, 'repo')
  try {
    mkdirSync(root, { recursive: true, mode: 0o755 })
  } catch (error) {
    return `Could not make ${root}: ${String(error)}`
  }
  if (!existsSync(join(clone, '.git'))) {
    const cloned = await git(['clone', '--', repo, clone], root, CLONE_TIMEOUT_MS)
    if (cloned !== null) return `git clone failed: ${cloned}`
  }
  const fetched = await git(['fetch', '--prune', 'origin'], clone)
  if (fetched !== null) return `git fetch failed: ${fetched}`
  return { clone: join(realpathSync(root), 'repo') }
}

/** Runs git in `cwd`: null once it worked, otherwise the end of what it said. */
async function git(args: string[], cwd: string, timeout = GIT_TIMEOUT_MS): Promise<string | null> {
  try {
    const child = Bun.spawn(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      // Never waits on a prompt for a password or a host key (the service has no terminal), and works in `cwd` only.
      env: { ...gitEnv(), GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' },
      timeout,
    })
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    return code === 0 ? null : stderr.trim().split('\n').slice(-3).join(' ') || `exit ${code}`
  } catch (error) {
    return String(error)
  }
}

/** `shop` for `git@github.com:ana/shop.git`: what the pool's sessions show as their project. */
export const repositoryName = (repo: string): string => basename(repo.replace(/\.git$/, '').replace(/[/:]+$/, '')) || repo

/** Whether the fetch brought the branch from the remote, read from the clone's refs rather than by running git. */
function remoteHas(clone: string, branch: string): boolean {
  if (existsSync(join(clone, '.git', 'refs', 'remotes', 'origin', ...branch.split('/')))) return true
  try {
    return readFileSync(join(clone, '.git', 'packed-refs'), 'utf8').includes(` refs/remotes/origin/${branch}\n`)
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
