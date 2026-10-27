// What the island does differently on Linux: running through XWayland where it can, and starting at login with an XDG
// autostart entry. Pure, so the tests run without Electron or a desktop.

// Linux paths, also when the tests run on Windows.
import { join } from 'node:path/posix'

type Env = Record<string, string | undefined>

/**
 * GNOME and KDE on Wayland let no app place its window or keep it above the others: that is the compositor's call. Their
 * X11 windows through XWayland still can, so the island runs as one there. TONTON_ISLAND_WAYLAND=1 keeps it native,
 * where it is a plain window the compositor places. Without XWayland (no DISPLAY), there is no choice.
 */
export function wantsXWayland(env: Env): boolean {
  const wayland = env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY
  return wayland && !!env.DISPLAY && env.TONTON_ISLAND_WAYLAND !== '1'
}

/** The island runs on Wayland where it should run through XWayland. Electron sets the switch itself: `wayland`, `x11`. */
export const relaunchesInXWayland = (env: Env, platformSwitch: string): boolean => wantsXWayland(env) && platformSwitch !== 'x11'

/** `~/.config/autostart/…`, where GNOME, KDE and the other XDG desktops look for what to start at login. */
export function autostartFile(env: Env, home: string): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'autostart', 'tonton-claude-island.desktop')
}

/** The program to start: the AppImage itself when it runs from one (its runtime sets APPIMAGE), else the executable. */
export const autostartProgram = (env: Env, execPath: string): string => env.APPIMAGE || execPath

/** The autostart entry. The path is quoted as the Desktop Entry spec asks: the .deb installs under "/opt/Tonton Claude". */
export function autostartEntry(program: string): string {
  const quoted = `"${program.replace(/[\\"`$]/g, char => `\\${char}`)}"`
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Tonton Claude',
    'Comment=Your Claude Code sessions at the top of the screen',
    // Exec unescapes once more: a backslash in the quoted path must be doubled again.
    `Exec=${quoted.replace(/\\/g, '\\\\')}`,
    'Icon=tonton-claude',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}
