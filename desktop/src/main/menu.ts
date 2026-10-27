// The island's menu, in the tray and under the island's ⋯ button: showing it, adding machines, the recovery key, starting
// at login. On Linux the tray only shows a menu, so everything the tray icon's click does is in it too.

import type { MenuItemConstructorOptions } from 'electron'

export interface MenuState {
  signedIn: boolean
  visible: boolean
  /** Null where the island cannot start at login. */
  openAtLogin: boolean | null
}

export interface MenuActions {
  toggle(): void
  copyInstallCommand(platform: 'windows' | 'unix'): void
  copyRecoveryKey(): void
  setOpenAtLogin(enabled: boolean): void
  signOut(): void
  quit(): void
}

export function menuTemplate(state: MenuState, actions: MenuActions): MenuItemConstructorOptions[] {
  const account: MenuItemConstructorOptions[] = [
    {
      label: 'Add a machine',
      submenu: [
        { label: 'Copy the command for Windows (PowerShell)', click: () => actions.copyInstallCommand('windows') },
        { label: 'Copy the command for macOS and Linux', click: () => actions.copyInstallCommand('unix') },
      ],
    },
    { label: 'Copy the recovery key', click: () => actions.copyRecoveryKey() },
  ]
  const login: MenuItemConstructorOptions[] =
    state.openAtLogin === null
      ? []
      : [{ label: 'Start at login', type: 'checkbox', checked: state.openAtLogin, click: item => actions.setOpenAtLogin(item.checked) }]
  const sections: MenuItemConstructorOptions[][] = [
    [{ label: state.visible ? 'Hide the island' : 'Show the island', click: () => actions.toggle() }],
    state.signedIn ? account : [],
    [...login, ...(state.signedIn ? [{ label: 'Sign out', click: () => actions.signOut() }] : [])],
    [{ label: 'Quit Tonton Claude', click: () => actions.quit() }],
  ]
  return sections
    .filter(section => section.length > 0)
    .flatMap((section, index) => (index === 0 ? section : [{ type: 'separator' as const }, ...section]))
}
