// The built island on a real desktop, for CI's Windows and Linux runners: it starts at the top of the screen above other
// windows (a tool window on Windows, out of Alt+Tab), creates an account on the relay of TONTON_SMOKE_RELAY, connects,
// closes to its bar, comes back open from hidden when the app is opened again, and saves a picture of each step in
// TONTON_SMOKE_OUT, with its log and its result (`<name>-result`: ok, or what failed). Copy this folder next to a built
// dist/ and run `electron <that folder>`. On Wayland the island starts itself again through XWayland, so the result
// file, not the exit code, says how it went.
const { app, BrowserWindow, safeStorage, screen } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tonton-smoke-'))
process.env.TONTON_ISLAND_HOME = home
require('./dist/main.cjs')

const out = process.env.TONTON_SMOKE_OUT
const relay = process.env.TONTON_SMOKE_RELAY
const name = process.env.TONTON_SMOKE_NAME || process.platform

function say(line) {
  console.log(line)
  if (!out) return
  fs.mkdirSync(out, { recursive: true })
  fs.appendFileSync(path.join(out, `${name}-smoke.log`), `${line}\n`)
}

async function eventually(read, label, ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function check(ok, label) {
  if (!ok) throw new Error(`failed: ${label}`)
  say(`smoke: ${label}`)
}

async function shot(win, step) {
  if (!out) return
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, `${name}-${step}.png`), (await win.webContents.capturePage()).toPNG())
}

/** The window's extended styles, which Electron does not tell: GetWindowLong(GWL_EXSTYLE), through PowerShell. */
function windowsExStyle(win) {
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0)
  const script = `
    Add-Type -Namespace Smoke -Name User32 -MemberDefinition '[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);'
    [Smoke.User32]::GetWindowLong([IntPtr]${hwnd}, -20)`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8' }).trim())
}

const WS_EX_TOOLWINDOW = 0x80

async function run() {
  const win = await eventually(() => BrowserWindow.getAllWindows().find(w => w.isVisible()), 'the island')
  const js = code => win.webContents.executeJavaScript(code)
  await eventually(() => js(`!!document.querySelector('.sign-in textarea')`), 'the sign-in form')
  const area = screen.getPrimaryDisplay().workArea
  const bounds = win.getBounds()
  check(win.isAlwaysOnTop(), 'always on top')
  if (process.platform === 'win32') {
    const style = windowsExStyle(win)
    check((style & WS_EX_TOOLWINDOW) !== 0, `a tool window, out of Alt+Tab (0x${style.toString(16)})`)
  }
  const centered = bounds.y === area.y && Math.abs(bounds.x + bounds.width / 2 - (area.x + area.width / 2)) <= 1
  check(centered, `at the top of the work area ${JSON.stringify(area)}: ${JSON.stringify(bounds)}`)
  const keyring = safeStorage.isEncryptionAvailable()
  say(`smoke: keyring ${keyring ? 'available' : 'unavailable'}`)
  await shot(win, 'sign-in')
  if (!relay) return
  await js(`
    document.querySelector('.sign-in input:not([type=checkbox])').value = ${JSON.stringify(relay)}
    ;[...document.querySelectorAll('button')].find(b => b.textContent === 'Create account').click()
  `)
  const outcome = await eventually(
    () =>
      js(`document.querySelector('nav')?.textContent.includes('No sessions yet.') ? 'connected'
        : [...document.querySelectorAll('.sign-in .error')].map(e => e.textContent).join(' ').trim()`),
    'the connected list',
  )
  check(outcome === 'connected', `created an account and connected (${outcome})`)
  const kept = path.join(home, 'account')
  if (fs.existsSync(kept)) check(!fs.readFileSync(kept, 'latin1').includes('"token"'), 'the account is kept encrypted')
  await shot(win, 'signed-in')
  await js(`document.querySelector('.bar').click()`)
  await eventually(() => win.getBounds().height < 100, 'the closed island')
  check(true, 'closed to its bar')
  await shot(win, 'closed')
  // Hidden, then the app opened again: the island comes back open, the way back without a tray.
  win.hide()
  // Past the moment the page waits after losing the keyboard, so that blur cannot close what opens next.
  await new Promise(resolve => setTimeout(resolve, 500))
  app.emit('second-instance', {}, [], process.cwd(), {})
  await eventually(() => win.isVisible() && win.getBounds().height > 100, 'the island opened again')
  check(true, 'opening the app again shows it open')
  await shot(win, 'opened-again')
}

function finish(result, code) {
  if (out) fs.writeFileSync(path.join(out, `${name}-result`), result)
  app.exit(code)
}

app.whenReady().then(() =>
  run().then(
    () => {
      say('smoke: ok')
      finish('ok', 0)
    },
    error => {
      say(`smoke: ${error.stack ?? error}`)
      finish(String(error.message ?? error), 1)
    },
  ),
)
