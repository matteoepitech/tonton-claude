import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { paths } from '../config'
import type { Shell } from './shell-profile'

export const IS_WINDOWS = process.platform === 'win32'

export const binaryPath = () => join(paths.bin, IS_WINDOWS ? 'tonton.exe' : 'tonton')
/** Windows copy of the agent that starts without a console window, for the background service. */
export const windowlessBinaryPath = () => join(paths.bin, 'tontonw.exe')
/** macOS menu bar icon, a separate Swift program published with the agents. */
export const trayHelperPath = () => join(paths.bin, 'tonton-tray')

/** Copies the running binary to ~/.tonton/bin, plus its windowless twin on Windows. */
export function installBinary(): string {
  const target = binaryPath()
  mkdirSync(paths.bin, { recursive: true })
  if (process.execPath !== target && /tonton/i.test(process.execPath)) replaceExecutable(target, readFileSync(process.execPath))
  if (IS_WINDOWS && existsSync(target)) replaceExecutable(windowlessBinaryPath(), withoutConsole(readFileSync(target)))
  for (const file of readdirSync(paths.bin).filter(name => name.includes('.old-'))) {
    try {
      unlinkSync(join(paths.bin, file))
    } catch {
      // Still running: removed by the next install.
    }
  }
  return target
}

/**
 * Writes an executable that may be running. Windows can't overwrite or delete it, but can rename it out of the way;
 * elsewhere the rename swaps it atomically and running processes keep the old file.
 */
export function replaceExecutable(target: string, data: Uint8Array) {
  mkdirSync(dirname(target), { recursive: true })
  const staged = `${target}.new-${process.pid}${IS_WINDOWS ? '.exe' : ''}`
  writeFileSync(staged, data, { mode: 0o755 })
  moveExecutable(staged, target)
}

export function moveExecutable(source: string, target: string) {
  if (IS_WINDOWS && existsSync(target)) {
    try {
      unlinkSync(target)
    } catch {
      renameSync(target, `${target}.old-${Date.now()}`)
    }
  }
  renameSync(source, target)
}

/** The same program marked as a GUI app, so Windows starts it without a console: what `bun build --windows-hide-console` does. */
export function withoutConsole(exe: Uint8Array): Uint8Array {
  const copy = new Uint8Array(exe)
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength)
  const header = view.getUint32(0x3c, true)
  if (view.getUint32(header, true) !== 0x4550) throw new Error('not a Windows executable')
  // Subsystem field of the optional header: 2 is a GUI app, 3 a console app.
  view.setUint16(header + 24 + 68, 2, true)
  return copy
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
