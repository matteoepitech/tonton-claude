// The island's window: frameless, transparent, above other windows and out of the taskbar, the size of what its page
// shows, and kept at the top of the primary screen as displays come and go.

import { app, BrowserWindow, type Menu, screen } from 'electron'
import { CHANNELS, type IslandCommand, type IslandMode } from '../bridge'
import { islandBounds } from './geometry'

export class IslandWindow {
  readonly window: BrowserWindow
  private mode: IslandMode = 'collapsed'
  /** A menu of the island is open: the focus it takes must not close the island under it. */
  private menuOpen = false
  private quitting = false

  constructor(page: string, preload: string, onVisibility: () => void) {
    this.window = new BrowserWindow({
      ...this.bounds(),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Electron skips the taskbar on Windows only. On Linux, a toolbar window is kept out of the taskbar and the window
      // switcher by GNOME and KDE, and still takes the keyboard.
      ...(process.platform === 'linux' ? { type: 'toolbar' } : {}),
      alwaysOnTop: true,
      title: 'Tonton Claude',
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    })
    // Above the taskbar and other always-on-top windows, like a notification.
    this.window.setAlwaysOnTop(true, 'screen-saver')
    this.window.setVisibleOnAllWorkspaces(true)
    this.window.on('blur', () => {
      if (!this.menuOpen) this.send('blur')
    })
    this.window.on('show', onVisibility)
    this.window.on('hide', onVisibility)
    // Alt+F4 and the like hide it: only Quit ends the app, or Windows logging off or shutting down, which it must not hold.
    const quitting = () => {
      this.quitting = true
    }
    app.on('before-quit', quitting)
    this.window.on('session-end', quitting)
    this.window.on('close', event => {
      if (this.quitting) return
      event.preventDefault()
      this.toggle()
    })
    const place = () => this.place()
    screen.on('display-added', place)
    screen.on('display-removed', place)
    screen.on('display-metrics-changed', place)
    this.window.once('ready-to-show', () => this.window.showInactive())
    void this.window.loadFile(page)
  }

  get visible(): boolean {
    return this.window.isVisible()
  }

  /** The page opened or closed the island. Opening takes the keyboard, for the composer and the permission buttons. */
  setMode(mode: IslandMode) {
    this.mode = mode
    this.place()
    if (mode === 'expanded') this.window.focus()
  }

  /** From the tray or the menu: shown open, or hidden closed. */
  toggle() {
    if (this.visible) {
      this.send('collapse')
      this.window.hide()
    } else {
      this.place()
      this.window.show()
      this.send('expand')
    }
  }

  /** Under the pointer, which is on the island's ⋯ button. */
  popup(menu: Menu) {
    this.menuOpen = true
    menu.popup({
      window: this.window,
      callback: () => {
        this.menuOpen = false
      },
    })
  }

  send(command: IslandCommand) {
    if (!this.window.isDestroyed()) this.window.webContents.send(CHANNELS.command, command)
  }

  private bounds() {
    return islandBounds(screen.getPrimaryDisplay().workArea, this.mode)
  }

  private place() {
    if (!this.window.isDestroyed()) this.window.setBounds(this.bounds())
  }
}
