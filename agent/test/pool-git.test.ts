// The git side of task_merge, on real repositories in a temporary folder: branches that merge cleanly, conflict, break
// the build, or meet a main that is already broken. Main moves only when the checks pass, and the folder always ends
// clean, where it was.
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isBranchName, type LandRequest, PoolGit } from '../src/channel/pool-git'
import { git, isolateGit, makeRepos, originMain, pushBranch, pushMain, type Repos, write } from './git-repos'

const root = mkdtempSync(join(tmpdir(), 'tonton-pool-git-'))
const restore = isolateGit(root)
let count = 0
const fresh = (): Repos => makeRepos(join(root, `case-${++count}`))

afterAll(() => {
  restore()
  rmSync(root, { recursive: true, force: true })
})

/** The build fails when a BROKEN file is there. */
const CHECKS = ['test ! -e BROKEN']
const request = (branch: string, more: Partial<LandRequest> = {}): LandRequest => ({
  branch,
  message: `Merge ${branch}\n\nPool task t1: Feature`,
  checks: CHECKS,
  how: 'merge',
  title: 'Feature',
  body: 'What was done',
  ...more,
})

/** The folder as task_merge must leave it: on its branch, nothing changed, no merge under way. */
function settled(folder: string, branch = 'main') {
  expect(git(folder, 'symbolic-ref', '--short', 'HEAD')).toBe(branch)
  expect(git(folder, 'status', '--porcelain', '--untracked-files=no')).toBe('')
  expect(existsSync(join(folder, '.git', 'MERGE_HEAD'))).toBe(false)
}

describe('landing a branch', () => {
  test('a branch that merges cleanly and passes its checks lands on main, pushed, and main follows in the folder', async () => {
    const repos = fresh()
    pushBranch(repos.ana, 'pool/t1-feature', { 'feature.txt': 'new\n' })
    const before = originMain(repos)
    const outcome = await new PoolGit().land(repos.lead, request('pool/t1-feature'))
    if (outcome.kind !== 'merged') throw new Error(JSON.stringify(outcome))
    expect(outcome).toMatchObject({ base: 'main', already: false, pushed: true })
    expect(originMain(repos)).toBe(outcome.commit)
    // A merge commit: main before, then the branch.
    expect(git(repos.origin, 'rev-parse', `${outcome.commit}^1`)).toBe(before)
    expect(git(repos.origin, 'rev-parse', `${outcome.commit}^2`)).toBe(git(repos.ana, 'rev-parse', 'pool/t1-feature'))
    expect(git(repos.origin, 'log', '-1', '--format=%B', outcome.commit)).toContain('Pool task t1: Feature')
    settled(repos.lead)
    expect(git(repos.lead, 'rev-parse', 'main')).toBe(outcome.commit)
    expect(readFileSync(join(repos.lead, 'feature.txt'), 'utf8')).toBe('new\n')
  })

  test('a conflict changes nothing, and says which files and how', async () => {
    const repos = fresh()
    pushBranch(repos.ana, 'pool/t2-copy', { 'app.txt': 'three\n' })
    pushMain(repos.ana, { 'app.txt': 'two\n' })
    const before = originMain(repos)
    const outcome = await new PoolGit().land(repos.lead, request('pool/t2-copy'))
    if (outcome.kind !== 'conflict') throw new Error(JSON.stringify(outcome))
    expect(outcome.files).toEqual(['app.txt'])
    expect(outcome.output).toContain('<<<<<<<')
    expect(outcome.output).toContain('three')
    expect(originMain(repos)).toBe(before)
    settled(repos.lead)
  })

  test('a branch that breaks the build never reaches main: no merge, no revert, nothing pushed', async () => {
    const repos = fresh()
    pushBranch(repos.ana, 'pool/t3-broken', { BROKEN: 'yes\n', 'feature.txt': 'new\n' })
    const before = originMain(repos)
    const outcome = await new PoolGit().land(repos.lead, request('pool/t3-broken', { checks: ['echo building', ...CHECKS] }))
    expect(outcome).toMatchObject({ kind: 'failed', command: 'test ! -e BROKEN' })
    expect(originMain(repos)).toBe(before)
    expect(git(repos.origin, 'log', '--format=%s', 'main')).toBe('start')
    settled(repos.lead)
    expect(existsSync(join(repos.lead, 'BROKEN'))).toBe(false)
  })

  test('a main that already fails its checks is not blamed on the branch', async () => {
    const repos = fresh()
    pushMain(repos.ana, { BROKEN: 'since this morning\n' })
    pushBranch(repos.ana, 'pool/t4-fine', { 'feature.txt': 'new\n' })
    const before = originMain(repos)
    const outcome = await new PoolGit().land(repos.lead, request('pool/t4-fine'))
    expect(outcome).toMatchObject({ kind: 'main_red', command: 'test ! -e BROKEN' })
    expect(originMain(repos)).toBe(before)
    settled(repos.lead)
  })

  test('a main that passed the same checks is not built again to tell who broke it; one that moved is', async () => {
    const repos = fresh()
    const gitter = new PoolGit()
    // The check counts its runs.
    const counter = join(root, `runs-${count}`)
    const checks = [`echo run >> ${counter}; test ! -e BROKEN`]
    const runs = () => readFileSync(counter, 'utf8').trim().split('\n').length
    pushBranch(repos.ana, 'pool/t5-one', { 'one.txt': '1\n' })
    expect((await gitter.land(repos.lead, request('pool/t5-one', { checks }))).kind).toBe('merged')
    expect(runs()).toBe(1)
    pushBranch(repos.ana, 'pool/t5-two', { BROKEN: 'yes\n' })
    expect((await gitter.land(repos.lead, request('pool/t5-two', { checks }))).kind).toBe('failed')
    expect(runs()).toBe(2)
    // Main moved without the orchestrator: it is built again before the branch is blamed.
    pushMain(repos.ana, { 'other.txt': 'pushed by hand\n' })
    pushBranch(repos.ana, 'pool/t5-three', { BROKEN: 'again\n' })
    expect((await gitter.land(repos.lead, request('pool/t5-three', { checks }))).kind).toBe('failed')
    expect(runs()).toBe(4)
  })

  test('a branch already in main is marked merged without a new commit', async () => {
    const repos = fresh()
    pushBranch(repos.ana, 'pool/t6-done', { 'feature.txt': 'new\n' })
    git(repos.ana, 'switch', '--quiet', 'main')
    git(repos.ana, 'pull', '--quiet', 'origin', 'main')
    git(repos.ana, 'merge', '--quiet', '--ff-only', 'pool/t6-done')
    git(repos.ana, 'push', '--quiet', 'origin', 'main')
    const before = originMain(repos)
    const outcome = await new PoolGit().land(repos.lead, request('pool/t6-done'))
    expect(outcome).toMatchObject({ kind: 'merged', already: true, commit: before, pushed: false })
    expect(originMain(repos)).toBe(before)
  })

  test('main moving on origin during the checks is never forced over: nothing changes', async () => {
    const repos = fresh()
    pushBranch(repos.ana, 'pool/t7-race', { 'feature.txt': 'new\n' })
    // While the checks run, someone else pushes to main.
    const other = join(root, `other-${count}`)
    git(root, 'clone', '--quiet', repos.origin, other)
    const race = `cd ${other} && echo late > late.txt && git add late.txt && git commit --quiet -m late && git push --quiet origin main`
    const outcome = await new PoolGit().land(repos.lead, request('pool/t7-race', { checks: [race] }))
    expect(outcome.kind).toBe('refused')
    if (outcome.kind === 'refused') expect(outcome.why).toContain('moved on origin')
    expect(git(repos.origin, 'log', '-1', '--format=%s', 'main')).toBe('late')
    settled(repos.lead)
  })

  test('it goes back to the branch the folder was on, and moves main there too', async () => {
    const repos = fresh()
    git(repos.lead, 'switch', '--quiet', '-c', 'notes')
    pushBranch(repos.ana, 'pool/t8-feature', { 'feature.txt': 'new\n' })
    const outcome = await new PoolGit().land(repos.lead, request('pool/t8-feature'))
    if (outcome.kind !== 'merged') throw new Error(JSON.stringify(outcome))
    settled(repos.lead, 'notes')
    expect(git(repos.lead, 'rev-parse', 'main')).toBe(outcome.commit)
  })

  test('without a remote, the local branch is merged into the local main', async () => {
    const folder = join(root, `local-${++count}`)
    mkdirSync(folder)
    git(folder, 'init', '--quiet', '-b', 'main')
    write(folder, { 'app.txt': 'one\n' })
    git(folder, 'add', '.')
    git(folder, 'commit', '--quiet', '-m', 'start')
    git(folder, 'switch', '--quiet', '-c', 'pool/t9-local')
    write(folder, { 'feature.txt': 'new\n' })
    git(folder, 'add', '.')
    git(folder, 'commit', '--quiet', '-m', 'work')
    git(folder, 'switch', '--quiet', 'main')
    const outcome = await new PoolGit().land(folder, request('pool/t9-local'))
    if (outcome.kind !== 'merged') throw new Error(JSON.stringify(outcome))
    expect(outcome.pushed).toBe(false)
    expect(git(folder, 'rev-parse', 'main')).toBe(outcome.commit)
    settled(folder)
  })

  test('a check that runs too long is stopped and counts as failing', async () => {
    const repos = fresh()
    pushBranch(repos.ana, 'pool/t10-slow', { SLOW: 'yes\n' })
    const outcome = await new PoolGit({ checkTimeoutMs: 2000 }).land(
      repos.lead,
      request('pool/t10-slow', { checks: ['test ! -e SLOW || sleep 30'] }),
    )
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.output).toContain('stopped after 2 seconds')
    settled(repos.lead)
  }, 15_000)
})

describe('pull requests', () => {
  test('with pr, the checked branch gets a pull request and main does not move', async () => {
    const repos = fresh()
    pushBranch(repos.ana, 'pool/t11-pr', { 'feature.txt': 'new\n' })
    const bin = join(root, `bin-${count}`)
    mkdirSync(bin)
    const args = join(bin, 'args')
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${args}\necho https://github.com/team/app/pull/7\n`)
    chmodSync(join(bin, 'gh'), 0o755)
    const before = originMain(repos)
    const outcome = await new PoolGit({ gh: join(bin, 'gh') }).land(repos.lead, request('pool/t11-pr', { how: 'pr' }))
    expect(outcome).toEqual({ kind: 'pr', url: 'https://github.com/team/app/pull/7', base: 'main' })
    expect(readFileSync(args, 'utf8')).toContain('--head=pool/t11-pr\n')
    expect(originMain(repos)).toBe(before)
    expect(git(repos.lead, 'rev-parse', 'main')).toBe(before)
    settled(repos.lead)
  })

  test('without gh, it says so', async () => {
    const repos = fresh()
    pushBranch(repos.ana, 'pool/t12-pr', { 'feature.txt': 'new\n' })
    const outcome = await new PoolGit({ gh: join(root, 'no-such-gh') }).land(repos.lead, request('pool/t12-pr', { how: 'pr' }))
    expect(outcome.kind).toBe('refused')
    if (outcome.kind === 'refused') expect(outcome.why).toContain('gh is not installed')
  })
})

describe('what it refuses', () => {
  test('uncommitted changes, a folder that is not the top of the repository, a branch nobody pushed', async () => {
    const repos = fresh()
    pushBranch(repos.ana, 'pool/t13-feature', { 'feature.txt': 'new\n' })
    const gitter = new PoolGit()
    write(repos.lead, { 'app.txt': 'being edited\n' })
    expect(await gitter.land(repos.lead, request('pool/t13-feature'))).toMatchObject({ kind: 'refused' })
    expect(readFileSync(join(repos.lead, 'app.txt'), 'utf8')).toBe('being edited\n')
    git(repos.lead, 'checkout', '--quiet', '--', 'app.txt')

    mkdirSync(join(repos.lead, 'web'))
    const below = await gitter.land(join(repos.lead, 'web'), request('pool/t13-feature'))
    expect(below.kind === 'refused' && below.why).toContain('not the top of a git repository')
    const outside = await gitter.land(root, request('pool/t13-feature'))
    expect(outside.kind).toBe('refused')

    const missing = await gitter.land(repos.lead, request('pool/t13-nobody'))
    expect(missing.kind === 'refused' && missing.why).toContain('has to push it')
    expect(originMain(repos)).toBe(git(repos.lead, 'rev-parse', 'main'))
  })

  test('branch names that are not branches, or could pass for an option', () => {
    for (const name of ['pool/t1-feature', 'feat/x', 'main', 'pool/abc123-items-api']) expect(isBranchName(name)).toBe(true)
    for (const name of ['--upload-pack=touch x', '-x', 'a..b', 'a//b', 'a/.b', 'x.lock', 'a b', 'a/', '', 'a@{1}', 'a;rm'])
      expect(isBranchName(name)).toBe(false)
  })
})
