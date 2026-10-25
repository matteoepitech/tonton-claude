import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { paths } from '../config'
import type { Shell } from './shell-profile'

export const IS_WINDOWS = process.platform === 'win32'

/** Copies the running binary to ~/.tonton/bin. A binary still in use on Windows is renamed, then cleaned later. */
export function installBinary(): string {
  const target = join(paths.bin, IS_WINDOWS ? 'tonton.exe' : 'tonton')
  mkdirSync(paths.bin, { recursive: true })
  if (process.execPath !== target && /tonton/i.test(process.execPath)) {
    if (IS_WINDOWS && existsSync(target)) {
      try {
        unlinkSync(target)
      } catch {
        writeFileSync(`${target}.old-${Date.now()}`, readFileSync(target))
      }
    }
    copyFileSync(process.execPath, target)
  }
  for (const file of readdirSync(paths.bin).filter(name => name.includes('.old-'))) {
    try {
      unlinkSync(join(paths.bin, file))
    } catch {
      // Still running in an open session: removed by the next install.
    }
  }
  return target
}

/** Runs the claude CLI. On Windows it is often a .cmd shim, which only resolves through cmd. */
export function runClaude(args: string[]): boolean {
  const command = IS_WINDOWS ? ['cmd', '/c', 'claude', ...args] : ['claude', ...args]
  try {
    return Bun.spawnSync(command, { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
  } catch {
    return false
  }
}

export function registerMcpServer(binary: string): boolean {
  runClaude(['mcp', 'remove', '--scope', 'user', 'tonton'])
  return runClaude(['mcp', 'add', '--scope', 'user', 'tonton', '--', binary, 'channel'])
}

export function unregisterMcpServer() {
  runClaude(['mcp', 'remove', '--scope', 'user', 'tonton'])
}

/** Profiles that get the launcher: zsh/bash on Unix, every installed PowerShell on Windows. */
export function shellProfiles(): { file: string; shell: Shell }[] {
  if (IS_WINDOWS) {
    const profiles: { file: string; shell: Shell }[] = []
    for (const executable of ['powershell', 'pwsh']) {
      try {
        const result = Bun.spawnSync([executable, '-NoProfile', '-Command', '$PROFILE.CurrentUserAllHosts'], {
          stdout: 'pipe',
          stderr: 'ignore',
        })
        const file = result.stdout.toString().trim()
        if (result.exitCode === 0 && file) profiles.push({ file, shell: 'powershell' })
      } catch {
        // This PowerShell edition is not installed.
      }
    }
    return profiles
  }
  const userShell = process.env.SHELL ?? ''
  return (['zsh', 'bash'] as const)
    .filter(name => existsSync(join(homedir(), `.${name}rc`)) || userShell.endsWith(name))
    .map(name => ({ file: join(homedir(), `.${name}rc`), shell: 'posix' as const }))
}
