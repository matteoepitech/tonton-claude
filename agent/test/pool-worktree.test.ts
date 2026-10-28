// The git a pool machine runs (docs/pool-autopilot.md), on temporary repositories: a clone in the work folder, a
// worktree per task on its branch, kept when the task comes back, and nothing run for what git should never get.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRepository, prepareTaskTree, taskBranch, workFolder } from '../src/service/pool-worktree'
import { git, isolateGit, makeRepos, pushBranch, pushMain } from './git-repos'

const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-worktree-'))
const restoreGit = isolateGit(dir)

afterAll(() => {
  restoreGit()
  rmSync(dir, { recursive: true, force: true })
})

describe('a task worktree', () => {
  test("is checked out from the remote's main on the task's branch, inside the work folder", async () => {
    const repos = makeRepos(join(dir, 'shop'))
    const workdir = join(dir, 'work')
    const tree = await prepareTaskTree(workdir, repos.origin, 'task0001abc', 'pool/task0001abc-api')
    if (typeof tree === 'string') throw new Error(tree)
    expect(tree).toEqual({ cwd: realpathSync(join(workdir, 'tasks', 'task0001abc')), branch: 'pool/task0001abc-api' })
    expect(git(tree.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('pool/task0001abc-api')
    expect(git(tree.cwd, 'rev-parse', 'HEAD')).toBe(git(repos.lead, 'rev-parse', 'HEAD'))
    expect(existsSync(join(workdir, 'repo', '.git'))).toBe(true)

    // The task comes back after a review: its worktree and what was done in it stay.
    writeFileSync(join(tree.cwd, 'work.txt'), 'half done')
    const again = await prepareTaskTree(workdir, repos.origin, 'task0001abc', 'pool/task0001abc-api')
    expect(again).toEqual(tree)
    expect(readFileSync(join(tree.cwd, 'work.txt'), 'utf8')).toBe('half done')

    // Another task gets its own, from main as it is now.
    pushMain(repos.ana, { 'later.md': 'later' })
    const second = await prepareTaskTree(workdir, repos.origin, 'task0002abc', 'pool/task0002abc-ui')
    if (typeof second === 'string') throw new Error(second)
    expect(existsSync(join(second.cwd, 'later.md'))).toBe(true)
  })

  test('tasks that start at once on a new machine share one clone, and each gets its worktree', async () => {
    const repos = makeRepos(join(dir, 'together'))
    const workdir = join(dir, 'together-work')
    const ids = ['task0011abc', 'task0012abc', 'task0013abc']
    const trees = await Promise.all(ids.map(id => prepareTaskTree(workdir, repos.origin, id, `pool/${id}`)))
    for (const [index, tree] of trees.entries()) {
      if (typeof tree === 'string') throw new Error(tree)
      expect(git(tree.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`pool/${ids[index]}`)
    }
  })

  test('a task retried on another machine starts from the branch an earlier attempt pushed', async () => {
    const repos = makeRepos(join(dir, 'retried'))
    pushBranch(repos.ana, 'pool/task0003abc-docs', { 'docs.md': 'first attempt' })
    const tree = await prepareTaskTree(join(dir, 'other-machine'), repos.origin, 'task0003abc', 'pool/task0003abc-docs')
    if (typeof tree === 'string') throw new Error(tree)
    expect(readFileSync(join(tree.cwd, 'docs.md'), 'utf8')).toBe('first attempt')
  })

  test('git gets nothing it should not: an option, another transport, a relative folder, a bad id or branch', async () => {
    const url = makeRepos(join(dir, 'guarded')).origin
    const workdir = join(dir, 'guarded-work')
    for (const [repo, taskId, branch, folder] of [
      ['--upload-pack=touch /tmp/x', 'task0004abc', 'pool/task0004abc', workdir],
      ['ext::sh -c touch% /tmp/x', 'task0004abc', 'pool/task0004abc', workdir],
      ['relative/repo', 'task0004abc', 'pool/task0004abc', workdir],
      [url, '../../etc', 'pool/task0004abc', workdir],
      [url, 'task0004abc', 'main', workdir],
      [url, 'task0004abc', 'pool/task0004abc; rm -rf ~', workdir],
      [url, 'task0004abc', 'pool/task0004abc', 'relative/work'],
    ]) {
      expect(typeof (await prepareTaskTree(folder, repo, taskId, branch))).toBe('string')
    }
    expect(existsSync(workdir)).toBe(false)
    // A clone that fails says why.
    mkdirSync(join(dir, 'empty'))
    const failed = await prepareTaskTree(join(dir, 'failing-work'), join(dir, 'missing.git'), 'task0005abc', 'pool/task0005abc')
    expect(failed).toStartWith('git clone failed')
  })
})

describe('names', () => {
  test('repositories git may clone', () => {
    for (const good of [
      'https://github.com/a/b.git',
      'ssh://git@host/a/b',
      'git@github.com:a/b.git',
      '/srv/repos/b.git',
      'file:///srv/b',
    ]) {
      expect(isRepository(good)).toBe(true)
    }
    for (const bad of ['', '-u', 'ext::sh -c x', 'fd::17', 'a b', 'relative', 'git@host', 5, null]) expect(isRepository(bad)).toBe(false)
  })

  test("a task's branch is its own when it has a good one, else made from its title", () => {
    expect(taskBranch('task0001abc', 'API client', 'pool/task0001abc-api-client')).toBe('pool/task0001abc-api-client')
    expect(taskBranch('task0001abc', 'API client', 'main')).toBe('pool/task0001abc-api-client')
    // As the orchestrator names them (channel/pool-orchestrator.ts, branchFor), and nothing git could misread.
    expect(taskBranch('task0001abc', 'API client', 'pool/task00-api')).toBe('pool/task00-api')
    expect(taskBranch('task0001abc', 'API client', 'pool/../main')).toBe('pool/task0001abc-api-client')
    expect(taskBranch('task0001abc', 'API client', 'pool/a b')).toBe('pool/task0001abc-api-client')
    expect(taskBranch('task0001abc', 'Écran de connexion !!')).toBe('pool/task0001abc-ecran-de-connexion')
    expect(taskBranch('task0001abc', '🚀')).toBe('pool/task0001abc')
  })

  test('the work folder is a full path, from the home folder when it starts with ~', () => {
    expect(workFolder('~/pool', '/home/me')).toBe('/home/me/pool')
    expect(workFolder('/srv/pool/')).toBe('/srv/pool')
    expect(workFolder('pool')).toBeNull()
  })
})
