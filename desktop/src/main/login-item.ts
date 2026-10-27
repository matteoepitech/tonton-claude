// Starting the island when the user logs in, off until they tick it in the menu, like the Mac app's Launch at login.
// Windows keeps it in the user's Run key, through Electron; Linux desktops read an XDG autostart entry.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { app } from 'electron'
import { autostartEntry, autostartFile, autostartProgram } from './linux'

export interface LoginItem {
  /** Null where the island cannot start at login. */
  enabled(): boolean | null
  set(enabled: boolean): void
}

export function loginItem(): LoginItem {
  // Run from source, it would register a bare Electron.
  if (!app.isPackaged) return { enabled: () => null, set: () => {} }
  if (process.platform === 'win32') {
    return {
      enabled: () => app.getLoginItemSettings().openAtLogin,
      set: enabled => app.setLoginItemSettings({ openAtLogin: enabled }),
    }
  }
  if (process.platform === 'linux') {
    const file = autostartFile(process.env, homedir())
    return {
      enabled: () => existsSync(file),
      set: enabled => {
        try {
          if (!enabled) return rmSync(file, { force: true })
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, autostartEntry(autostartProgram(process.env, process.execPath)))
        } catch {
          // A read-only config folder: the menu shows the item unticked, as it is.
        }
      },
    }
  }
  return { enabled: () => null, set: () => {} }
}
