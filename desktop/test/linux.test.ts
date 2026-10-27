// The island on Linux, without a desktop: when it goes through XWayland, and its autostart entry.
import { describe, expect, test } from 'bun:test'
import { autostartEntry, autostartFile, autostartProgram, relaunchesInXWayland, wantsXWayland } from '../src/main/linux'

describe('XWayland', () => {
  test('GNOME and KDE on Wayland, with XWayland, get the X11 window that can stay on top', () => {
    expect(wantsXWayland({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })).toBe(true)
    expect(wantsXWayland({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':1' })).toBe(true)
  })

  test('X11 sessions, Wayland without XWayland, and TONTON_ISLAND_WAYLAND=1 stay as they are', () => {
    expect(wantsXWayland({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' })).toBe(false)
    expect(wantsXWayland({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' })).toBe(false)
    expect(wantsXWayland({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0', TONTON_ISLAND_WAYLAND: '1' })).toBe(false)
  })

  test('it starts again once, until Electron runs on X11', () => {
    const gnome = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }
    // Electron writes the platform it picked on its own command line.
    expect(relaunchesInXWayland(gnome, 'wayland')).toBe(true)
    expect(relaunchesInXWayland(gnome, '')).toBe(true)
    expect(relaunchesInXWayland(gnome, 'x11')).toBe(false)
    expect(relaunchesInXWayland({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, 'x11')).toBe(false)
  })
})

describe('starting at login', () => {
  test('is an XDG autostart entry, in XDG_CONFIG_HOME when it is set', () => {
    expect(autostartFile({}, '/home/ada')).toBe('/home/ada/.config/autostart/tonton-claude-island.desktop')
    expect(autostartFile({ XDG_CONFIG_HOME: '/cfg' }, '/home/ada')).toBe('/cfg/autostart/tonton-claude-island.desktop')
  })

  test('starts the AppImage file when there is one, not its mount', () => {
    expect(autostartProgram({ APPIMAGE: '/home/ada/Apps/TontonClaude.AppImage' }, '/tmp/.mount_x/tonton-claude')).toBe(
      '/home/ada/Apps/TontonClaude.AppImage',
    )
    expect(autostartProgram({}, '/opt/Tonton Claude/tonton-claude')).toBe('/opt/Tonton Claude/tonton-claude')
  })

  test('quotes the path as the Desktop Entry spec asks', () => {
    const entry = autostartEntry('/opt/Tonton Claude/tonton-claude')
    expect(entry).toStartWith('[Desktop Entry]\nType=Application\n')
    expect(entry).toContain('\nExec="/opt/Tonton Claude/tonton-claude"\n')
    // $, ` and " get a backslash, which the string escape then doubles; a backslash ends up as four.
    expect(autostartEntry('/a$b`c"d\\e')).toContain('\nExec="/a\\\\$b\\\\`c\\\\"d\\\\\\\\e"\n')
  })
})
