import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitBranch } from '../src/git'

const dir = mkdtempSync(join(tmpdir(), 'tonton-git-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A repository's `.git` folder with this HEAD. */
function repo(name: string, head: string): string {
  const root = join(dir, name)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), `${head}\n`)
  return root
}

test('the branch of the repository, from its folder or one below', () => {
  const root = repo('plain', 'ref: refs/heads/feat/login')
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  expect(gitBranch(root)).toBe('feat/login')
  expect(gitBranch(join(root, 'src', 'deep'))).toBe('feat/login')
})

test('a worktree points to its own folder with a .git file, relative or absolute', () => {
  const main = repo('main', 'ref: refs/heads/main')
  const relative = join(dir, 'wt-relative')
  mkdirSync(join(main, '.git', 'worktrees', 'wt1'), { recursive: true })
  writeFileSync(join(main, '.git', 'worktrees', 'wt1', 'HEAD'), 'ref: refs/heads/fix/crash\n')
  mkdirSync(relative)
  writeFileSync(join(relative, '.git'), 'gitdir: ../main/.git/worktrees/wt1\n')
  expect(gitBranch(relative)).toBe('fix/crash')

  const absolute = join(dir, 'wt-absolute')
  mkdirSync(join(main, '.git', 'worktrees', 'wt2'), { recursive: true })
  writeFileSync(join(main, '.git', 'worktrees', 'wt2', 'HEAD'), 'ref: refs/heads/docs\n')
  mkdirSync(absolute)
  writeFileSync(join(absolute, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt2')}\n`)
  expect(gitBranch(absolute)).toBe('docs')
})

test('a detached HEAD gives its short commit, anything else no branch', () => {
  expect(gitBranch(repo('detached', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'))).toBe('a1b2c3d')
  expect(gitBranch(repo('odd', 'garbage'))).toBeNull()
  const broken = join(dir, 'broken')
  mkdirSync(broken)
  writeFileSync(join(broken, '.git'), 'not a pointer')
  expect(gitBranch(broken)).toBeNull()
  // A folder outside any repository (the temporary folder has none above it).
  const outside = join(dir, 'outside')
  mkdirSync(outside)
  expect(gitBranch(outside)).toBeNull()
  expect(gitBranch(join(dir, 'missing'))).toBeNull()
})
