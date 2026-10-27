// Tonton Claude for Windows and Linux: the account's sessions in an island at the top of the screen, always on top, with
// a tray icon. The page is the web app's views (src/renderer); this process keeps the account, in the system's keyring
// when there is one, and puts the relay token on the page's socket, so the page only ever holds the end-to-end key.

import { join } from 'node:path'
import {
  app,
  clipboard,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  nativeImage,
  net,
  safeStorage,
  session,
  shell,
  Tray,
} from 'electron'
import { normalizeRelay, parseAccountToken } from '../../../shared/account-token'
import { encodeRecoveryKey, parseRecoveryKey, type RecoveredAccount } from '../../../shared/recovery-key'
import { CHANNELS, type IslandAccount, type SignInResult } from '../bridge'
import { AccountStore, type Keyring } from './account-store'
import { IslandWindow } from './island-window'
import { relaunchesInXWayland } from './linux'
import { loginItem } from './login-item'
import { menuTemplate } from './menu'
import { createAccount, installCommand, joinSecret, machineToken, RelayError, verifyAccount } from './relay-api'
import { authorizeRelaySocket } from './relay-auth'

// Tests and development runs keep their account apart from the installed island's.
if (process.env.TONTON_ISLAND_HOME) app.setPath('userData', process.env.TONTON_ISLAND_HOME)
if (process.platform === 'win32') app.setAppUserModelId('tech.d3l.tontonclaude.island')
// On GNOME and KDE Wayland, only an XWayland window can stay on top at the top of the screen. Chromium picks its platform
// before this script runs, so the island starts again with the switch (from the AppImage file, which the first run's exit
// unmounts).
const toXWayland = process.platform === 'linux' && relaunchesInXWayland(process.env, app.commandLine.getSwitchValue('ozone-platform'))

/** Long enough for any recovery key or relay address, short enough to refuse junk. */
const MAX_INPUT = 8192

let island: IslandWindow | null = null
let tray: Tray | null = null
let account: RecoveredAccount | null = null
/** The account is in the keyring, and changes to it go there too. */
let remembered = false
let store: AccountStore

if (toXWayland) {
  app.relaunch({ execPath: process.env.APPIMAGE, args: [...process.argv.slice(1), '--ozone-platform=x11'] })
  app.exit(0)
} else if (app.requestSingleInstanceLock()) {
  // Opening the app again shows the island: the way back when there is no tray to click.
  app.on('second-instance', () => {
    if (island && !island.visible) island.toggle()
  })
  // The island hides, it never closes: the app runs until Quit.
  app.on('window-all-closed', () => {})
  // Without its window or its tray, the island would hold the single-instance lock with nothing on screen: say so and quit.
  app
    .whenReady()
    .then(start)
    .catch(error => {
      dialog.showErrorBox('Tonton Claude could not start', error instanceof Error ? error.message : String(error))
      app.exit(1)
    })
} else {
  app.quit()
}

/** What scripts/build.ts puts in dist/. Not from __dirname: the bundler writes the build machine's folder in its place. */
const built = (file: string) => join(app.getAppPath(), 'dist', file)

function start() {
  store = new AccountStore(join(app.getPath('userData'), 'account'), keyring())
  account = store.load()
  remembered = account !== null
  harden()
  authorizeRelaySocket(session.defaultSession, () => account)
  handlePage()
  island = new IslandWindow(built('island.html'), built('preload.cjs'), refreshMenu)
  tray = new Tray(trayIcon())
  tray.setToolTip('Tonton Claude island')
  // Windows shows the menu on a right click; a left click shows or hides the island. Linux only has the menu.
  tray.on('click', () => island?.toggle())
  refreshMenu()
}

function keyring(): Keyring {
  return {
    // Without a keyring, Linux would "encrypt" with a fixed password: no better than plain text, so nothing is kept. The
    // Mac has its own app: there the island only runs for development, and stays out of the Keychain.
    available: () =>
      process.platform !== 'darwin' &&
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: text => safeStorage.encryptString(text),
    decrypt: data => safeStorage.decryptString(data),
  }
}

/** The page shows what sessions say: it never navigates, opens windows or asks for permissions. Links open in the browser. */
function harden() {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', event => event.preventDefault())
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}

function trayIcon() {
  if (process.platform === 'win32') return nativeImage.createFromPath(built('tray.ico'))
  return nativeImage.createFromPath(built('icon.png')).resize({ width: 22, height: 22 })
}

// MARK: The page

function handlePage() {
  handle(CHANNELS.account, () => (account ? pageAccount(account) : null))
  handle(CHANNELS.canRemember, () => store.canRemember)
  handle(CHANNELS.signIn, async (recoveryKey, remember) => {
    const text = typeof recoveryKey === 'string' && recoveryKey.length < MAX_INPUT ? recoveryKey : ''
    const recovered = parseRecoveryKey(text)
    if (!recovered) {
      // Like the web app: the account token looks alike, and only lets machines join.
      return failure(
        parseAccountToken(text)
          ? 'This is the token machines join with, not the recovery key: Settings › Relay › Recovery key.'
          : 'This is not a Tonton Claude recovery key.',
      )
    }
    return signIn(() => verifyAccount(recovered, net.fetch).then(() => recovered), remember === true)
  })
  handle(CHANNELS.createAccount, async (relay, remember) => {
    const base = typeof relay === 'string' && relay.length < MAX_INPUT ? normalizeRelay(relay) : null
    if (!base) return failure('Enter the address of a relay, like https://relay.example.com.')
    return signIn(() => createAccount(base, net.fetch), remember === true)
  })
  handle(CHANNELS.signOut, () => signOut(false))
  listen(CHANNELS.mode, mode => {
    if (mode === 'collapsed' || mode === 'expanded') island?.setMode(mode)
  })
  listen(CHANNELS.menu, () => {
    island?.popup(Menu.buildFromTemplate(template()))
  })
}

/** Only the island's own page may call. */
function fromIsland(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!island && event.sender === island.window.webContents && event.senderFrame === island.window.webContents.mainFrame
}

function handle(channel: string, run: (...args: unknown[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => (fromIsland(event) ? run(...args) : null))
}

function listen(channel: string, run: (...args: unknown[]) => void) {
  ipcMain.on(channel, (event, ...args) => {
    if (fromIsland(event)) run(...args)
  })
}

const pageAccount = (signedIn: RecoveredAccount): IslandAccount => ({ relay: signedIn.relay, key: signedIn.key })

const failure = (error: string): SignInResult => ({ ok: false, error })

async function signIn(get: () => Promise<RecoveredAccount>, remember: boolean): Promise<SignInResult> {
  let next: RecoveredAccount
  try {
    next = await get()
  } catch (error) {
    return failure(error instanceof RelayError ? error.message : 'Something went wrong. Try again.')
  }
  account = next
  remembered = remember && store.save(next)
  // Not remembering this one also forgets the account kept before.
  if (!remembered) store.forget()
  refreshMenu()
  return { ok: true, account: pageAccount(next) }
}

function signOut(fromMenu: boolean) {
  account = null
  remembered = false
  store.forget()
  if (fromMenu) island?.send('signed-out')
  refreshMenu()
}

// MARK: The menu

function template() {
  const login = loginItem()
  return menuTemplate(
    { signedIn: account !== null, visible: island?.visible ?? false, openAtLogin: login.enabled() },
    {
      toggle: () => island?.toggle(),
      copyInstallCommand: platform => void copyInstallCommand(platform),
      copyRecoveryKey: () => {
        if (account) clipboard.writeText(encodeRecoveryKey(account))
      },
      setOpenAtLogin: enabled => {
        login.set(enabled)
        refreshMenu()
      },
      signOut: () => signOut(true),
      quit: () => app.quit(),
    },
  )
}

function refreshMenu() {
  tray?.setContextMenu(Menu.buildFromTemplate(template()))
}

/** The join secret comes from the relay the first time; a key exported by a Mac that showed the token already has it. */
async function copyInstallCommand(platform: 'windows' | 'unix') {
  const current = account
  if (!current) return
  let token = machineToken(current)
  if (!token) {
    try {
      const withSecret = { ...current, joinSecret: await joinSecret(current, net.fetch) }
      if (account === current) {
        account = withSecret
        if (remembered) store.save(withSecret)
      }
      token = machineToken(withSecret)
    } catch (error) {
      const detail = error instanceof RelayError ? error.message : 'Something went wrong. Try again.'
      void dialog.showMessageBox({ type: 'warning', title: 'Tonton Claude', message: 'Could not get the account token', detail })
      return
    }
  }
  if (token) clipboard.writeText(installCommand(platform, token))
}
