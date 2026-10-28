// The git side of merging a pool task into main (docs/pool-orchestrator.md, Merging). It runs on the orchestrator's
// machine, in its session's own folder, which must be the top of the pool's repository: the finished branch is merged on
// top of the latest main on a detached HEAD, the build and the tests run on the result, and main moves only once they
// pass. A merge that conflicts or fails is dropped before it reaches main, so nothing is ever reverted, force-pushed or
// rewritten. Git is called directly, never through a shell; only the checks the orchestrator names go through one.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { shell } from '../statusline'

export interface LandRequest {
  /** The task's branch, `pool/<id>-<slug>`. */
  branch: string
  /** Missing: origin's default branch, else `main`, else `master`. */
  base?: string
  /** The merge commit's message. */
  message: string
  /** The commands that build and test the project, run in order in the folder. Empty: merged without a build. */
  checks: string[]
  /** `merge` pushes main; `pr` opens a pull request with GitHub's `gh` instead. */
  how: 'merge' | 'pr'
  /** The pull request's title and text. */
  title: string
  body: string
}

export type LandOutcome =
  /** `already`: the branch was in main before. */
  (
    | { kind: 'merged'; commit: string; base: string; already: boolean; pushed: boolean }
    | { kind: 'pr'; url: string; base: string }
    | { kind: 'conflict'; files: string[]; output: string }
    /** A check fails with the branch merged, and passes without it. */
    | { kind: 'failed'; command: string; output: string }
    /** A check fails on main as it is: the branch is not to blame. */
    | { kind: 'main_red'; command: string; output: string }
    /** Nothing was tried, or nothing changed: why. */
    | { kind: 'refused'; why: string }
  ) & {
    /** What did not go as planned around it: the folder or the local main left where they were. */
    note?: string
  }

export interface PoolGitOptions {
  /** How long one check may run. */
  checkTimeoutMs?: number
  /** How long a fetch, a push or a pull request may take. */
  networkTimeoutMs?: number
  /** GitHub's command line, for pull requests. */
  gh?: string
}

const CHECK_TIMEOUT_MS = 30 * 60_000
const NETWORK_TIMEOUT_MS = 2 * 60_000
const LOCAL_TIMEOUT_MS = 60_000
/** What is kept of an output for the task and for Claude: the end of a check's, where it fails; the start of a conflict. */
const OUTPUT_KEPT = 4000
/** What is kept in memory while a command runs. */
const BUFFER_KEPT = 64 * 1024
const MAX_FILES = 50
/** Green commits remembered: the latest main is what matters. */
const GREEN_KEPT = 50

/** Where git looks for a repository: the agent's own environment must not send it to another one. */
const GIT_LOCATION = /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX)$/i

/** A branch name as the pool writes them, which git takes and which can never pass for an option. */
export function isBranchName(name: string): boolean {
  return (
    name.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) &&
    !/\.\.|\/\/|\/\.|@\{/.test(name) &&
    !/[./]$/.test(name) &&
    !name.endsWith('.lock')
  )
}

interface Ran {
  code: number
  output: string
  timedOut?: boolean
  /** The command does not exist on this machine. */
  missing?: boolean
}

export class PoolGit {
  /** Commits whose checks all passed, with those checks: main is built again only when it changed meanwhile. */
  private readonly green = new Set<string>()
  private busy = false

  constructor(private readonly options: PoolGitOptions = {}) {}

  /** Merges the branch into main in `folder`, one merge at a time. */
  async land(folder: string, request: LandRequest): Promise<LandOutcome> {
    if (this.busy) return refused('Another merge is running in this folder: wait for it to finish.')
    this.busy = true
    try {
      return await this.landIn(folder, request)
    } finally {
      this.busy = false
    }
  }

  private async landIn(folder: string, request: LandRequest): Promise<LandOutcome> {
    const git = (args: string[], timeoutMs = LOCAL_TIMEOUT_MS) => run(['git', ...args], { cwd: folder, env: gitEnv(), timeoutMs })
    const network = this.options.networkTimeoutMs ?? NETWORK_TIMEOUT_MS
    if (!isBranchName(request.branch)) return refused(`${request.branch} is not a branch name the pool merges.`)
    if (request.base !== undefined && !isBranchName(request.base)) return refused(`${request.base} is not a branch name.`)

    // The folder itself must be the repository: git never runs on one above it.
    const top = await git(['rev-parse', '--show-toplevel'])
    if (top.missing) return refused('git is not installed on this machine.')
    if (top.code !== 0 || !sameFolder(top.output.trim(), folder)) {
      return refused(
        `This session's folder (${folder}) is not the top of a git repository. The orchestrator merges in the pool's repository: start it at the repository's root.`,
      )
    }
    if ((await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0) {
      return refused('A merge is under way in this folder: finish it or abort it first.')
    }
    const status = await git(['status', '--porcelain', '--untracked-files=no'])
    if (status.code !== 0) return refused(`git status failed:\n${tail(status.output)}`)
    if (status.output.trim()) return refused('This folder has uncommitted changes: commit or stash them first, the merge happens here.')
    const head = await git(['rev-parse', '--verify', 'HEAD'])
    if (head.code !== 0) return refused('This repository has no commit yet.')
    const onBranch = await git(['symbolic-ref', '-q', '--short', 'HEAD'])
    const start = onBranch.code === 0 ? onBranch.output.trim() : head.output.trim()

    const remote = (await git(['remote'])).output.split(/\s+/).includes('origin')
    if (remote) {
      const fetched = await git(['fetch', '--quiet', '--prune', 'origin'], network)
      if (fetched.code !== 0) return refused(`git fetch origin failed:\n${tail(fetched.output)}`)
    }
    const has = async (ref: string) => (await git(['rev-parse', '-q', '--verify', `${ref}^{commit}`])).code === 0
    const base = request.base ?? (await defaultBase(git, has, remote))
    if (!base) return refused('There is no main branch here nor on origin: name the branch to merge into in base.')
    if (request.branch === base || request.branch === 'HEAD')
      return refused(`${request.branch} is what it merges into, not a task's branch.`)
    const remoteBase = `refs/remotes/origin/${base}`
    const localBase = `refs/heads/${base}`
    const onOrigin = remote && (await has(remoteBase))
    const local = await has(localBase)
    if (!onOrigin && !local) return refused(`There is no ${base} branch here nor on origin.`)
    const baseRef = onOrigin ? remoteBase : localBase
    if (onOrigin && local && !(await isAncestor(git, localBase, remoteBase))) {
      return refused(`The ${base} branch here has commits that are not on origin: push them, or take them off, before merging.`)
    }
    // With an origin, only what the author pushed: a branch left in this folder may be an old one.
    const branchRef = remote ? `refs/remotes/origin/${request.branch}` : `refs/heads/${request.branch}`
    if (!(await has(branchRef))) {
      return refused(
        `${request.branch} is not ${remote ? 'on origin' : 'here'}: its author has to push it. If its work is in main already, pass skip.`,
      )
    }
    const baseSha = (await git(['rev-parse', '--verify', `${baseRef}^{commit}`])).output.trim()
    const branchSha = (await git(['rev-parse', '--verify', `${branchRef}^{commit}`])).output.trim()
    if (await isAncestor(git, branchSha, baseSha)) return { kind: 'merged', commit: baseSha, base, already: true, pushed: false }

    const detached = await git(['checkout', '--quiet', '--detach', baseSha])
    if (detached.code !== 0) return refused(`git checkout failed:\n${tail(detached.output)}`)
    let outcome: LandOutcome = refused('The merge stopped half-way.')
    let back: Ran
    try {
      outcome = await this.mergeAndCheck(folder, git, request, baseSha, branchSha)
      if (outcome.kind === 'merged' && request.how === 'merge' && remote) {
        // A plain push: refused, never forced, when origin's main moved meanwhile.
        const pushed = await git(['push', '--quiet', 'origin', `${outcome.commit}:refs/heads/${base}`], network)
        if (pushed.code !== 0) {
          outcome = /\[rejected\]|non-fast-forward|fetch first/.test(pushed.output)
            ? refused(`${base} moved on origin while this merged: nothing changed, call task_merge again.`)
            : refused(`git push failed, nothing changed:\n${tail(pushed.output)}`)
        } else outcome = { ...outcome, base, pushed: true }
      }
    } finally {
      // Back where the folder was. The checks may have changed tracked files: the folder was clean when it started.
      back = await git(['checkout', '--quiet', '--force', start, '--'])
    }
    if (back.code !== 0) {
      const note = `This folder stayed on the merge, not on ${start}: run git checkout ${start} there (${tail(back.output, 300)}).`
      // Main moved only if it was pushed: otherwise nothing was merged, whatever the checks said.
      if (outcome.kind === 'merged' && !outcome.pushed) return refused(`Nothing was merged. ${note}`)
      return { ...outcome, note }
    }
    if (outcome.kind !== 'merged') return outcome
    // Checked: a pull request leaves main to the repository's own rules.
    if (request.how === 'pr') return this.openPullRequest(folder, request, base)
    const note = local ? await moveLocal(git, base, start, outcome.commit) : undefined
    return { ...outcome, base, ...(note ? { note } : {}) }
  }

  /** On the detached HEAD at main: the merge, then each check. Returns `merged` with the commit once all of them pass. */
  private async mergeAndCheck(
    folder: string,
    git: (args: string[]) => Promise<Ran>,
    request: LandRequest,
    baseSha: string,
    branchSha: string,
  ): Promise<LandOutcome> {
    const merged = await git(['merge', '--no-ff', '--no-edit', '-m', request.message, branchSha])
    if (merged.code !== 0) {
      const files = lines((await git(['diff', '--name-only', '--diff-filter=U'])).output)
      const detail = files.length ? (await git(['diff', '--no-color'])).output : ''
      await git(['merge', '--abort'])
      if (!files.length) return refused(`git merge failed, nothing changed:\n${tail(merged.output)}`)
      return { kind: 'conflict', files: files.slice(0, MAX_FILES), output: head(detail) }
    }
    const commit = (await git(['rev-parse', '--verify', 'HEAD'])).output.trim()
    const key = (sha: string) => `${sha}\n${request.checks.join('\n')}`
    for (const [index, command] of request.checks.entries()) {
      const ran = await this.check(folder, command)
      if (ran.code === 0) continue
      // Main itself may be failing: the branch is to blame only if main passes the same checks without it.
      if (!this.green.has(key(baseSha))) {
        await git(['checkout', '--quiet', '--force', '--detach', baseSha])
        for (const before of request.checks.slice(0, index + 1)) {
          const again = await this.check(folder, before)
          if (again.code !== 0) return { kind: 'main_red', command: before, output: described(again, this.checkTimeout()) }
        }
      }
      return { kind: 'failed', command, output: described(ran, this.checkTimeout()) }
    }
    if (request.checks.length) {
      this.green.add(key(commit))
      for (const old of [...this.green].slice(0, -GREEN_KEPT)) this.green.delete(old)
    }
    return { kind: 'merged', commit, base: '', already: false, pushed: false }
  }

  private checkTimeout() {
    return this.options.checkTimeoutMs ?? CHECK_TIMEOUT_MS
  }

  /** A check, through the shell Claude Code uses, with the agent's environment. */
  private check(folder: string, command: string): Promise<Ran> {
    return run([...shell(), command], { cwd: folder, env: cleanEnv({}), timeoutMs: this.checkTimeout(), group: true })
  }

  private async openPullRequest(folder: string, request: LandRequest, base: string): Promise<LandOutcome> {
    const gh = this.options.gh ?? 'gh'
    // Each value joined to its flag: a title or a text that starts with a dash stays a value.
    const args = ['pr', 'create', `--base=${base}`, `--head=${request.branch}`, `--title=${request.title}`, `--body=${request.body}`]
    const ran = await run([gh, ...args], {
      cwd: folder,
      env: cleanEnv({ GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }),
      timeoutMs: this.options.networkTimeoutMs ?? NETWORK_TIMEOUT_MS,
    })
    if (ran.missing) return refused("GitHub's gh is not installed here: install it and sign in (gh auth login), or merge without pr.")
    const url = ran.output.match(/https?:\/\/\S+/g)?.at(-1)
    // Opened now, or opened before: either way there is one.
    if (url && (ran.code === 0 || /already exists/i.test(ran.output))) return { kind: 'pr', url, base }
    return refused(`gh pr create failed:\n${tail(ran.output)}`)
  }
}

/** Origin's default branch, else main, else master. */
async function defaultBase(
  git: (args: string[]) => Promise<Ran>,
  has: (ref: string) => Promise<boolean>,
  remote: boolean,
): Promise<string | null> {
  if (remote) {
    const head = (await git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])).output.trim()
    if (head.startsWith('origin/') && isBranchName(head.slice('origin/'.length))) return head.slice('origin/'.length)
  }
  for (const name of ['main', 'master']) {
    if ((remote && (await has(`refs/remotes/origin/${name}`))) || (await has(`refs/heads/${name}`))) return name
  }
  return null
}

/** Moves main here too, the way it moved on origin: forward only. Says why not when it could not. */
async function moveLocal(git: (args: string[]) => Promise<Ran>, base: string, start: string, commit: string): Promise<string | undefined> {
  const moved = start === base ? await git(['merge', '--quiet', '--ff-only', commit]) : await git(['branch', '--force', base, commit])
  return moved.code === 0 ? undefined : `${base} did not move in this folder (${tail(moved.output, 300)}): run git pull here.`
}

async function isAncestor(git: (args: string[]) => Promise<Ran>, ancestor: string, of: string): Promise<boolean> {
  return (await git(['merge-base', '--is-ancestor', ancestor, of])).code === 0
}

const refused = (why: string): LandOutcome => ({ kind: 'refused', why })

function sameFolder(a: string, b: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }
  const [x, y] = [real(a), real(b)]
  return process.platform === 'win32' ? x.replace(/\\/g, '/').toLowerCase() === y.replace(/\\/g, '/').toLowerCase() : x === y
}

const lines = (text: string) =>
  text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
const tail = (text: string, size = OUTPUT_KEPT) => (text.length > size ? `…${text.slice(-size)}` : text).trim()
const head = (text: string) => (text.length > OUTPUT_KEPT ? `${text.slice(0, OUTPUT_KEPT)}…` : text).trim()

function described(ran: Ran, timeoutMs: number): string {
  const output = tail(ran.output) || '(it printed nothing)'
  const limit = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minutes` : `${Math.round(timeoutMs / 1000)} seconds`
  return ran.timedOut ? `${output}\n(stopped after ${limit})` : output
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !GIT_LOCATION.test(name)) env[name] = value
  return { ...env, ...extra }
}

/** Git never waits for a password nor an editor, and speaks English, which the outcome reads. */
const gitEnv = () => cleanEnv({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_MERGE_AUTOEDIT: 'no', LC_ALL: 'C', LANGUAGE: 'C' })

/** Runs a command and keeps what it printed, both streams together. A check runs in its own group, so a timeout stops all of it. */
function run(argv: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number; group?: boolean }): Promise<Ran> {
  return new Promise(resolve => {
    let output = ''
    let timedOut = false
    let child: ChildProcess
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: Boolean(options.group) && process.platform !== 'win32',
      })
    } catch (error) {
      resolve({ code: -1, output: String(error), missing: true })
      return
    }
    const add = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-BUFFER_KEPT)
    }
    child.stdout?.on('data', add)
    child.stderr?.on('data', add)
    const timer = setTimeout(() => {
      timedOut = true
      stop(child, Boolean(options.group))
    }, options.timeoutMs)
    let drain: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number | null) => {
      clearTimeout(timer)
      clearTimeout(drain)
      resolve({ code: code ?? -1, output, timedOut })
    }
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: -1, output: String(error), missing: (error as NodeJS.ErrnoException).code === 'ENOENT' })
    })
    child.on('exit', code => {
      // What a check left running in the background (a server, a watcher) stops with it, and keeps no pipe open.
      if (options.group && process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // Nothing was left.
        }
      }
      drain = setTimeout(() => finish(code), 2000)
    })
    child.on('close', finish)
  })
}

function stop(child: ChildProcess, group: boolean) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    else if (group) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}
