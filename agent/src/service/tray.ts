import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import iconFile from '../../tray/windows/tonton.ico' with { type: 'file' }
import trayScript from '../../tray/windows/tray.ps1' with { type: 'text' }
import { loadConfig, paths } from '../config'
import { binaryPath, IS_WINDOWS, trayHelperPath } from '../install/system'
import { log } from '../log'

// The tray icon is a separate program: a PowerShell script on Windows, a small Swift app on macOS. It reads the
// status the service writes and runs `tonton relay` and `tonton tray off`. Linux has no tray: use `tonton relay`.

/** Exit codes of the tray programs. */
const QUIT = 0
const HIDDEN = 3
const MAX_RESTARTS = 5

const windowsFiles = { script: join(paths.home, 'tray.ps1'), icon: join(paths.home, 'tonton.ico') }

export async function installTrayFiles() {
  if (!IS_WINDOWS) return
  writeFileSync(windowsFiles.script, trayScript)
  writeFileSync(windowsFiles.icon, await Bun.file(iconFile).bytes())
}

function trayCommand(): string[] | null {
  const pid = String(process.pid)
  if (IS_WINDOWS && existsSync(windowsFiles.script)) {
    return [
      'powershell.exe',
      ...['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', windowsFiles.script],
      ...['-Tonton', binaryPath(), '-StatusFile', paths.status, '-LogFile', paths.log, '-Icon', windowsFiles.icon, '-ServicePid', pid],
    ]
  }
  if (process.platform === 'darwin' && existsSync(trayHelperPath())) {
    return [trayHelperPath(), '--tonton', binaryPath(), '--status', paths.status, '--log', paths.log, '--service-pid', pid]
  }
  return null
}

/** Quit in the tray stops the service; a crashed tray comes back a few times. */
export function runTray(quit: () => void) {
  let restarts = 0
  const start = () => {
    if (loadConfig()?.tray === false) return
    const command = trayCommand()
    if (!command) return
    const tray = Bun.spawn(command, { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', windowsHide: true })
    void tray.exited.then(async code => {
      if (code === QUIT) quit()
      if (code === QUIT || code === HIDDEN) return
      log('tray exited', { code, stderr: (await new Response(tray.stderr).text()).slice(-500) })
      if (++restarts <= MAX_RESTARTS) setTimeout(start, 10_000)
    })
  }
  start()
}
