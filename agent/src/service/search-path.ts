// The folders the background service looks for programs in, and the shell its sessions start in. Started by launchd or systemd, it gets a short PATH
// (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS) without Homebrew, MacPorts or the user's own bin folders, where tmux, git and
// the coding tools usually are: a pool machine then could not start a session. The service adds the usual ones that
// exist after what it was given, so a PATH its owner set still wins.

import { existsSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { delimiter, join } from 'node:path'

/** Where package managers and installers put programs, by platform. Windows services see the user's PATH already. */
export function usualFolders(platform: NodeJS.Platform = process.platform, home = homedir()): string[] {
  if (platform === 'win32') return []
  const user = [join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, '.npm-global', 'bin'), join(home, 'bin')]
  const system = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  if (platform === 'darwin') return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/opt/local/bin', ...system, ...user]
  return ['/home/linuxbrew/.linuxbrew/bin', '/snap/bin', ...system, ...user]
}

/** The PATH with the usual folders that exist added after its own, each once. */
export function searchPath(
  path = process.env.PATH ?? '',
  folders = usualFolders(),
  exists: (folder: string) => boolean = existsSync,
): string {
  const parts = path.split(delimiter).filter(Boolean)
  for (const folder of folders) if (!parts.includes(folder) && exists(folder)) parts.push(folder)
  return parts.join(delimiter)
}

/**
 * The user's login shell, for the sessions the service starts: launchd gives it no SHELL, and `/bin/sh` reads none of the
 * user's profile, where nvm, asdf or Homebrew put `claude` on the PATH and the Tonton launcher is set up. Null on
 * Windows, or when the system does not say.
 */
export function loginShell(info: () => { shell: string | null } = userInfo): string | null {
  try {
    const shell = info().shell
    return shell?.startsWith('/') && !shell.endsWith('/false') && !shell.endsWith('/nologin') ? shell : null
  } catch {
    return null
  }
}
