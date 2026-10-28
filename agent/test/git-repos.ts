// Real git repositories for the merge tests, in a temporary folder: a bare origin, the orchestrator's clone and a
// worker's clone. The developer's own git config (identity, signing, hooks) stays out of them, and so do their repos.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface Repos {
  origin: string
  /** The orchestrator's folder. */
  lead: string
  /** A worker's clone, which pushes the task branches. */
  ana: string
}

/** A git config of its own for this process and the agents it starts: returns what undoes it. */
export function isolateGit(root: string): () => void {
  const config = join(root, 'gitconfig')
  writeFileSync(
    config,
    '[user]\n\tname = Pool Test\n\temail = pool@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n',
  )
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
  process.env.GIT_CONFIG_GLOBAL = config
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

export function git(cwd: string, ...args: string[]): string {
  const ran = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (ran.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${ran.stderr}`)
  return ran.stdout.trim()
}

export function write(folder: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true })
    writeFileSync(join(folder, path), content)
  }
}

/** An origin with one commit on main, cloned twice. */
export function makeRepos(dir: string): Repos {
  mkdirSync(dir, { recursive: true })
  const origin = join(dir, 'origin.git')
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin)
  const lead = join(dir, 'lead')
  git(dir, 'clone', '--quiet', origin, lead)
  write(lead, { 'app.txt': 'one\n' })
  git(lead, 'add', '.')
  git(lead, 'commit', '--quiet', '-m', 'start')
  git(lead, 'push', '--quiet', '-u', 'origin', 'main')
  const ana = join(dir, 'ana')
  git(dir, 'clone', '--quiet', origin, ana)
  return { origin, lead, ana }
}

/** A worker's branch from origin's main, with these files, pushed. */
export function pushBranch(clone: string, branch: string, files: Record<string, string>, from = 'origin/main') {
  git(clone, 'fetch', '--quiet', 'origin')
  git(clone, 'switch', '--quiet', '-C', branch, from)
  write(clone, files)
  git(clone, 'add', '.')
  git(clone, 'commit', '--quiet', '-m', `work on ${branch}`)
  git(clone, 'push', '--quiet', '-u', 'origin', branch)
}

/** Someone pushes straight to main. */
export function pushMain(clone: string, files: Record<string, string>) {
  git(clone, 'fetch', '--quiet', 'origin')
  git(clone, 'switch', '--quiet', '-C', 'main', 'origin/main')
  write(clone, files)
  git(clone, 'add', '.')
  git(clone, 'commit', '--quiet', '-m', 'straight to main')
  git(clone, 'push', '--quiet', 'origin', 'main')
}

/** Where main points on origin. */
export const originMain = (repos: Repos) => git(repos.origin, 'rev-parse', 'refs/heads/main')
