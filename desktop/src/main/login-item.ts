// Starting the island when the user logs in, off until they tick it in the menu, like the Mac app's Launch at login.
// Windows keeps it in the user's Run key, through Electron.

import { app } from 'electron'

export interface LoginItem {
  /** Null where the island cannot start at login. */
  enabled(): boolean | null
  set(enabled: boolean): void
}

export function loginItem(): LoginItem {
  if (process.platform === 'win32') {
    return {
      enabled: () => app.getLoginItemSettings().openAtLogin,
      set: enabled => app.setLoginItemSettings({ openAtLogin: enabled }),
    }
  }
  return { enabled: () => null, set: () => {} }
}
